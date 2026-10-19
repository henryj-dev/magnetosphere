// TC-A1.T1.k~q 관리자 MFA 저장소 (네 DB: SQLite·MySQL·MariaDB·Postgres). 일회성 판정은 조건 UPDATE 영향 행 수다.
//   pnpm -C packages/auth test -t "TC-A1.T1"
// D1 은 이 파일에서 돌지 않는다 (packages/auth 시험 DB 에 D1 이 없다). D1 의 CAS 문장 행 수는 packages/db migrate-0007 시험이 본다.
// 정책 수치는 시험 전용 값이다. 제품 기본값이 아니다.
import { eq, inArray } from "drizzle-orm";
import { parseSessionInput, parseSessionOutput } from "better-auth/db";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createCipher } from "../../runtime/src/crypto.ts";
import { updatedRows } from "../../runtime/src/lease.ts";
import { authOptions, createAuth } from "../src/index.ts";
import { loadMfaPolicy, type MfaPolicy } from "../src/mfa/policy.ts";
import { base32Encode } from "../src/mfa/totp.ts";
import {
  activateFactor,
  changedRows,
  activeFactorId,
  consumeEnrollmentGrant,
  consumeProof,
  consumeRecoveryCode,
  consumeTotpStep,
  createPendingFactor,
  insertRecoveryCodes,
  issueEnrollmentGrant,
  issueProof,
  loadFactor,
  remainingRecoveryCodes,
  revokeActiveFactors,
  revokeFactor,
  type SecretCipher,
} from "../src/mfa/store.ts";
import { ALL_DBS, OPEN, type TestDb } from "./db.ts";
import { makeAuthConfig } from "./helpers.ts";
import { apiReply, mail, OPS, PASSWORD } from "./signup-policy/rig.ts";

const TEST_POLICY_ENV = {
  MFA_TOTP_PERIOD_S: "30",
  MFA_TOTP_DIGITS: "6",
  MFA_TOTP_ALGORITHM: "SHA-1",
  MFA_TOTP_PAST_WINDOW: "1",
  MFA_TOTP_FUTURE_WINDOW: "1",
  MFA_SEED_BYTES: "20",
  MFA_RECENCY_TTL_S: "300",
  MFA_CHALLENGE_TTL_S: "600",
  MFA_PENDING_TTL_S: "900",
  MFA_GRANT_TTL_S: "86400",
  MFA_ADMIN_SESSION_ABSOLUTE_TTL_S: "3600",
  MFA_FAILURE_LIMIT: "5",
  MFA_ACCOUNT_FAILURE_LIMIT: "20",
  MFA_FAILURE_WINDOW_S: "900",
  MFA_FAILURE_DELAY_BASE_S: "1",
  MFA_FAILURE_DELAY_MAX_S: "900",
  MFA_RECOVERY_CODE_COUNT: "10",
};
const TEST_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => 200 - i)));
const HMAC_KEY = "test-mfa-hmac-key-0123456789abcdef";
const OTHER_HMAC_KEY = "other-mfa-hmac-key-0123456789abcdef";
const N = 10;

