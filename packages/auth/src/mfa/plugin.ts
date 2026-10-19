// 관리자 MFA 앱 플러그인 /api/auth/admin-mfa/* 와 부분 세션 제한 (A1 설계 4·6절).
//   GET  /admin-mfa/status                      { state, method, recoveryRemaining, policy }
//   POST /admin-mfa/enroll/start { grant? }     { factorId, otpauthUri, secret, period, digits, algorithm, expiresAt }
//        최초 등록은 grant 토큰(유효 확인만, 소비는 confirm). 재등록은 MFA 충족 세션 + X-MFA-Proof(mfa.reenroll, 이 단위에서 소비).
//        비밀번호만으로는 등록할 수 없다. pending factor 는 세션·인증 버전·마감에 묶인다.
//   POST /admin-mfa/enroll/confirm { factorId, code, grant? }  { recoveryCodes }
//        새 seed 의 코드를 확인한 뒤 한 단위: 옛 factor 폐기 → 활성화 → grant 소비 → 복구 코드 → 회원 버전 +1 → 다른 세션 삭제
//        → 현재 세션을 새 버전·MFA 충족으로 다시 묶기 → 감사 (Node 트랜잭션, D1 batch + changes() guard, unit.ts)
//   POST /admin-mfa/challenge { code | recoveryCode }          { state: "satisfied", method }   시간 step CAS(또는 복구 코드 소비)와 세션 승격이 한 단위
//   POST /admin-mfa/step-up { code? | recoveryCode?, purpose, target }   { proof, expiresAt }
//        코드를 내면 그 코드로 확인하고 지금 + 최근성까지 사는 proof. 코드 없이 부르면 세션의 MFA 시각이 최근성 안일 때만
//        그 시각 + 최근성까지 사는 proof 를 준다 (로그인 때 통과한 MFA 도 최근성 동안 step-up 으로 인정)
//   POST /admin-mfa/recovery-codes/regenerate                  { recoveryCodes }   X-MFA-Proof(mfa.recovery_regenerate). 기존 미사용 코드는 모두 지운다
// 공통: HTTP 요청은 정확한 Origin, POST 본문은 application/json 만, 응답은 Cache-Control: no-store (createAuth 가 오류 응답에도 단다).
// 오류: 잘못된 코드·재사용·factor 없음은 모두 401 INVALID_MFA_CODE. 403 MFA_REQUIRED·MFA_ENROLLMENT_REQUIRED·MFA_GRANT_REQUIRED·MFA_PROOF_REQUIRED,
//       409 MFA_ENROLLMENT_EXPIRED·MFA_STALE, 429 MFA_TOO_MANY_ATTEMPTS(Retry-After), 503 MFA_POLICY_UNAVAILABLE·MFA_UNAVAILABLE.
// 실패 지연(계정+IP, DB rate_limit 칸): failureLimit 번까지는 바로, 그 뒤는 첫 지연·2배·…·상한. 마지막 시도 failureWindowS 뒤 비운다. 성공하면 비운다.
// 부분 세션 제한(gate, hooks.before): 관리자 역할 세션이 MFA 미충족이면 /get-session·/sign-out·/admin-mfa/* 만 받는다. 그 밖은 403 MFA_REQUIRED.
//   부분 세션은 만든 뒤 challengeTtlS 가 지나면 지운다 (get-session 은 null, 그 밖은 세션 없는 요청으로 이어 간다).
// 비밀값(seed·코드·grant·proof)은 응답의 해당 필드에만 있고 로그·오류·감사에는 넣지 않는다.
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { and, eq, gte, lt, lte, or, sql } from "drizzle-orm";
import type { AuthDatabase } from "../index.ts";
import { CLIENT_IP_HEADER } from "../rate-limit.ts";
import type { MfaPolicy } from "./policy.ts";
import {
  activateUpdate,
  changedRows,
  dropRevokedCodesDelete,
  enrollmentGrantUsable,
  grantConsumeUpdate,
  grantTokenHash,
  loadFactor,
  pendingFactorStatements,
  proofConsumeUpdate,
  proofInsert,
  proofTokenHash,
  recoveryCodeHash,
  recoveryConsumeUpdate,
  recoveryDropUnused,
  recoveryInsert,
  remainingRecoveryCodes,
  revokeAllFactorsUpdate,
  totpStepUpdate,
  validToken,
  type GrantPurpose,
} from "./store.ts";
import { adminVersionBump, judgeMfa, otherSessionsDelete, readAuthContext, sessionMfaUpdate, type AuthContextRow, type MfaAuditEntry, type MfaRuntime } from "./session.ts";
import { base32Encode, otpauthUri, verifyTotp } from "./totp.ts";
import { runUnit, UnitAborted, type UnitStep } from "./unit.ts";

