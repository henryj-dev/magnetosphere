// 관리자 MFA 저장소 함수 (A1 설계 2·5절). DB 문장만 있고 라우트·가드·세션 승격은 없다 (다음 단계).
//
// 일회성 판정은 모두 조건 UPDATE 한 문장의 영향 행 수로 한다. 인스턴스 메모리 캐시를 두지 않는다.
//   - 시간 step CAS: last_used_step IS NULL OR last_used_step < :step. 같은 step·과거 step 을 모두 거부한다 (RFC 6238 §5.2).
//     pg·MySQL(READ COMMITTED)은 행 잠금 뒤 조건을 다시 평가해 동시 요청 중 하나만 1행이다. SQLite·D1 은 쓰기가 직렬이다.
//   - 복구 코드·grant·proof 소비: used_at IS NULL 조건 UPDATE.
// 영향 행 수는 MySQL affectedRows(값이 늘 바뀌는 UPDATE 라 정확), 나머지는 RETURNING 행 수다.
// @magnetosphere/runtime/lease 의 updatedRows 와 같은 규칙이다. runtime 이 auth 에 의존하므로(역방향 의존·순환) 가져오지 않고 옮겨 적었다.
//
// 여러 문장을 한 단위로 묶는 일(활성화 + 옛 factor 폐기 + grant 소비 등)은 호출자가 트랜잭션·D1 batch 로 한다.
// 이 함수들은 h.db 로 트랜잭션 핸들을 받아도 그대로 돈다.
//
// 비밀값(seed·OTP·복구 코드·grant 토큰)은 로그·오류 메시지에 넣지 않는다. DB 에는 seed 암호문과 HMAC 만 둔다.
import { and, eq, exists, gt, inArray, isNull, lt, ne, or } from "drizzle-orm";
import type { AuthDatabase } from "../index.ts";
import type { MfaPolicy } from "./policy.ts";
import { base32Decode, base32Encode, generateSecret, type TotpAlgorithm } from "./totp.ts";

export type MfaDatabase = Pick<AuthDatabase, "db" | "provider" | "schema">;

/** @magnetosphere/runtime/crypto 의 Cipher 와 같은 모양. 호출자가 createCipher(APP_ENCRYPTION_KEY) 결과를 넘긴다 */
export interface SecretCipher {
  encrypt(plain: string, aad: string): Promise<string>;
  decrypt(token: string, aad: string): Promise<string>;
}

export type FactorState = "pending" | "active" | "revoked";
export type MfaMethod = "totp" | "recovery";
export type GrantPurpose = "bootstrap" | "promotion" | "reset" | "transition";

export interface MfaFactor {
  id: string;
  userId: string;
  state: FactorState;
  periodS: number;
  digits: number;
  algorithm: TotpAlgorithm;
  lastUsedStep: number | null;
  pendingSessionId: string | null;
  pendingAuthVersion: number | null;
  pendingExpiresAt: Date | null;
  /** 복호화한 seed. 응답·로그에 넣지 않는다 */
  secret: Uint8Array<ArrayBuffer>;
}

const t = (h: MfaDatabase) => h.schema as any;

/** UPDATE·DELETE 하나가 바꾼 행 수 (runtime/lease updatedRows 와 같은 규칙. 시험이 둘을 같은 입력으로 대조한다) */
export async function changedRows(h: MfaDatabase, update: any, key: any): Promise<number> {
  if (h.provider === "mysql") {
    const [r] = await update;
    return r.affectedRows;
  }
  return (await update.returning({ k: key })).length;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** HMAC 서버 키 최소 길이(바이트). HMAC-SHA256 출력 길이와 같다 (RFC 2104 §3: 키는 출력 길이 L 이상을 권한다) */
const HMAC_KEY_MIN_BYTES = 32;

async function hmacHex(key: string, message: string): Promise<string> {
  const raw = new TextEncoder().encode(typeof key === "string" ? key : "");
  if (raw.length < HMAC_KEY_MIN_BYTES) throw new Error(`MFA HMAC 서버 키는 ${HMAC_KEY_MIN_BYTES}바이트 이상이어야 한다`);
  const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message))));
}

