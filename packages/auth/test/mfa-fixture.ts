// 관리자 MFA 공용 시험 fixture (A1). 봉인된 단계의 관리자 시험이 비밀번호만으로 관리 API 를 부르지 않게,
// "active factor + MFA 충족 세션"을 만드는 도우미를 한곳에 둔다. 시험 전용 정책(mfa-policy.ts)과 고정 시험 seed 를 쓴다.
//   - DB 도우미(addActiveFactor·markSessionMfa·resetFactorStep·issueTestGrant·issueTestProof)는 (db, schema, ...) 꼴이라
//     Node 시험과 D1 시험 Worker(/__test/db 의 OPS)가 같이 쓴다.
//   - HTTP 도우미(challengeHttp·enrollHttp·stepUpHttp)는 실제 /api/auth/admin-mfa/* 를 부른다.
// 시험 seed·코드는 시험 전용 값이다. 제품 코드·로그에는 들어가지 않는다.
import { eq } from "drizzle-orm";
import { createCipher } from "../../runtime/src/crypto.ts";
import { loadMfaPolicy } from "../src/mfa/policy.ts";
import { mfaHmacKey, MFA_ISSUER, type MfaRuntime } from "../src/mfa/session.ts";
import { grantInsert, proofInsert, sealFactorSecret, type GrantPurpose } from "../src/mfa/store.ts";
import { base32Decode, timeStep, totpAt } from "../src/mfa/totp.ts";
import { TEST_MFA_POLICY_ENV } from "./mfa-policy.ts";

export { TEST_MFA_POLICY_ENV };

/** 시험 factor 의 고정 seed (base32, 20바이트) */
export const TEST_MFA_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

/** 시험 정책 상태 (ready) */
export async function testMfaPolicy() {
  const p = await loadMfaPolicy(TEST_MFA_POLICY_ENV);
  if (p.state !== "ready") throw new Error("시험 MFA 정책이 ready 가 아니다");
  return p;
}

/** 시험 MFA 런타임. secret 은 BETTER_AUTH_SECRET, encryptionKey 는 APP_ENCRYPTION_KEY 와 같은 값 */
export async function testMfaRuntime(o: { secret: string; encryptionKey: string; audit?: MfaRuntime["audit"]; ipBucket?: MfaRuntime["ipBucket"] }): Promise<MfaRuntime> {
  return { policy: await testMfaPolicy(), cipher: await createCipher(o.encryptionKey), key: await mfaHmacKey(o.secret), issuer: MFA_ISSUER, audit: o.audit, ipBucket: o.ipBucket };
}

/** seed 의 지금 TOTP 코드 (시험 정책: 30초·6자리·SHA-1). offsetSteps 로 앞뒤 step 을 고른다 */
export async function totpCode(seed: string = TEST_MFA_SEED, o: { nowMs?: number; offsetSteps?: number } = {}): Promise<string> {
  return totpAt(base32Decode(seed), timeStep(o.nowMs ?? Date.now(), 30) + (o.offsetSteps ?? 0), 6, "SHA-1");
}

type AnyDb = any;
type Schema = any;

/** 회원에게 active factor 를 바로 넣는다 (seed 는 encryptionKey 로 암호화). 이미 있으면 그것을 돌려준다 */
export async function addActiveFactor(db: AnyDb, s: Schema, userId: string, encryptionKey: string, seed: string = TEST_MFA_SEED): Promise<string> {
  const [found] = await db.select({ id: s.mfaFactor.id }).from(s.mfaFactor).where(eq(s.mfaFactor.activeSlot, userId)).limit(1);
  if (found) return found.id;
  const id = crypto.randomUUID();
  const cipher = await createCipher(encryptionKey);
  const now = new Date();
  await db.insert(s.mfaFactor).values({
    id, userId, kind: "totp", state: "active", secretEnc: await sealFactorSecret(cipher, base32Decode(seed), id, userId),
    periodS: 30, digits: 6, algorithm: "SHA-1", activeSlot: userId, createdAt: now, activatedAt: now,
  });
  return id;
}

/** 시험이 같은 step 안에서 다시 challenge 할 수 있게 재사용 기록을 비운다 (시험 전용 조작) */
export async function resetFactorStep(db: AnyDb, s: Schema, userId: string): Promise<void> {
  await db.update(s.mfaFactor).set({ lastUsedStep: null }).where(eq(s.mfaFactor.activeSlot, userId));
}

/** 세션 행을 MFA 충족으로 표시한다 (가짜 인증 Rig 용). policyVersion 은 testMfaPolicy().version */
export async function markSessionMfa(db: AnyDb, s: Schema, o: { sessionId: string; factorId: string; policyVersion: string; method?: "totp" | "recovery"; at?: Date }): Promise<void> {
  await db.update(s.session).set({ mfaVerifiedAt: o.at ?? new Date(), mfaFactorId: o.factorId, mfaMethod: o.method ?? "totp", mfaPolicyVersion: o.policyVersion }).where(eq(s.session.id, o.sessionId));
}