type Context = any;
type LiveContext = AuthContextRow & { session: NonNullable<AuthContextRow["session"]> };

/** step-up proof 목적. 민감 작업이 이 이름으로 소비한다 */
export const MFA_PROOF_PURPOSES = ["role.change", "admin.invite", "mfa.reset", "admin.delete", "mfa.reenroll", "mfa.recovery_regenerate"] as const;
export type MfaProofPurpose = (typeof MFA_PROOF_PURPOSES)[number];
/** 민감 작업 요청이 proof 토큰을 싣는 머리글 */
export const MFA_PROOF_HEADER = "x-mfa-proof";
/** 부분 세션(관리자 MFA 미충족)이 쓸 수 있는 Better Auth 경로. /admin-mfa/* 는 따로 본다 */
export const PARTIAL_SESSION_PATHS: readonly string[] = ["/get-session", "/sign-out"];
export const ADMIN_MFA_PREFIX = "/admin-mfa/";
export const ENROLL_GRANT_PURPOSES: readonly GrantPurpose[] = ["bootstrap", "promotion", "reset", "transition"];
const ATTEMPT_KEY = "admin-mfa-attempt";
const TARGET_MAX = 255;

type Status = "UNAUTHORIZED" | "FORBIDDEN" | "CONFLICT" | "BAD_REQUEST" | "SERVICE_UNAVAILABLE" | "UNSUPPORTED_MEDIA_TYPE";
const err = (status: Status, code: string, message: string) => new APIError(status, { code, message });
const invalidCode = () => err("UNAUTHORIZED", "INVALID_MFA_CODE", "인증 코드를 확인해 주세요");
const policyUnavailable = () => err("SERVICE_UNAVAILABLE", "MFA_POLICY_UNAVAILABLE", "mfa_policy_unavailable");
const mfaRequired = () => err("FORBIDDEN", "MFA_REQUIRED", "관리자 MFA 를 먼저 마쳐 주세요");
const proofRequired = () => err("FORBIDDEN", "MFA_PROOF_REQUIRED", "최근 MFA 확인이 필요해요");
const stale = () => err("CONFLICT", "MFA_STALE", "상태가 바뀌었어요. 다시 시도해 주세요");
const badInput = () => err("BAD_REQUEST", "VALIDATION_ERROR", "VALIDATION_ERROR");
const unauthorized = () => err("UNAUTHORIZED", "UNAUTHORIZED", "로그인이 필요해요");

/** 복구 코드: 10바이트 무작위 base32 16자를 4자씩 끊어 보여 준다 (80비트). 입력은 대문자로 바꾸고 하이픈·공백을 지운 뒤 비교한다 */
export function newRecoveryCode(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(10))).match(/.{4}/g)!.join("-");
}
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}

/** 실패 지연(ms). count 는 이번 시도 전까지 성공 없이 이어진 시도 수 */
export function attemptDelayMs(policy: Readonly<MfaPolicy>, count: number): number {
  if (count < policy.failureLimit) return 0;
  const exp = count - policy.failureLimit;
  const delayS = exp >= 40 ? policy.failureDelayMaxS : Math.min(policy.failureDelayBaseS * 2 ** exp, policy.failureDelayMaxS);
  return delayS * 1000;
}

export interface AdminMfaConfig {
  database: AuthDatabase;
  baseURL: string;
  mfa?: MfaRuntime;
}