/** 32바이트 무작위 base64url (43자). 초대 토큰과 같은 형식 */
function newToken(): string {
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(32))) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const after = (now: Date, seconds: number) => new Date(now.getTime() + seconds * 1000);

// ---------- seed 암호화 ----------

/** seed 암호문의 AAD. factor·회원에 묶어 다른 행으로 옮긴 암호문은 복호화되지 않는다 */
export function factorSecretAad(factorId: string, userId: string): string {
  if (!factorId || !userId || factorId.includes("|") || userId.includes("|")) throw new Error("factor·회원 id 가 AAD 형식에 맞지 않는다");
  return `mfa_factor.secret_enc|v1|${factorId}|${userId}`;
}

export async function sealFactorSecret(cipher: SecretCipher, secret: Uint8Array, factorId: string, userId: string): Promise<string> {
  return cipher.encrypt(base32Encode(secret), factorSecretAad(factorId, userId));
}

/** 다른 factor·회원의 AAD 거나 변조됐으면 예외 (cipher 의 고정 문구, 비밀값 없음) */
export async function openFactorSecret(cipher: SecretCipher, sealed: string, factorId: string, userId: string): Promise<Uint8Array<ArrayBuffer>> {
  return base32Decode(await cipher.decrypt(sealed, factorSecretAad(factorId, userId)));
}

// ---------- factor ----------

/**
 * pending factor 를 만든다. 새 seed 는 정책 길이로 만들고, 등록 당시 정책값(step 폭·자릿수·해시)을 행에 남긴다.
 * 같은 회원의 이전 pending 은 먼저 폐기한다(superseded). 동시에 둘이 들어오면 pending_slot 고유 키로 하나는 예외다.
 * 돌려준 secret 은 otpauth URI 를 한 번 보여 줄 때만 쓴다.
 */
export async function createPendingFactor(
  h: MfaDatabase,
  cipher: SecretCipher,
  policy: Readonly<MfaPolicy>,
  o: { userId: string; sessionId: string; authVersion: number; now?: Date },
): Promise<{ factorId: string; secret: Uint8Array<ArrayBuffer>; expiresAt: Date }> {
  const p = await pendingFactorStatements(h, cipher, policy, o);
  for (const statement of p.build(h.db)) await statement;
  return { factorId: p.factorId, secret: p.secret, expiresAt: p.expiresAt };
}

/**
 * createPendingFactor 의 두 문장(이전 pending 폐기 → 새 pending INSERT). seed·암호문은 여기서 한 번만 만들고,
 * build(db) 가 그 db(트랜잭션 tx 또는 D1 h.db)에 묶인 문장을 만든다. 등록 시작 단위에 넣는다
 */
export async function pendingFactorStatements(
  h: MfaDatabase,
  cipher: SecretCipher,
  policy: Readonly<MfaPolicy>,
  o: { userId: string; sessionId: string; authVersion: number; now?: Date },
): Promise<{ build: (db: any) => any[]; factorId: string; secret: Uint8Array<ArrayBuffer>; expiresAt: Date }> {
  const f = t(h).mfaFactor;
  const now = o.now ?? new Date();
  const factorId = crypto.randomUUID();
  const secret = generateSecret(policy.seedBytes);
  const expiresAt = after(now, policy.pendingTtlS);
  const row = {
    id: factorId,
    userId: o.userId,
    kind: "totp",
    state: "pending",
    secretEnc: await sealFactorSecret(cipher, secret, factorId, o.userId),
    periodS: policy.totpPeriodS,
    digits: policy.totpDigits,
    algorithm: policy.totpAlgorithm,
    pendingSessionId: o.sessionId,
    pendingAuthVersion: o.authVersion,
    pendingExpiresAt: expiresAt,
    pendingSlot: o.userId,
    createdAt: now,
  };
  const build = (db: any) => [
    db.update(f).set({ state: "revoked", pendingSlot: null, revokedAt: now, revokedReason: "superseded" }).where(and(eq(f.userId, o.userId), eq(f.state, "pending"))),
    db.insert(f).values(row),
  ];
  return { build, factorId, secret, expiresAt };
}