/** grant 를 DB 에 바로 만든다. secret 은 BETTER_AUTH_SECRET (서버와 같은 HMAC 키를 갈라 낸다) */
export async function issueTestGrant(db: AnyDb, s: Schema, o: { userId: string; secret: string; purpose?: GrantPurpose; authVersion?: number }): Promise<string> {
  const p = await testMfaPolicy();
  const [u] = await db.select({ v: s.user.authVersion }).from(s.user).where(eq(s.user.id, o.userId)).limit(1);
  const g = await grantInsert({ db, provider: "sqlite", schema: s }, await mfaHmacKey(o.secret), p.policy, { userId: o.userId, purpose: o.purpose ?? "transition", issuedBy: null, authVersion: o.authVersion ?? Number(u?.v ?? 0) });
  await g.build(db);
  return g.token;
}

/** proof 를 DB 에 바로 만든다 (가짜 인증 Rig 용). 세션·factor·인증 버전은 그 관리자 것이어야 한다 */
export async function issueTestProof(db: AnyDb, s: Schema, o: { secret: string; sessionId: string; userId: string; factorId: string; authVersion?: number; purpose: string; target: string; ttlMs?: number }): Promise<string> {
  const [u] = await db.select({ v: s.user.authVersion }).from(s.user).where(eq(s.user.id, o.userId)).limit(1);
  const p = await proofInsert({ db, provider: "sqlite", schema: s }, await mfaHmacKey(o.secret), {
    sessionId: o.sessionId, userId: o.userId, authVersion: o.authVersion ?? Number(u?.v ?? 0), factorId: o.factorId, purpose: o.purpose, target: o.target, expiresAt: new Date(Date.now() + (o.ttlMs ?? 600_000)),
  });
  await p.build(db);
  return p.token;
}

// ---------- HTTP ----------

export interface MfaHttpRes {
  status: number;
  json: any;
}
/** Rig 의 call 을 이 꼴로 맞춘다: (method, path, { body, cookie, headers }) */
export type MfaCall = (method: string, path: string, o: { body?: unknown; cookie?: string; headers?: Record<string, string> }) => Promise<MfaHttpRes>;

/**
 * 부분 세션을 MFA 충족으로 올린다 (POST admin-mfa/challenge). 실패하면 예외.
 * 같은 관리자가 같은 30초 안에 두 번째로 부르면 지금 step 은 이미 썼으므로 다음 step(미래 window 1) 코드로 한 번 더 시도한다
 */
export async function challengeHttp(call: MfaCall, cookie: string, seed: string = TEST_MFA_SEED): Promise<void> {
  let r: MfaHttpRes | undefined;
  for (const offsetSteps of [0, 1]) {
    r = await call("POST", "/api/auth/admin-mfa/challenge", { body: { code: await totpCode(seed, { offsetSteps }) }, cookie });
    if (r.status === 200) return;
    if (r.status !== 401) break;
  }
  throw new Error(`MFA challenge 실패 ${r?.status} ${JSON.stringify(r?.json?.code ?? null)}`);
}

/** grant 로 처음 등록한다 (start → confirm). 등록한 seed 와 복구 코드를 돌려준다. 성공하면 이 세션이 MFA 충족이 된다 */
export async function enrollHttp(call: MfaCall, cookie: string, grant: string): Promise<{ seed: string; factorId: string; recoveryCodes: string[] }> {
  const start = await call("POST", "/api/auth/admin-mfa/enroll/start", { body: { grant }, cookie });
  if (start.status !== 200) throw new Error(`MFA 등록 시작 실패 ${start.status} ${JSON.stringify(start.json?.code ?? null)}`);
  const seed = start.json.secret as string;
  const confirm = await call("POST", "/api/auth/admin-mfa/enroll/confirm", { body: { factorId: start.json.factorId, code: await totpCode(seed), grant }, cookie });
  if (confirm.status !== 200) throw new Error(`MFA 등록 확인 실패 ${confirm.status} ${JSON.stringify(confirm.json?.code ?? null)}`);
  return { seed, factorId: start.json.factorId, recoveryCodes: confirm.json.recoveryCodes };
}

/** 로그인 MFA 최근성으로 작업 proof 를 받는다 (코드 없이). 실패하면 예외 */
export async function stepUpHttp(call: MfaCall, cookie: string, purpose: string, target: string): Promise<string> {
  const r = await call("POST", "/api/auth/admin-mfa/step-up", { body: { purpose, target }, cookie });
  if (r.status !== 200) throw new Error(`MFA step-up 실패 ${r.status} ${JSON.stringify(r.json?.code ?? null)}`);
  return r.json.proof as string;
}