describe.each(ALL_DBS)("%s", (kind) => {
  let h: TestDb;
  let cipher: SecretCipher;
  let policy: Readonly<MfaPolicy>;
  let seq = 0;

  beforeAll(async () => {
    h = await OPEN[kind]();
    cipher = await createCipher(TEST_KEY);
    const p = await loadMfaPolicy(TEST_POLICY_ENV);
    if (p.state !== "ready") throw new Error("시험 정책이 ready 가 아니다");
    policy = p.policy;
  });
  afterAll(async () => {
    await h?.close();
  });

  async function newUser(): Promise<string> {
    const id = crypto.randomUUID();
    const s = h.schema as any;
    await h.db.insert(s.user).values({ id, name: "관리자", email: `mfa-${++seq}-${id.slice(0, 8)}@example.com`, emailVerified: true, role: "admin" });
    return id;
  }

  /** proof 의 session_id 참조(FK)를 채우는 세션 행 */
  async function newSession(userId: string): Promise<string> {
    const id = crypto.randomUUID();
    await h.db.insert((h.schema as any).session).values({ id, token: `mfa-test-${id}`, userId, expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date() });
    return id;
  }

  /** pending 을 만들고 활성화한 factor */
  async function activeFactor(userId: string, step = 100): Promise<string> {
    const sessionId = crypto.randomUUID();
    const { factorId } = await createPendingFactor(h, cipher, policy, { userId, sessionId, authVersion: 0 });
    expect(await activateFactor(h, { factorId, userId, sessionId, authVersion: 0, step })).toBe(true);
    return factorId;
  }

  test("TC-A1.T1.k 같은 step 은 두 번 받지 않는다", async () => {
    const userId = await newUser();
    const factorId = await activeFactor(userId, 100);
    // 활성화에 쓴 step 은 다시 받지 않는다
    expect(await consumeTotpStep(h, { factorId, userId, step: 100 })).toBe(false);
    expect(await consumeTotpStep(h, { factorId, userId, step: 101 })).toBe(true);
    expect(await consumeTotpStep(h, { factorId, userId, step: 101 })).toBe(false);
    expect(await consumeTotpStep(h, { factorId, userId, step: 102 })).toBe(true);
    // 다른 회원·없는 factor 는 0행
    const other = await newUser();
    expect(await consumeTotpStep(h, { factorId, userId: other, step: 103 })).toBe(false);
    expect(await consumeTotpStep(h, { factorId: crypto.randomUUID(), userId, step: 103 })).toBe(false);
    expect((await loadFactor(h, cipher, { factorId, userId }))?.lastUsedStep).toBe(102);
  });

  test("TC-A1.T1.l 과거 step 은 거부하고 폐기한 factor 는 받지 않는다", async () => {
    const userId = await newUser();
    const factorId = await activeFactor(userId, 500);
    expect(await consumeTotpStep(h, { factorId, userId, step: 499 })).toBe(false);
    expect(await consumeTotpStep(h, { factorId, userId, step: 0 })).toBe(false);
    expect(await consumeTotpStep(h, { factorId, userId, step: 502 })).toBe(true);
    expect(await consumeTotpStep(h, { factorId, userId, step: 501 })).toBe(false);
    expect(await consumeTotpStep(h, { factorId, userId, step: -1 })).toBe(false);
    expect(await consumeTotpStep(h, { factorId, userId, step: 1.5 })).toBe(false);
    expect(await revokeFactor(h, { factorId, userId, reason: "reset" })).toBe(true);
    expect(await consumeTotpStep(h, { factorId, userId, step: 600 })).toBe(false);
    expect(await revokeFactor(h, { factorId, userId, reason: "reset" })).toBe(false);
  });

  test(`TC-A1.T1.m 같은 step 동시 ${N}건 CAS 는 정확히 1건만 성공한다`, async () => {
    const userId = await newUser();
    const factorId = await activeFactor(userId, 10);
    for (const step of [11, 12, 13]) {
      const results = await Promise.all(Array.from({ length: N }, () => consumeTotpStep(h, { factorId, userId, step })));
      expect(results.filter(Boolean)).toHaveLength(1);
    }
    // 서로 다른 step 이 섞여도 마지막 값은 받은 step 중 최대이고 그 이하는 다시 받지 않는다
    const mixed = await Promise.all(Array.from({ length: N }, (_, i) => consumeTotpStep(h, { factorId, userId, step: 20 + (i % 3) })));
    expect(mixed.filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect(mixed.filter(Boolean).length).toBeLessThanOrEqual(3);
    expect((await loadFactor(h, cipher, { factorId, userId }))?.lastUsedStep).toBe(22);
    expect(await consumeTotpStep(h, { factorId, userId, step: 22 })).toBe(false);
  });

  test(`TC-A1.T1.n 복구 코드 동시 ${N}건 소비는 1건만 성공하고 해시만 저장한다`, async () => {
    const userId = await newUser();
    const factorId = await activeFactor(userId);
    const codes = ["rc-alpha-1111", "rc-bravo-2222", "rc-charlie-3333"];
    await insertRecoveryCodes(h, HMAC_KEY, { factorId, userId, codes });
    expect(await remainingRecoveryCodes(h, { factorId, userId })).toBe(3);
    const r = (h.schema as any).mfaRecoveryCode;
    const stored = await h.db.select().from(r).where(eq(r.factorId, factorId));
    expect(stored).toHaveLength(3);
    for (const row of stored) {
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
      for (const c of codes) expect(JSON.stringify(row)).not.toContain(c);
    }
    const sessionId = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: N }, () => consumeRecoveryCode(h, HMAC_KEY, { factorId, userId, code: codes[0], sessionId })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await consumeRecoveryCode(h, HMAC_KEY, { factorId, userId, code: codes[0], sessionId })).toBe(false);
    expect(await remainingRecoveryCodes(h, { factorId, userId })).toBe(2);
    // 다른 회원·다른 factor·없는 코드·다른 서버 키는 0행
    const other = await newUser();
    expect(await consumeRecoveryCode(h, HMAC_KEY, { factorId, userId: other, code: codes[1], sessionId })).toBe(false);
    expect(await consumeRecoveryCode(h, HMAC_KEY, { factorId: crypto.randomUUID(), userId, code: codes[1], sessionId })).toBe(false);
    expect(await consumeRecoveryCode(h, HMAC_KEY, { factorId, userId, code: "rc-unknown-0000", sessionId })).toBe(false);
    expect(await consumeRecoveryCode(h, OTHER_HMAC_KEY, { factorId, userId, code: codes[1], sessionId })).toBe(false);
    // 대소문자까지 같아야 한다 (code_hash exact)
    expect(await consumeRecoveryCode(h, HMAC_KEY, { factorId, userId, code: codes[1].toUpperCase(), sessionId })).toBe(false);
    expect(await consumeRecoveryCode(h, HMAC_KEY, { factorId, userId, code: codes[1], sessionId })).toBe(true);
    const [used] = await h.db.select().from(r).where(eq(r.usedSessionId, sessionId)).limit(1);
    expect(used.usedAt).toBeInstanceOf(Date);
    // 같은 factor 에 같은 코드를 두 번 넣지 못한다 (factor_id, code_hash 고유)
    await expect(insertRecoveryCodes(h, HMAC_KEY, { factorId, userId, codes: [codes[2]] })).rejects.toThrow();
    // 32바이트보다 짧은 서버 키는 거부한다 (키 원문은 메시지에 없다)
    await expect(consumeRecoveryCode(h, "short-key", { factorId, userId, code: codes[2], sessionId })).rejects.toThrow(/32바이트 이상/);
  });

  test("TC-A1.T1.r factor 를 폐기하면 남은 복구 코드는 쓸 수 없고 지워진다", async () => {
    const userId = await newUser();
    const factorId = await activeFactor(userId);
    const r = (h.schema as any).mfaRecoveryCode;
    const sessionId = crypto.randomUUID();
    await insertRecoveryCodes(h, HMAC_KEY, { factorId, userId, codes: ["rc-used-1", "rc-left-2", "rc-left-3"] });
    expect(await consumeRecoveryCode(h, HMAC_KEY, { factorId, userId, code: "rc-used-1", sessionId })).toBe(true);
    // 행이 남아 있어도 factor 가 active 가 아니면 소비하지 않는다 (EXISTS 조건)
    const f = (h.schema as any).mfaFactor;
    await h.db.update(f).set({ state: "revoked", activeSlot: null }).where(eq(f.id, factorId));
    expect(await consumeRecoveryCode(h, HMAC_KEY, { factorId, userId, code: "rc-left-2", sessionId })).toBe(false);
    await h.db.update(f).set({ state: "active", activeSlot: userId }).where(eq(f.id, factorId));
    expect(await revokeFactor(h, { factorId, userId, reason: "reset" })).toBe(true);
    expect(await consumeRecoveryCode(h, HMAC_KEY, { factorId, userId, code: "rc-left-3", sessionId })).toBe(false);
    // 미사용 코드는 지우고 사용한 코드 행은 남긴다
    const left = await h.db.select().from(r).where(eq(r.factorId, factorId));
    expect(left).toHaveLength(1);
    expect(left[0].usedSessionId).toBe(sessionId);
    // revokeActiveFactors 도 같다
    const second = await activeFactor(userId);
    await insertRecoveryCodes(h, HMAC_KEY, { factorId: second, userId, codes: ["rc-next-1"] });
    expect(await revokeActiveFactors(h, { userId, reason: "demoted" })).toBe(1);
    expect(await h.db.select().from(r).where(eq(r.factorId, second))).toEqual([]);
  });

  test("TC-A1.T1.o grant 는 한 번만 쓰고 회원·인증 버전·목적·만료가 맞아야 한다", async () => {
    const userId = await newUser();
    const now = new Date();
    const grant = await issueEnrollmentGrant(h, HMAC_KEY, policy, { userId, purpose: "bootstrap", issuedBy: null, authVersion: 0, now });
    expect(grant.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(grant.expiresAt.getTime() - now.getTime()).toBe(policy.grantTtlS * 1000);
    const g = (h.schema as any).mfaEnrollmentGrant;
    const [row] = await h.db.select().from(g).where(eq(g.id, grant.id));
    expect(JSON.stringify(row)).not.toContain(grant.token);
    const ok = { token: grant.token, userId, authVersion: 0, purposes: ["bootstrap"] as const };
    const other = await newUser();
    expect(await consumeEnrollmentGrant(h, HMAC_KEY, { ...ok, userId: other })).toBe(false);
    expect(await consumeEnrollmentGrant(h, HMAC_KEY, { ...ok, authVersion: 1 })).toBe(false);
    expect(await consumeEnrollmentGrant(h, HMAC_KEY, { ...ok, purposes: ["promotion", "reset"] })).toBe(false);
    expect(await consumeEnrollmentGrant(h, HMAC_KEY, { ...ok, purposes: [] })).toBe(false);
    expect(await consumeEnrollmentGrant(h, HMAC_KEY, { ...ok, token: grant.token.toUpperCase() })).toBe(false);
    expect(await consumeEnrollmentGrant(h, HMAC_KEY, { ...ok, now: new Date(grant.expiresAt.getTime() + 1) })).toBe(false);
    const results = await Promise.all(Array.from({ length: N }, () => consumeEnrollmentGrant(h, HMAC_KEY, ok)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await consumeEnrollmentGrant(h, HMAC_KEY, ok)).toBe(false);
    // 취소한 grant 는 쓸 수 없다
    const revoked = await issueEnrollmentGrant(h, HMAC_KEY, policy, { userId, purpose: "reset", issuedBy: other, authVersion: 0 });
    await h.db.update(g).set({ revokedAt: new Date() }).where(eq(g.id, revoked.id));
    expect(await consumeEnrollmentGrant(h, HMAC_KEY, { token: revoked.token, userId, authVersion: 0, purposes: ["reset"] })).toBe(false);
  });

  test("TC-A1.T1.p proof 는 한 번만 쓰고 세션·factor·목적·대상·인증 버전·만료가 맞아야 하며 원문을 저장하지 않는다", async () => {
    const userId = await newUser();
    const factorId = await activeFactor(userId);
    const sessionId = await newSession(userId);
    const now = new Date();
    const proof = await issueProof(h, HMAC_KEY, policy, { sessionId, userId, authVersion: 0, factorId, purpose: "mfa.reset", target: "member-1", now });
    expect(proof.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(proof.expiresAt.getTime() - now.getTime()).toBe(policy.recencyTtlS * 1000);
    const p = (h.schema as any).mfaProof;
    const [row] = await h.db.select().from(p).where(eq(p.id, proof.id));
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(proof.token);
    const ok = { token: proof.token, sessionId, userId, authVersion: 0, factorId, purpose: "mfa.reset", target: "member-1" };
    // 내부 id 는 증명이 아니다
    expect(await consumeProof(h, HMAC_KEY, { ...ok, token: proof.id })).toBe(false);
    expect(await consumeProof(h, OTHER_HMAC_KEY, ok)).toBe(false);
    expect(await consumeProof(h, HMAC_KEY, { ...ok, token: proof.token.toUpperCase() })).toBe(false);
    expect(await consumeProof(h, HMAC_KEY, { ...ok, sessionId: crypto.randomUUID() })).toBe(false);
    expect(await consumeProof(h, HMAC_KEY, { ...ok, factorId: crypto.randomUUID() })).toBe(false);
    expect(await consumeProof(h, HMAC_KEY, { ...ok, purpose: "role.change" })).toBe(false);
    expect(await consumeProof(h, HMAC_KEY, { ...ok, target: "member-2" })).toBe(false);
    expect(await consumeProof(h, HMAC_KEY, { ...ok, target: "MEMBER-1" })).toBe(false);
    expect(await consumeProof(h, HMAC_KEY, { ...ok, authVersion: 1 })).toBe(false);
    expect(await consumeProof(h, HMAC_KEY, { ...ok, userId: await newUser() })).toBe(false);
    expect(await consumeProof(h, HMAC_KEY, { ...ok, now: new Date(proof.expiresAt.getTime() + 1) })).toBe(false);
    const results = await Promise.all(Array.from({ length: N }, () => consumeProof(h, HMAC_KEY, ok)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await consumeProof(h, HMAC_KEY, ok)).toBe(false);
    // 만든 factor 가 폐기되면 아직 안 쓴 proof 도 쓸 수 없다
    const later = await issueProof(h, HMAC_KEY, policy, { sessionId, userId, authVersion: 0, factorId, purpose: "mfa.reset", target: "member-1" });
    expect(await revokeFactor(h, { factorId, userId, reason: "reset" })).toBe(true);
    expect(await consumeProof(h, HMAC_KEY, { ...ok, token: later.token })).toBe(false);
  });

  test("TC-A1.T1.q factor 는 회원당 active·pending 하나이고 seed 는 그 행의 AAD 로만 열린다", async () => {
    const userId = await newUser();
    const sessionId = crypto.randomUUID();
    const first = await createPendingFactor(h, cipher, policy, { userId, sessionId, authVersion: 0 });
    expect(first.secret).toHaveLength(policy.seedBytes);
    // 새 pending 은 이전 pending 을 폐기한다
    const second = await createPendingFactor(h, cipher, policy, { userId, sessionId, authVersion: 0 });
    expect((await loadFactor(h, cipher, { factorId: first.factorId, userId }))?.state).toBe("revoked");
    expect(await activateFactor(h, { factorId: first.factorId, userId, sessionId, authVersion: 0, step: 1 })).toBe(false);
    // 다른 세션·인증 버전·마감 뒤에는 활성화하지 않는다
    expect(await activateFactor(h, { factorId: second.factorId, userId, sessionId: crypto.randomUUID(), authVersion: 0, step: 1 })).toBe(false);
    expect(await activateFactor(h, { factorId: second.factorId, userId, sessionId, authVersion: 1, step: 1 })).toBe(false);
    expect(await activateFactor(h, { factorId: second.factorId, userId, sessionId, authVersion: 0, step: 1, now: new Date(second.expiresAt.getTime() + 1) })).toBe(false);
    for (const step of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) expect(await activateFactor(h, { factorId: second.factorId, userId, sessionId, authVersion: 0, step })).toBe(false);
    expect(await activateFactor(h, { factorId: second.factorId, userId, sessionId, authVersion: 0, step: 1 })).toBe(true);
    expect(await activateFactor(h, { factorId: second.factorId, userId, sessionId, authVersion: 0, step: 2 })).toBe(false);
    expect(await activeFactorId(h, userId)).toBe(second.factorId);
    const loaded = await loadFactor(h, cipher, { factorId: second.factorId, userId });
    expect(loaded).toMatchObject({ state: "active", periodS: 30, digits: 6, algorithm: "SHA-1", lastUsedStep: 1, pendingSessionId: null });
    expect(loaded?.secret).toEqual(second.secret);

    // 두 번째 active 는 active_slot 고유 키로 막힌다. 옛 factor 를 먼저 폐기하면 된다
    const third = await createPendingFactor(h, cipher, policy, { userId, sessionId, authVersion: 0 });
    await expect(activateFactor(h, { factorId: third.factorId, userId, sessionId, authVersion: 0, step: 5 })).rejects.toThrow();
    expect(await revokeActiveFactors(h, { userId, reason: "replaced", exceptFactorId: third.factorId })).toBe(1);
    expect(await activateFactor(h, { factorId: third.factorId, userId, sessionId, authVersion: 0, step: 5 })).toBe(true);
    expect(await activeFactorId(h, userId)).toBe(third.factorId);
    expect(await consumeTotpStep(h, { factorId: second.factorId, userId, step: 9 })).toBe(false);

    // 다른 행의 암호문을 옮겨 붙이면 열리지 않는다 (AAD = factor·회원)
    const f = (h.schema as any).mfaFactor;
    const [src] = await h.db.select({ secretEnc: f.secretEnc }).from(f).where(eq(f.id, second.factorId));
    // 저장 형식은 암호문뿐이다. seed 를 평문으로 담는 base32(암호화 입력)·hex·base64 어느 것도 행에 없다
    const [whole] = await h.db.select().from(f).where(eq(f.id, second.factorId));
    const b32 = base32Encode(second.secret);
    expect(src.secretEnc).toMatch(/^v1:/);
    for (const plain of [b32, b32.toLowerCase(), Buffer.from(second.secret).toString("hex"), Buffer.from(second.secret).toString("base64")]) expect(JSON.stringify(whole)).not.toContain(plain);
    await h.db.update(f).set({ secretEnc: src.secretEnc }).where(eq(f.id, third.factorId));
    await expect(loadFactor(h, cipher, { factorId: third.factorId, userId })).rejects.toThrow("복호화 실패");
    expect(await loadFactor(h, cipher, { factorId: third.factorId, userId: await newUser() })).toBeNull();
  });

  test("TC-A1.T1.s 옮겨 적은 changedRows 는 runtime updatedRows 와 같은 행 수를 낸다", async () => {
    const userId = await newUser();
    const f = (h.schema as any).mfaFactor;
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) ids.push((await createPendingFactor(h, cipher, policy, { userId: await newUser(), sessionId: crypto.randomUUID(), authVersion: 0 })).factorId);
    const cases: [string, () => any][] = [
      ["0행", () => h.db.update(f).set({ revokedReason: "x" }).where(eq(f.userId, userId))],
      ["1행", () => h.db.update(f).set({ lastUsedStep: Math.floor(Math.random() * 1e9) }).where(eq(f.id, ids[0]))],
      ["2행", () => h.db.update(f).set({ revokedReason: crypto.randomUUID().slice(0, 8) }).where(inArray(f.id, ids))],
    ];
    for (const [name, make] of cases) {
      const ours = await changedRows(h, make(), f.id);
      const theirs = await updatedRows(h as any, make(), f.id);
      expect(ours, name).toBe(theirs);
      expect(ours, name).toBe(Number(name[0]));
    }
  });

  test("TC-A1.T1.t 세션 mfa 칼럼은 Better Auth 입력으로 쓸 수 없고 응답에 없다", async () => {
    const { outbox: _outbox, pending: _pending, mailErrors: _mailErrors, ...cfg } = makeAuthConfig(h);
    const auth = createAuth(cfg);
    const api = auth.api as any;
    const email = mail("mfa-session");
    const id = await OPS.addPasswordUser(h.db, h.schema, email, PASSWORD, "admin", "active");
    const signed = await api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
    const headers = new Headers({ cookie: signed.headers.getSetCookie().map((v: string) => v.split(";")[0]).join("; ") });
    const s = (h.schema as any).session;
    const mfa = { mfaVerifiedAt: new Date(), mfaFactorId: crypto.randomUUID(), mfaMethod: "totp", mfaPolicyVersion: "f".repeat(64) };
    await h.db.update(s).set(mfa).where(eq(s.userId, id));
    for (const body of [JSON.stringify(signed.response), JSON.stringify(await api.getSession({ headers }))]) {
      expect(body).not.toMatch(/mfa(VerifiedAt|FactorId|Method|PolicyVersion)|mfa_/);
      expect(body).not.toContain(mfa.mfaFactorId);
    }
    // update-session 으로 MFA 충족을 꾸밀 수 없다. 관리자 부분 세션은 부분 세션 제한(hooks.before)이 먼저 403 MFA_REQUIRED 로 막고,
    // 제한 밖의 회원 세션도 input:false 칼럼이라 400 이다 (칼럼 입력 거부 자체를 본다)
    const memberEmail = mail("mfa-session-member");
    await OPS.addPasswordUser(h.db, h.schema, memberEmail, PASSWORD, "member", "active");
    const memberSigned = await api.signInEmail({ body: { email: memberEmail, password: PASSWORD }, returnHeaders: true });
    const memberHeaders = new Headers({ cookie: memberSigned.headers.getSetCookie().map((v: string) => v.split(";")[0]).join("; ") });
    for (const field of Object.keys(mfa)) {
      const value = field === "mfaVerifiedAt" ? new Date().toISOString() : "x";
      const admin = await apiReply(api.updateSession({ headers, body: { [field]: value } }));
      expect([admin.status, admin.code], field).toEqual([403, "mfa_required"]);
      const member = await apiReply(api.updateSession({ headers: memberHeaders, body: { [field]: value } }));
      expect(member.status, field).toBe(400);
    }
    const [row] = await h.db.select().from(s).where(eq(s.userId, id));
    expect({ mfaFactorId: row.mfaFactorId, mfaMethod: row.mfaMethod, mfaPolicyVersion: row.mfaPolicyVersion }).toEqual({ mfaFactorId: mfa.mfaFactorId, mfaMethod: "totp", mfaPolicyVersion: mfa.mfaPolicyVersion });
    // 실제 구성(authOptions)의 파서도 같다: 기본값 없는 input:false 라 생성·수정 입력 모두 거부하고, 출력에서는 뺀다
    const options = authOptions(cfg);
    const session = { id: "s", token: "t", userId: id, expiresAt: new Date(), createdAt: new Date(), updatedAt: new Date() };
    expect(Object.keys(parseSessionInput(options, session, "create")).filter((k) => k.startsWith("mfa"))).toEqual([]);
    for (const field of Object.keys(mfa)) {
      for (const mode of ["create", "update"] as const) expect(() => parseSessionInput(options, { ...session, [field]: (mfa as any)[field] }, mode), `${field} ${mode}`).toThrow(/not allowed to be set/);
    }
    expect(parseSessionOutput(options, { ...session, ...mfa } as any)).toEqual(session);
  });
});