/** factor 하나를 읽어 seed 를 복호화한다. 없으면 null. 암호문이 이 factor·회원 것이 아니면 예외 */
export async function loadFactor(h: MfaDatabase, cipher: SecretCipher, o: { factorId: string; userId: string }): Promise<MfaFactor | null> {
  const f = t(h).mfaFactor;
  const [row] = await h.db.select().from(f).where(and(eq(f.id, o.factorId), eq(f.userId, o.userId))).limit(1);
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    state: row.state,
    periodS: Number(row.periodS),
    digits: Number(row.digits),
    algorithm: row.algorithm,
    lastUsedStep: row.lastUsedStep == null ? null : Number(row.lastUsedStep),
    pendingSessionId: row.pendingSessionId ?? null,
    pendingAuthVersion: row.pendingAuthVersion == null ? null : Number(row.pendingAuthVersion),
    pendingExpiresAt: row.pendingExpiresAt ?? null,
    secret: await openFactorSecret(cipher, row.secretEnc, o.factorId, o.userId),
  };
}

/** 회원의 active factor id. 없으면 null */
export async function activeFactorId(h: MfaDatabase, userId: string): Promise<string | null> {
  const f = t(h).mfaFactor;
  const [row] = await h.db.select({ id: f.id }).from(f).where(eq(f.activeSlot, userId)).limit(1);
  return row?.id ?? null;
}

/**
 * pending → active. 등록을 시작한 세션·인증 버전이 같고 마감 전일 때만 1행이다.
 * 등록 확인에 쓴 TOTP step 을 last_used_step 으로 남겨 같은 코드를 로그인·step-up 에 다시 쓰지 못하게 한다.
 * 회원에게 다른 active factor 가 있으면 active_slot 고유 키로 예외다 — 호출자가 같은 트랜잭션에서 먼저 revokeFactor 한다.
 */
export async function activateFactor(h: MfaDatabase, o: { factorId: string; userId: string; sessionId: string; authVersion: number; step: number; now?: Date }): Promise<boolean> {
  if (!Number.isSafeInteger(o.step) || o.step < 0) return false;
  return (await changedRows(h, activateUpdate(h, h.db, o), t(h).mfaFactor.id)) === 1;
}

/** pending → active 문장 (실행하지 않는다). 조건은 activateFactor 와 같다 */
export function activateUpdate(h: MfaDatabase, db: any, o: { factorId: string; userId: string; sessionId: string; authVersion: number; step: number; now?: Date }) {
  const f = t(h).mfaFactor;
  const now = o.now ?? new Date();
  return db
    .update(f)
    .set({ state: "active", activeSlot: o.userId, pendingSlot: null, pendingSessionId: null, pendingAuthVersion: null, pendingExpiresAt: null, activatedAt: now, lastUsedStep: o.step })
    .where(and(eq(f.id, o.factorId), eq(f.userId, o.userId), eq(f.state, "pending"), eq(f.pendingSessionId, o.sessionId), eq(f.pendingAuthVersion, o.authVersion), gt(f.pendingExpiresAt, now)));
}

/**
 * 회원의 폐기된 factor 에 남은(미사용) 복구 코드를 지운다. 소비 조건의 active factor EXISTS 가 1차 방어이고 이것은 남은 값 정리다.
 * 사용한 코드 행은 감사용으로 남긴다.
 */
async function dropRevokedRecoveryCodes(h: MfaDatabase, userId: string): Promise<void> {
  await dropRevokedCodesDelete(h, h.db, userId);
}

/** 폐기된 factor 의 미사용 복구 코드 DELETE (실행하지 않는다) */
export function dropRevokedCodesDelete(h: MfaDatabase, db: any, userId: string) {
  const f = t(h).mfaFactor;
  const r = t(h).mfaRecoveryCode;
  const revoked = db.select({ id: f.id }).from(f).where(and(eq(f.userId, userId), eq(f.state, "revoked")));
  return db.delete(r).where(and(eq(r.userId, userId), isNull(r.usedAt), inArray(r.factorId, revoked)));
}