export function adminMfa(cfg: AdminMfaConfig) {
  const h = cfg.database;
  const mfa = cfg.mfa;
  const s = h.schema as any;

  const readyPolicy = (): { policy: Readonly<MfaPolicy>; version: string; rt: MfaRuntime } => {
    if (!mfa || mfa.policy.state !== "ready") throw policyUnavailable();
    return { policy: mfa.policy.policy, version: mfa.policy.version, rt: mfa };
  };
  const policyState = () => mfa?.policy ?? ({ state: "unavailable", reason: "missing", field: "MFA_TOTP_PERIOD_S" } as const);

  const checkRequest = (ctx: Context, post: boolean) => {
    ctx.setHeader("Cache-Control", "no-store");
    if (!ctx.request) return;
    const headers: Headers = ctx.headers ?? ctx.request.headers;
    if (post && headers.get("origin") !== new URL(cfg.baseURL).origin) throw err("FORBIDDEN", "FORBIDDEN_ORIGIN", "허용되지 않은 출처예요");
    if (post && !/^application\/json\b/i.test(headers.get("content-type") ?? "")) throw err("UNSUPPORTED_MEDIA_TYPE", "UNSUPPORTED_MEDIA_TYPE", "JSON 본문만 받아요");
  };

  const ipOf = (ctx: Context): string | null => (ctx.headers ?? ctx.request?.headers)?.get?.(CLIENT_IP_HEADER) ?? null;

  /** 현재 세션의 활성 관리자 문맥. 세션 없음·무효 401, 관리자 아님 403 */
  const adminContext = async (ctx: Context): Promise<LiveContext> => {
    const session = ctx.context.session ?? (await getSessionFromCtx(ctx));
    if (!session?.session) throw unauthorized();
    const c = await readAuthContext(h, { userId: session.user.id, sessionId: session.session.id });
    if (!c || !c.session || c.session.expiresAt.getTime() <= Date.now() || c.session.authVersion !== c.user.authVersion) throw unauthorized();
    if (c.user.role !== "admin" || c.user.status !== "active" || !c.user.emailVerified || c.user.deletedAt) throw err("FORBIDDEN", "FORBIDDEN", "forbidden");
    return c as LiveContext;
  };

  // ---------- 실패 지연 (계정+IP) ----------

  const attemptKey = (ctx: Context, userId: string) => {
    const ip = ipOf(ctx);
    return `${ATTEMPT_KEY}|${userId}|${mfa?.ipBucket ? mfa.ipBucket(ip) : (ip ?? "unknown")}`;
  };

  /** 시도 한 번을 차지한다. 지연 중이면 남은 초. 조건부 문장 하나라 동시 시도가 함께 지연을 넘지 못한다 */
  const claimAttempt = async (policy: Readonly<MfaPolicy>, key: string): Promise<number | null> => {
    const t = s.rateLimit;
    const now = Date.now();
    await h.db.delete(t).where(and(eq(t.key, key), lt(t.lastRequest, now - policy.failureWindowS * 1000)));
    const row = { id: crypto.randomUUID(), key, count: 1, lastRequest: now };
    const inserted = h.provider === "mysql" ? (await h.db.insert(t).ignore().values(row))[0].affectedRows === 1 : (await h.db.insert(t).values(row).onConflictDoNothing().returning()).length === 1;
    if (inserted) return null;
    // count 가 제한 아래이거나, 마지막 시도 뒤 그 count 의 지연이 지났을 때만 한 칸 올린다.
    // 경계 시각은 JS 에서 계산해 칼럼 형식으로 비교한다 (SQL 안의 매개변수 산술은 Postgres 가 형식을 정하지 못한다)
    const allowed: any[] = [lt(t.count, policy.failureLimit)];
    let c = policy.failureLimit;
    for (; attemptDelayMs(policy, c) < policy.failureDelayMaxS * 1000; c++) allowed.push(and(eq(t.count, c), lte(t.lastRequest, now - attemptDelayMs(policy, c))));
    allowed.push(and(gte(t.count, c), lte(t.lastRequest, now - policy.failureDelayMaxS * 1000)));
    const cond = and(eq(t.key, key), or(...allowed));
    if ((await changedRows(h, h.db.update(t).set({ count: sql`${t.count} + 1`, lastRequest: now }).where(cond), t.id)) === 1) return null;
    const [cur] = await h.db.select({ count: t.count, lastRequest: t.lastRequest }).from(t).where(eq(t.key, key)).limit(1);
    if (!cur) return 1;
    return Math.max(1, Math.ceil((Number(cur.lastRequest) + attemptDelayMs(policy, Number(cur.count)) - now) / 1000));
  };
  const clearAttempts = async (key: string) => {
    await h.db.delete(s.rateLimit).where(eq(s.rateLimit.key, key));
  };
  const gateAttempt = async (ctx: Context, policy: Readonly<MfaPolicy>, key: string) => {
    const wait = await claimAttempt(policy, key);
    if (wait !== null) throw new APIError("TOO_MANY_REQUESTS", { code: "MFA_TOO_MANY_ATTEMPTS", message: "잠시 뒤 다시 시도해 주세요" }, { "Retry-After": String(wait), "Cache-Control": "no-store" });
  };

  // ---------- 공용 ----------

  const auditStep = (e: Omit<MfaAuditEntry, "now">, now: Date): UnitStep[] => (mfa?.audit ? [{ build: (db) => mfa.audit!(db, { ...e, now }) }] : []);

  const run = async (steps: UnitStep[], lockUserId: string, onAbort: () => APIError) => {
    try {
      await runUnit(h, steps, { lockUserId });
    } catch (e) {
      if (e instanceof UnitAborted) throw onAbort();
      // pending_slot·active_slot 고유 키 충돌(동시 등록)도 상태가 바뀐 것으로 본다. 원래 오류(쿼리·값)는 넘기지 않는다
      const text = [(e as any)?.message, (e as any)?.cause?.message, (e as any)?.code, (e as any)?.cause?.code].map(String).join(" ");
      if (/unique|duplicate|ER_DUP_ENTRY|23505|SQLITE_CONSTRAINT/i.test(text)) throw stale();
      throw err("SERVICE_UNAVAILABLE", "MFA_UNAVAILABLE", "mfa_unavailable");
    }
  };

  /** 코드(TOTP) 또는 복구 코드 하나. 둘 다 있거나 형식이 틀리면 400. required 가 아니면 둘 다 없을 때 null */
  const codeInput = (body: any, required: boolean): { code: string } | { recoveryCode: string } | null => {
    const code = body?.code;
    const recovery = body?.recoveryCode;
    if (code !== undefined && recovery !== undefined) throw badInput();
    if (typeof code === "string" && code.length > 0 && code.length <= 16) return { code };
    if (typeof recovery === "string" && recovery.length > 0 && recovery.length <= 64) return { recoveryCode: normalizeRecoveryCode(recovery) };
    if (code !== undefined || recovery !== undefined || required) throw badInput();
    return null;
  };

  /** active factor 로 코드를 판정해 CAS·소비 단계를 만든다. 틀리면 401 */
  const verifyStep = async (c: LiveContext, input: { code: string } | { recoveryCode: string }, policy: Readonly<MfaPolicy>, now: Date) => {
    const rt = mfa!;
    const factorId = c.activeFactorId;
    if (!factorId) throw invalidCode();
    const userId = c.user.id;
    if ("code" in input) {
      const factor = await loadFactor(h, rt.cipher, { factorId, userId });
      if (!factor || factor.state !== "active") throw invalidCode();
      const v = await verifyTotp({ secret: factor.secret, code: input.code, nowMs: now.getTime(), periodS: factor.periodS, digits: factor.digits, algorithm: factor.algorithm, pastWindow: policy.totpPastWindow, futureWindow: policy.totpFutureWindow });
      if (!v.ok) throw invalidCode();
      return { factorId, method: "totp" as const, steps: [{ build: (db: any) => totpStepUpdate(h, db, { factorId, userId, step: v.step }), one: (x: any) => x.mfaFactor.id }] as UnitStep[] };
    }
    const codeHash = await recoveryCodeHash(rt.key, factorId, input.recoveryCode);
    const steps: UnitStep[] = [{ build: (db: any) => recoveryConsumeUpdate(h, db, { factorId, userId, codeHash, sessionId: c.session.id, now }), one: (x: any) => x.mfaRecoveryCode.id }];
    return { factorId, method: "recovery" as const, steps };
  };

  const proofFrom = (ctx: Context): string | null => {
    const v = (ctx.headers ?? ctx.request?.headers)?.get?.(MFA_PROOF_HEADER) ?? undefined;
    return validToken(v) ? v : null;
  };

  /** 새 복구 코드와 INSERT 단계 */
  const freshRecovery = async (policy: Readonly<MfaPolicy>, factorId: string, userId: string) => {
    const codes = Array.from({ length: policy.recoveryCodeCount }, newRecoveryCode);
    const insert = await recoveryInsert(h, mfa!.key, { factorId, userId, codes: codes.map(normalizeRecoveryCode) });
    return { codes, steps: insert ? [{ build: insert.build }] : [] };
  };

  // ---------- 엔드포인트 ----------

  const status = createAuthEndpoint("/admin-mfa/status", { method: "GET" }, async (ctx) => {
    checkRequest(ctx, false);
    const session = ctx.context.session ?? (await getSessionFromCtx(ctx));
    if (!session?.session) throw unauthorized();
    const c = await readAuthContext(h, { userId: session.user.id, sessionId: session.session.id });
    if (!c || c.user.role !== "admin") return ctx.json({ state: "not_required", method: null, recoveryRemaining: null, policy: null });
    const ps = policyState();
    const j = judgeMfa(c, ps, new Date());
    const policy = ps.state === "ready" ? { period: ps.policy.totpPeriodS, digits: ps.policy.totpDigits, algorithm: ps.policy.totpAlgorithm } : null;
    const recoveryRemaining = c.activeFactorId ? await remainingRecoveryCodes(h, { factorId: c.activeFactorId, userId: c.user.id }) : null;
    return ctx.json({ state: j.state, method: j.state === "satisfied" ? j.method : null, recoveryRemaining, policy });
  });

  const enrollStart = createAuthEndpoint("/admin-mfa/enroll/start", { method: "POST" }, async (ctx) => {
    checkRequest(ctx, true);
    const { policy, rt } = readyPolicy();
    const c = await adminContext(ctx);
    const now = new Date();
    const j = judgeMfa(c, rt.policy, now);
    const steps: UnitStep[] = [];
    if (j.state === "satisfied") {
      // 재등록: 지금 factor 로 얻은 mfa.reenroll proof 를 등록 시작 단위 안에서 소비한다
      const token = proofFrom(ctx);
      if (!token) throw proofRequired();
      const tokenHash = await proofTokenHash(rt.key, token);
      steps.push({ build: (db) => proofConsumeUpdate(h, db, { tokenHash, sessionId: c.session.id, userId: c.user.id, authVersion: c.user.authVersion, factorId: j.factorId, purpose: "mfa.reenroll", target: c.user.id, now }), one: (x) => x.mfaProof.id });
    } else {
      // 최초 등록: active factor 가 없고 쓸 수 있는 grant 가 있어야 한다. 비밀번호 세션만으로는 등록하지 못한다
      if (c.activeFactorId) throw mfaRequired();
      const usable = await enrollmentGrantUsable(h, rt.key, { token: ctx.body?.grant, userId: c.user.id, authVersion: c.user.authVersion, purposes: ENROLL_GRANT_PURPOSES, now });
      if (!usable) throw err("FORBIDDEN", "MFA_GRANT_REQUIRED", "등록 자격이 필요해요");
    }
    const pending = await pendingFactorStatements(h, rt.cipher, policy, { userId: c.user.id, sessionId: c.session.id, authVersion: c.user.authVersion, now });
    steps.push({ build: (db) => pending.build(db)[0] }, { build: (db) => pending.build(db)[1] });
    await run(steps, c.user.id, proofRequired);
    return ctx.json({
      factorId: pending.factorId,
      otpauthUri: otpauthUri({ issuer: rt.issuer, account: (c.user.email ?? c.user.id).replace(/:/g, ""), secret: pending.secret, periodS: policy.totpPeriodS, digits: policy.totpDigits, algorithm: policy.totpAlgorithm }),
      secret: base32Encode(pending.secret),
      period: policy.totpPeriodS,
      digits: policy.totpDigits,
      algorithm: policy.totpAlgorithm,
      expiresAt: pending.expiresAt.toISOString(),
    });
  });

  const enrollConfirm = createAuthEndpoint("/admin-mfa/enroll/confirm", { method: "POST" }, async (ctx) => {
    checkRequest(ctx, true);
    const { policy, version, rt } = readyPolicy();
    const c = await adminContext(ctx);
    const now = new Date();
    const body = ctx.body ?? {};
    if (typeof body.factorId !== "string" || body.factorId.length > 36 || typeof body.code !== "string" || body.code.length > 16) throw badInput();
    const j = judgeMfa(c, rt.policy, now);
    const reenroll = j.state === "satisfied";
    // 지금 factor 가 있는데 MFA 를 마치지 않은 세션은 교체할 수 없다 (분실이면 다른 관리자의 초기화 → reset grant)
    if (!reenroll && c.activeFactorId) throw mfaRequired();
    let grantHash: string | null = null;
    if (!reenroll) {
      if (!validToken(body.grant) || !(await enrollmentGrantUsable(h, rt.key, { token: body.grant, userId: c.user.id, authVersion: c.user.authVersion, purposes: ENROLL_GRANT_PURPOSES, now }))) {
        throw err("FORBIDDEN", "MFA_GRANT_REQUIRED", "등록 자격이 필요해요");
      }
      grantHash = await grantTokenHash(rt.key, body.grant);
    }
    const pending = await loadFactor(h, rt.cipher, { factorId: body.factorId, userId: c.user.id });
    if (!pending || pending.state !== "pending" || pending.pendingSessionId !== c.session.id || pending.pendingAuthVersion !== c.user.authVersion || !pending.pendingExpiresAt || new Date(pending.pendingExpiresAt).getTime() <= now.getTime()) {
      throw err("CONFLICT", "MFA_ENROLLMENT_EXPIRED", "등록 시간이 지났어요. 다시 시작해 주세요");
    }
    const key = attemptKey(ctx, c.user.id);
    await gateAttempt(ctx, policy, key);
    const v = await verifyTotp({ secret: pending.secret, code: body.code, nowMs: now.getTime(), periodS: pending.periodS, digits: pending.digits, algorithm: pending.algorithm, pastWindow: policy.totpPastWindow, futureWindow: policy.totpFutureWindow });
    if (!v.ok) throw invalidCode();
    const userId = c.user.id;
    const factorId = pending.id;
    const nextVersion = c.user.authVersion + 1;
    const recovery = await freshRecovery(policy, factorId, userId);
    const steps: UnitStep[] = [
      { build: (db) => revokeAllFactorsUpdate(h, db, { userId, reason: "replaced", now, exceptFactorId: factorId, states: ["active"] }) },
      { build: (db) => dropRevokedCodesDelete(h, db, userId) },
      { build: (db) => activateUpdate(h, db, { factorId, userId, sessionId: c.session.id, authVersion: c.user.authVersion, step: v.step, now }), one: (x) => x.mfaFactor.id },
      ...(grantHash ? [{ build: (db: any) => grantConsumeUpdate(h, db, { tokenHash: grantHash!, userId, authVersion: c.user.authVersion, purposes: ENROLL_GRANT_PURPOSES, now }), one: (x: any) => x.mfaEnrollmentGrant.id }] : []),
      ...recovery.steps,
      { build: (db) => adminVersionBump(h, db, { userId, authVersion: c.user.authVersion, now }), one: (x) => x.user.id },
      { build: (db) => otherSessionsDelete(h, db, { userId, keepSessionId: c.session.id }) },
      { build: (db) => sessionMfaUpdate(h, db, { sessionId: c.session.id, userId, authVersion: c.user.authVersion, nextAuthVersion: nextVersion, factorId, method: "totp", policyVersion: version, now }), one: (x) => x.session.id },
      ...auditStep({ actorId: userId, action: "mfa.enroll", target: userId, detail: { factorId, replaced: reenroll, via: reenroll ? "proof" : "grant" }, ip: ipOf(ctx) }, now),
    ];
    await run(steps, userId, stale);
    await clearAttempts(key);
    return ctx.json({ recoveryCodes: recovery.codes });
  });

  const challenge = createAuthEndpoint("/admin-mfa/challenge", { method: "POST" }, async (ctx) => {
    checkRequest(ctx, true);
    const { policy, version } = readyPolicy();
    const c = await adminContext(ctx);
    if (!c.activeFactorId) throw err("FORBIDDEN", "MFA_ENROLLMENT_REQUIRED", "관리자 MFA 를 먼저 등록해 주세요");
    const input = codeInput(ctx.body, true)!;
    const key = attemptKey(ctx, c.user.id);
    await gateAttempt(ctx, policy, key);
    const now = new Date();
    const v = await verifyStep(c, input, policy, now);
    const steps: UnitStep[] = [
      ...v.steps,
      { build: (db) => sessionMfaUpdate(h, db, { sessionId: c.session.id, userId: c.user.id, authVersion: c.user.authVersion, factorId: v.factorId, method: v.method, policyVersion: version, now }), one: (x) => x.session.id },
      ...(v.method === "recovery" ? auditStep({ actorId: c.user.id, action: "mfa.recovery_use", target: c.user.id, detail: { factorId: v.factorId, via: "challenge" }, ip: ipOf(ctx) }, now) : []),
    ];
    await run(steps, c.user.id, invalidCode);
    await clearAttempts(key);
    return ctx.json({ state: "satisfied", method: v.method });
  });

  const stepUp = createAuthEndpoint("/admin-mfa/step-up", { method: "POST" }, async (ctx) => {
    checkRequest(ctx, true);
    const { policy, version, rt } = readyPolicy();
    const c = await adminContext(ctx);
    const now = new Date();
    const j = judgeMfa(c, rt.policy, now);
    if (j.state !== "satisfied") throw mfaRequired();
    const body = ctx.body ?? {};
    if (!(MFA_PROOF_PURPOSES as readonly unknown[]).includes(body.purpose) || typeof body.target !== "string" || body.target.length < 1 || body.target.length > TARGET_MAX) throw badInput();
    const input = codeInput(body, false);
    const base = { sessionId: c.session.id, userId: c.user.id, authVersion: c.user.authVersion, factorId: j.factorId, purpose: body.purpose as string, target: body.target as string };
    if (!input) {
      // 로그인·직전 MFA 시각이 최근성 안이면 그 시각 + 최근성까지 사는 proof 를 준다
      const until = new Date(j.verifiedAt.getTime() + policy.recencyTtlS * 1000);
      if (until.getTime() <= now.getTime()) throw invalidCode();
      const proof = await proofInsert(h, rt.key, { ...base, expiresAt: until });
      await run([{ build: proof.build }], c.user.id, stale);
      return ctx.json({ proof: proof.token, expiresAt: proof.expiresAt.toISOString() });
    }
    const key = attemptKey(ctx, c.user.id);
    await gateAttempt(ctx, policy, key);
    const v = await verifyStep(c, input, policy, now);
    const proof = await proofInsert(h, rt.key, { ...base, factorId: v.factorId, expiresAt: new Date(now.getTime() + policy.recencyTtlS * 1000) });
    const steps: UnitStep[] = [
      ...v.steps,
      { build: (db) => sessionMfaUpdate(h, db, { sessionId: c.session.id, userId: c.user.id, authVersion: c.user.authVersion, factorId: v.factorId, method: v.method, policyVersion: version, now }), one: (x) => x.session.id },
      { build: proof.build },
      ...(v.method === "recovery" ? auditStep({ actorId: c.user.id, action: "mfa.recovery_use", target: c.user.id, detail: { factorId: v.factorId, via: "step-up", purpose: base.purpose }, ip: ipOf(ctx) }, now) : []),
    ];
    await run(steps, c.user.id, invalidCode);
    await clearAttempts(key);
    return ctx.json({ proof: proof.token, expiresAt: proof.expiresAt.toISOString() });
  });

  const regenerate = createAuthEndpoint("/admin-mfa/recovery-codes/regenerate", { method: "POST" }, async (ctx) => {
    checkRequest(ctx, true);
    const { policy, rt } = readyPolicy();
    const c = await adminContext(ctx);
    const now = new Date();
    const j = judgeMfa(c, rt.policy, now);
    if (j.state !== "satisfied") throw mfaRequired();
    const token = proofFrom(ctx);
    if (!token) throw proofRequired();
    const tokenHash = await proofTokenHash(rt.key, token);
    const userId = c.user.id;
    const recovery = await freshRecovery(policy, j.factorId, userId);
    const steps: UnitStep[] = [
      { build: (db) => proofConsumeUpdate(h, db, { tokenHash, sessionId: c.session.id, userId, authVersion: c.user.authVersion, factorId: j.factorId, purpose: "mfa.recovery_regenerate", target: userId, now }), one: (x) => x.mfaProof.id },
      { build: (db) => recoveryDropUnused(h, db, { factorId: j.factorId, userId }) },
      ...recovery.steps,
      ...auditStep({ actorId: userId, action: "mfa.recovery_regenerate", target: userId, detail: { factorId: j.factorId, count: recovery.codes.length }, ip: ipOf(ctx) }, now),
    ];
    await run(steps, userId, proofRequired);
    return ctx.json({ recoveryCodes: recovery.codes });
  });

  /**
   * 부분 세션 제한 (hooks.before). 세션이 없거나 관리자가 아니거나 MFA 를 마쳤으면 그대로 둔다.
   * 미충족 관리자 세션은 /get-session·/sign-out·/admin-mfa/* 만. 만든 지 challengeTtlS 가 지났으면 세션을 지운다.
   */
  async function gate(ctx: Context): Promise<unknown> {
    if (!ctx.headers?.get("cookie") && !ctx.context.session?.session) return;
    const session = ctx.context.session ?? (await getSessionFromCtx(ctx));
    if (!session?.session) return;
    const c = await readAuthContext(h, { userId: session.user.id, sessionId: session.session.id });
    if (!c || c.user.role !== "admin") return;
    const ps = policyState();
    const now = new Date();
    const j = judgeMfa(c, ps, now);
    if (j.state === "satisfied") return;
    if (ctx.path === "/sign-out") return;
    if (ps.state === "ready" && c.session && c.session.createdAt.getTime() + ps.policy.challengeTtlS * 1000 <= now.getTime()) {
      await h.db.delete(s.session).where(eq(s.session.id, c.session.id));
      ctx.context.session = null;
      ctx.context.responseHeaders?.delete("set-cookie");
      // 지운 뒤에는 세션 없는 요청으로 이어 간다 (다시 로그인할 수 있게). 세션이 필요한 경로는 스스로 401 이다
      if (ctx.path === "/get-session") return ctx.json(null);
      return;
    }
    if (PARTIAL_SESSION_PATHS.includes(ctx.path) || ctx.path.startsWith(ADMIN_MFA_PREFIX)) return;
    throw mfaRequired();
  }

  return {
    plugin: {
      id: "admin-mfa",
      endpoints: { adminMfaStatus: status, adminMfaEnrollStart: enrollStart, adminMfaEnrollConfirm: enrollConfirm, adminMfaChallenge: challenge, adminMfaStepUp: stepUp, adminMfaRegenerateRecovery: regenerate },
    },
    gate,
  };
}