/**
 * 회원의 pending·active factor 를 모두 폐기하는 UPDATE (실행하지 않는다). 강등·초기화·탈퇴에서 쓴다.
 * 뒤에 dropRevokedCodesDelete 를 같은 단위에 둔다. exceptFactorId 는 교체(등록 확인)에서 새 pending 을 남길 때 쓴다.
 */
export function revokeAllFactorsUpdate(h: MfaDatabase, db: any, o: { userId: string; reason: string; now: Date; exceptFactorId?: string; states?: readonly FactorState[] }) {
  const f = t(h).mfaFactor;
  return db
    .update(f)
    .set({ state: "revoked", activeSlot: null, pendingSlot: null, revokedAt: o.now, revokedReason: o.reason })
    .where(and(eq(f.userId, o.userId), inArray(f.state, [...(o.states ?? ["pending", "active"])]), o.exceptFactorId ? ne(f.id, o.exceptFactorId) : undefined));
}

/** pending·active factor 를 폐기하고 남은 복구 코드를 지운다. 이미 폐기됐거나 없으면 false */
export async function revokeFactor(h: MfaDatabase, o: { factorId: string; userId: string; reason: string; now?: Date }): Promise<boolean> {
  const f = t(h).mfaFactor;
  const update = h.db
    .update(f)
    .set({ state: "revoked", activeSlot: null, pendingSlot: null, revokedAt: o.now ?? new Date(), revokedReason: o.reason })
    .where(and(eq(f.id, o.factorId), eq(f.userId, o.userId), inArray(f.state, ["pending", "active"])));
  const done = (await changedRows(h, update, f.id)) === 1;
  if (done) await dropRevokedRecoveryCodes(h, o.userId);
  return done;
}

/** 회원의 active factor 를 모두 폐기하고(0 또는 1개) 폐기한 수를 돌려준다. 교체·초기화·강등에서 쓴다 */
export async function revokeActiveFactors(h: MfaDatabase, o: { userId: string; reason: string; exceptFactorId?: string; now?: Date }): Promise<number> {
  const f = t(h).mfaFactor;
  const update = h.db
    .update(f)
    .set({ state: "revoked", activeSlot: null, revokedAt: o.now ?? new Date(), revokedReason: o.reason })
    .where(and(eq(f.userId, o.userId), eq(f.state, "active"), o.exceptFactorId ? ne(f.id, o.exceptFactorId) : undefined));
  const n = await changedRows(h, update, f.id);
  if (n > 0) await dropRevokedRecoveryCodes(h, o.userId);
  return n;
}

/** factor 가 이 회원의 active factor 다 (UPDATE 조건에 붙이는 EXISTS) */
function activeFactorExists(h: MfaDatabase, factorId: string, userId: string, db: any = h.db) {
  const f = t(h).mfaFactor;
  return exists(db.select({ one: f.id }).from(f).where(and(eq(f.id, factorId), eq(f.userId, userId), eq(f.state, "active"))));
}

/**
 * 시간 step CAS. active factor 의 last_used_step 이 비었거나 step 보다 작을 때만 step 으로 바꾸고 true.
 * 같은 step 두 번·과거 step 은 false. 동시 요청 중 하나만 true 다.
 */
export async function consumeTotpStep(h: MfaDatabase, o: { factorId: string; userId: string; step: number }): Promise<boolean> {
  if (!Number.isSafeInteger(o.step) || o.step < 0) return false;
  return (await changedRows(h, totpStepUpdate(h, h.db, o), t(h).mfaFactor.id)) === 1;
}

/** 시간 step CAS 문장 (실행하지 않는다). 호출자가 step 을 0 이상의 안전 정수로 확인한 뒤 쓴다 */
export function totpStepUpdate(h: MfaDatabase, db: any, o: { factorId: string; userId: string; step: number }) {
  const f = t(h).mfaFactor;
  return db
    .update(f)
    .set({ lastUsedStep: o.step })
    .where(and(eq(f.id, o.factorId), eq(f.userId, o.userId), eq(f.state, "active"), or(isNull(f.lastUsedStep), lt(f.lastUsedStep, o.step))));
}

// ---------- 복구 코드 ----------

/** HMAC-SHA256(서버 키, factorId|code) hex. 코드 형식(대소문자·구분자 정규화)은 정책 결정 뒤 호출자가 정한다 */
export function recoveryCodeHash(key: string, factorId: string, code: string): Promise<string> {
  return hmacHex(key, `${factorId}|${code}`);
}

/** 복구 코드 해시를 넣는다. 원문은 저장하지 않는다 */
export async function insertRecoveryCodes(h: MfaDatabase, key: string, o: { factorId: string; userId: string; codes: readonly string[] }): Promise<void> {
  if (o.codes.length === 0) return;
  const r = t(h).mfaRecoveryCode;
  const rows = [];
  for (const code of o.codes) rows.push({ id: crypto.randomUUID(), factorId: o.factorId, userId: o.userId, codeHash: await recoveryCodeHash(key, o.factorId, code) });
  await h.db.insert(r).values(rows);
}

/** 복구 코드를 한 번만 소비한다. factor 가 아직 active 이고 맞는 미사용 코드가 있으면 true. 동시 요청 중 하나만 true 다 */
export async function consumeRecoveryCode(h: MfaDatabase, key: string, o: { factorId: string; userId: string; code: string; sessionId: string; now?: Date }): Promise<boolean> {
  const codeHash = await recoveryCodeHash(key, o.factorId, o.code);
  return (await changedRows(h, recoveryConsumeUpdate(h, h.db, { ...o, codeHash }), t(h).mfaRecoveryCode.id)) === 1;
}

/** 복구 코드 소비 UPDATE (실행하지 않는다). codeHash 는 recoveryCodeHash 로 미리 만든다 */
export function recoveryConsumeUpdate(h: MfaDatabase, db: any, o: { factorId: string; userId: string; codeHash: string; sessionId: string; now?: Date }) {
  const r = t(h).mfaRecoveryCode;
  return db
    .update(r)
    .set({ usedAt: o.now ?? new Date(), usedSessionId: o.sessionId })
    .where(and(eq(r.factorId, o.factorId), eq(r.userId, o.userId), eq(r.codeHash, o.codeHash), isNull(r.usedAt), activeFactorExists(h, o.factorId, o.userId, db)));
}

/** 복구 코드 INSERT. 해시를 미리 만들고 build(db) 가 문장을 만든다. 코드가 없으면 null */
export async function recoveryInsert(h: MfaDatabase, key: string, o: { factorId: string; userId: string; codes: readonly string[] }): Promise<{ build: (db: any) => any } | null> {
  if (o.codes.length === 0) return null;
  const rows: any[] = [];
  for (const code of o.codes) rows.push({ id: crypto.randomUUID(), factorId: o.factorId, userId: o.userId, codeHash: await recoveryCodeHash(key, o.factorId, code) });
  return { build: (db: any) => db.insert(t(h).mfaRecoveryCode).values(rows) };
}

/** factor 의 미사용 복구 코드를 모두 지우는 DELETE (재발급 때 기존 코드 폐기) */
export function recoveryDropUnused(h: MfaDatabase, db: any, o: { factorId: string; userId: string }) {
  const r = t(h).mfaRecoveryCode;
  return db.delete(r).where(and(eq(r.factorId, o.factorId), eq(r.userId, o.userId), isNull(r.usedAt)));
}

/** 남은(미사용) 복구 코드 수 */
export async function remainingRecoveryCodes(h: MfaDatabase, o: { factorId: string; userId: string }): Promise<number> {
  const r = t(h).mfaRecoveryCode;
  const rows = await h.db.select({ id: r.id }).from(r).where(and(eq(r.factorId, o.factorId), eq(r.userId, o.userId), isNull(r.usedAt)));
  return rows.length;
}

// ---------- 등록 자격 (grant) ----------

export function grantTokenHash(key: string, token: string): Promise<string> {
  return hmacHex(key, `mfa_enrollment_grant|v1|${token}`);
}

/** grant 를 발급한다. 수명은 정책 grantTtlS. 토큰 원문은 이 반환값에만 있고 DB 에는 HMAC 만 둔다 */
export async function issueEnrollmentGrant(
  h: MfaDatabase,
  key: string,
  policy: Readonly<MfaPolicy>,
  o: { userId: string; purpose: GrantPurpose; issuedBy: string | null; authVersion: number; now?: Date },
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const g = await grantInsert(h, key, policy, o);
  await g.build(h.db);
  return { id: g.id, token: g.token, expiresAt: g.expiresAt };
}

/** grant INSERT (build(db) 가 문장을 만든다)와 토큰 원문. 승격·초기화·설치의 원자 단위에 넣는다 */
export async function grantInsert(
  h: MfaDatabase,
  key: string,
  policy: Readonly<MfaPolicy>,
  o: { userId: string; purpose: GrantPurpose; issuedBy: string | null; authVersion: number; now?: Date },
): Promise<{ build: (db: any) => any; id: string; token: string; expiresAt: Date }> {
  const g = t(h).mfaEnrollmentGrant;
  const now = o.now ?? new Date();
  const id = crypto.randomUUID();
  const token = newToken();
  const expiresAt = after(now, policy.grantTtlS);
  const row = { id, userId: o.userId, tokenHash: await grantTokenHash(key, token), purpose: o.purpose, issuedBy: o.issuedBy, authVersion: o.authVersion, expiresAt };
  return { build: (db: any) => db.insert(g).values(row), id, token, expiresAt };
}

/** grant 를 한 번만 소비한다. 회원·인증 버전·목적이 맞고 만료·취소·사용 전일 때만 true */
export async function consumeEnrollmentGrant(
  h: MfaDatabase,
  key: string,
  o: { token: string; userId: string; authVersion: number; purposes: readonly GrantPurpose[]; now?: Date },
): Promise<boolean> {
  if (!validToken(o.token) || o.purposes.length === 0) return false;
  const tokenHash = await grantTokenHash(key, o.token);
  return (await changedRows(h, grantConsumeUpdate(h, h.db, { ...o, tokenHash }), t(h).mfaEnrollmentGrant.id)) === 1;
}

/** 받은 토큰 문자열이 grant·proof 토큰으로 볼 만한가 (빈 값·과도한 길이 거부) */
export function validToken(token: unknown): token is string {
  return typeof token === "string" && token !== "" && token.length <= 256;
}

/** grant 조건 (소비·유효 확인 공용) */
function grantLive(h: MfaDatabase, o: { tokenHash: string; userId: string; authVersion: number; purposes: readonly GrantPurpose[]; now: Date }) {
  const g = t(h).mfaEnrollmentGrant;
  return and(eq(g.tokenHash, o.tokenHash), eq(g.userId, o.userId), eq(g.authVersion, o.authVersion), inArray(g.purpose, [...o.purposes]), isNull(g.usedAt), isNull(g.revokedAt), gt(g.expiresAt, o.now));
}

/** grant 소비 UPDATE (실행하지 않는다). tokenHash 는 grantTokenHash 로 미리 만든다 */
export function grantConsumeUpdate(h: MfaDatabase, db: any, o: { tokenHash: string; userId: string; authVersion: number; purposes: readonly GrantPurpose[]; now?: Date }) {
  const now = o.now ?? new Date();
  return db.update(t(h).mfaEnrollmentGrant).set({ usedAt: now }).where(grantLive(h, { ...o, now }));
}

/** grant 가 지금 쓸 수 있는가 (소비하지 않는다). 등록 시작은 확인만 하고 소비는 등록 확인이 한다 */
export async function enrollmentGrantUsable(h: MfaDatabase, key: string, o: { token: unknown; userId: string; authVersion: number; purposes: readonly GrantPurpose[]; now?: Date }): Promise<boolean> {
  if (!validToken(o.token) || o.purposes.length === 0) return false;
  const g = t(h).mfaEnrollmentGrant;
  const rows = await h.db.select({ id: g.id }).from(g).where(grantLive(h, { ...o, tokenHash: await grantTokenHash(key, o.token), now: o.now ?? new Date() })).limit(1);
  return rows.length === 1;
}

/** 회원의 아직 쓰지 않은 grant 를 모두 취소하는 UPDATE (실행하지 않는다). 새 grant 를 내기 전에 둔다 */
export function grantRevokeOpen(h: MfaDatabase, db: any, o: { userId: string; now: Date }) {
  const g = t(h).mfaEnrollmentGrant;
  return db.update(g).set({ revokedAt: o.now }).where(and(eq(g.userId, o.userId), isNull(g.usedAt), isNull(g.revokedAt)));
}

// ---------- step-up proof ----------

export function proofTokenHash(key: string, token: string): Promise<string> {
  return hmacHex(key, `mfa_proof|v1|${token}`);
}

/**
 * 작업에 묶인 proof 를 만든다. 수명은 정책 recencyTtlS(민감 작업 최근성).
 * 토큰 원문은 이 반환값에만 있고 DB 에는 HMAC 만 둔다. id 는 감사·정리용 내부 값이며 증명으로 쓰지 않는다.
 */
export async function issueProof(
  h: MfaDatabase,
  key: string,
  policy: Readonly<MfaPolicy>,
  o: { sessionId: string; userId: string; authVersion: number; factorId: string; purpose: string; target: string; now?: Date },
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const now = o.now ?? new Date();
  const p = await proofInsert(h, key, { ...o, expiresAt: after(now, policy.recencyTtlS) });
  await p.build(h.db);
  return { id: p.id, token: p.token, expiresAt: p.expiresAt };
}

/** proof INSERT 문장(실행하지 않는다)과 토큰 원문. 만료 시각은 호출자가 정한다 (step-up: 지금 + 최근성, 로그인 MFA 인정: 그 시각 + 최근성) */
export async function proofInsert(
  h: MfaDatabase,
  key: string,
  o: { sessionId: string; userId: string; authVersion: number; factorId: string; purpose: string; target: string; expiresAt: Date },
): Promise<{ build: (db: any) => any; id: string; token: string; expiresAt: Date }> {
  const id = crypto.randomUUID();
  const token = newToken();
  const row = { id, tokenHash: await proofTokenHash(key, token), sessionId: o.sessionId, userId: o.userId, authVersion: o.authVersion, factorId: o.factorId, purpose: o.purpose, target: o.target, expiresAt: o.expiresAt };
  return { build: (db: any) => db.insert(t(h).mfaProof).values(row), id, token, expiresAt: o.expiresAt };
}

/**
 * proof 를 한 번만 소비한다. 세션·회원·인증 버전·factor·목적·대상이 모두 같고, 그 factor 가 아직 active 이며, 만료·사용 전일 때만 true.
 * 작업의 트랜잭션 안에서 부른다.
 */
export async function consumeProof(
  h: MfaDatabase,
  key: string,
  o: { token: string; sessionId: string; userId: string; authVersion: number; factorId: string; purpose: string; target: string; now?: Date },
): Promise<boolean> {
  if (!validToken(o.token)) return false;
  const tokenHash = await proofTokenHash(key, o.token);
  return (await changedRows(h, proofConsumeUpdate(h, h.db, { ...o, tokenHash }), t(h).mfaProof.id)) === 1;
}

/** proof 소비 UPDATE (실행하지 않는다). 민감 작업이 자기 트랜잭션·batch 안에 넣는다. tokenHash 는 proofTokenHash 로 미리 만든다 */
export function proofConsumeUpdate(
  h: MfaDatabase,
  db: any,
  o: { tokenHash: string; sessionId: string; userId: string; authVersion: number; factorId: string; purpose: string; target: string; now?: Date },
) {
  const p = t(h).mfaProof;
  const now = o.now ?? new Date();
  return db
    .update(p)
    .set({ usedAt: now })
    .where(
      and(
        eq(p.tokenHash, o.tokenHash),
        eq(p.sessionId, o.sessionId),
        eq(p.userId, o.userId),
        eq(p.authVersion, o.authVersion),
        eq(p.factorId, o.factorId),
        eq(p.purpose, o.purpose),
        eq(p.target, o.target),
        isNull(p.usedAt),
        gt(p.expiresAt, now),
        activeFactorExists(h, o.factorId, o.userId, db),
      ),
    );
}
