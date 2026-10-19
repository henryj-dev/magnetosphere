// 초대 수락 (3단계 실행판 M3.T2, 계획서 4.2, V29·Q4·Q5·Q6·Q16).
//   POST /api/invites/accept { token, email, name, password } → 201 { emailVerified, mfaGrant? } · 400 invalid_invite · 429 rate_limited
//   공개 경로(세션 없음)다. 본문은 application/json 만 받는다 (다른 출처의 단순 폼 요청으로는 못 보낸다).
//   - 실패는 이유를 가르지 않는다: 없는 토큰·형식이 틀린 토큰·만료·취소(재초대로 대체 포함)·사용됨·이메일 불일치·이미 있는 이메일·
//     정책이 닫힌 뒤·입력 형식 오류가 모두 같은 400 invalid_invite 이고, 응답 전체를 SIGNUP_MIN_MS(400ms)까지 채운다 (signup/timing.ts).
//   - 요청 수 제한: 클라이언트 IP 당 10분 10회 (토큰 대입·"이미 있는 이메일" 탐침을 막는다). 넘으면 429.
//   - 순서
//     1. 찾기: 토큰이 32바이트 base64url(43자) 꼴일 때만 SHA-256 해시로 초대를 찾는다. 이메일 지정 초대는 본문 이메일을 trim·소문자·NFC 로
//        정규화해 초대 행의 email 과 JS 에서 정확히 비교한다 (MySQL 의 대소문자·악센트 무시 비교에 기대지 않는다).
//     2. 차지: UPDATE invites SET used_at = :now WHERE id = :id AND used_at IS NULL AND revoked_at IS NULL AND expires_at > :now 한 문장.
//        영향 행 1 일 때만 다음으로 간다 (MySQL affectedRows, 나머지 RETURNING). 기본 키 한 행만 잠그므로 초대 쓰기 뮤텍스는 잡지 않는다.
//     3. 가입: runAsInvite({ inviteId, role, email: 초대 이메일 ?? 본문 이메일, verified: 초대에 이메일이 있음 }, auth.api.signUpEmail).
//        역할·상태·인증·한도는 Better Auth 생성 훅이 초대 문맥에서 넣는다. 요청 본문은 email·name·password 만 넘긴다.
//     4. 확인: 돌려받은 user.id 의 행이 있고 이메일이 같아야 한다. 이미 있는 이메일이면 Better Auth 가 가짜 id 로 200 을 준다.
//        아니거나 가입이 던지면 차지를 되돌린다: UPDATE … SET used_at = NULL WHERE id = :id AND used_at = :mine AND used_by IS NULL
//        (다른 수락의 차지는 지우지 않는다. D1 은 대화형 트랜잭션이 없어 이 조건으로만 되돌린다).
//     5. 마무리: used_by = 새 회원 id 와 감사 invite.accept 를 한 트랜잭션(READ COMMITTED 명시, D1 은 감사 INSERT … SELECT 를 같은 조건 UPDATE 앞에 둔 batch).
//   - 기록에는 비밀번호·토큰·이메일을 남기지 않는다. 가입 예외는 오류 코드만 남긴다.
// 관리자 MFA (A1, 2026-10-19 사용자 결정): 이메일 지정 관리자 초대를 수락하면 그 응답 mfaGrant 에 등록 grant(promotion, 발급자 = 초대 만든 관리자)를
//   한 번 넣는다. grant 는 5. 마무리(used_by·감사)와 같은 원자 단위에서 만든다 (Node 트랜잭션, D1 은 used_by UPDATE 뒤 guard 를 둔 batch).
//   MFA 정책이 없으면 관리자 초대는 차지하기 전에 같은 400 invalid_invite 로 닫는다 (grant 없는 관리자를 만들지 않는다).
//   응답 키는 grant 다 (응답 DTO 의 token 키 금지와 구분). Cache-Control: no-store.
// 이번 범위 밖(사용자 결정 대기): 수락 때 mail_required 재확인, 초대 가입의 허용 도메인 적용. 판정은 지금 decideSignup 그대로다.
// 같은 이메일의 다른 초대(형제)는 정리하지 않는다 — 만들기가 직렬화되어 이메일마다 살아 있는 초대가 하나다 (admin.ts).
import { and, eq, gt, isNull } from "drizzle-orm";
import { grantInsert } from "@magnetosphere/auth/mfa";
import { Hono, type Context } from "hono";
import { runAsInvite } from "@magnetosphere/auth/invite-context";
import { updatedRows } from "@magnetosphere/runtime/lease";
import type { DbHandle } from "@magnetosphere/runtime/types";
import type { Services } from "../app.ts";
import { auditStatement, type AuditEntry } from "../audit/index.ts";
import { d1ProofGuard, proofGuardFailed } from "../mfa/proof.ts";
import { consume, ipBucket } from "../routes/guard.ts";
import { readSettings } from "../settings/index.ts";
import { withRequestMemo } from "../signup/request-memo.ts";
import { SIGNUP_MIN_MS, withMinDuration } from "../signup/timing.ts";
import { auditEachStatement, INVITE_TX, normalizeInviteEmail, tokenHash } from "./admin.ts";

export const ACCEPT_LIMIT = { max: 10, windowMs: 10 * 60_000 } as const;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
// Better Auth emailAndPassword 기본 길이 제한과 같다 (setup/index.ts 와 같은 값)
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
const NAME_MAX = 255;
/** 초대 가입을 받는 정책 (packages/db/src/signup.ts INVITE_SIGNUP_MODES). 닫힌 정책이면 차지하기 전에 거른다 — 판정은 생성 훅이 다시 한다 */
const INVITE_MODES = new Set(["invite_only", "open", "domain_allowlist"]);

class Invalid extends Error {}
const invalid = () => new Invalid("invalid_invite");

interface Input {
  token: string;
  email: string;
  name: string;
  password: string;
}

/** 본문 검사. 모르는 필드(role·status 등)는 무시하고 넘기지 않는다 */
function parse(raw: unknown): Input | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.token !== "string" || !TOKEN.test(b.token)) return null;
  if (typeof b.email !== "string") return null;
  const email = normalizeInviteEmail(b.email);
  if (email === null) return null;
  if (typeof b.name !== "string" || b.name.trim() === "" || b.name.length > NAME_MAX) return null;
  if (typeof b.password !== "string" || b.password.length < PASSWORD_MIN || b.password.length > PASSWORD_MAX) return null;
  return { token: b.token, email, name: b.name.trim(), password: b.password };
}

/** 차지를 되돌린다. 내 차지(같은 used_at)이고 아직 마무리 전일 때만 */
async function release(h: DbHandle, id: string, mine: Date): Promise<void> {
  const t = h.schema.invites;
  await h.db.update(t).set({ usedAt: null }).where(and(eq(t.id, id), eq(t.usedAt, mine), isNull(t.usedBy)));
}

/** 마무리에 같이 넣는 관리자 MFA 등록 grant 와 그 감사 (관리자 초대만) */
interface GrantPart {
  build(db: any): any;
  audit: AuditEntry;
}

/** 마무리: used_by 와 감사 invite.accept (관리자 초대면 등록 grant 와 mfa.grant_issue 도). 내 차지일 때만 바뀐다. 바뀐 행 수를 돌려준다 */
async function finish(h: DbHandle, id: string, mine: Date, userId: string, audit: Omit<AuditEntry, "target">, grant: GrantPart | null): Promise<number> {
  const t = h.schema.invites;
  const mineCond = and(eq(t.id, id), eq(t.usedAt, mine), isNull(t.usedBy));
  if (h.kind === "d1") {
    // grant 는 used_by UPDATE 가 한 행일 때만 들어간다: 바로 뒤 guard 가 0행이면 batch 전체를 되돌린다
    // guard 가 0행으로 batch 를 되돌리면 Node 와 같이 0 을 돌려준다 (아무것도 쓰지 않음, 보안 리뷰 L4). 그 밖의 오류는 그대로 던진다
    const guard = grant ? d1ProofGuard(h) : null;
    let res: unknown[];
    try {
      res = await h.db.batch([
        auditEachStatement(h, h.db, audit, mineCond),
        h.db.update(t).set({ usedBy: userId }).where(mineCond).returning({ id: t.id }),
        ...(grant && guard ? [guard.guard, grant.build(h.db), auditStatement(h, grant.audit), guard.drop] : []),
      ]);
    } catch (e) {
      if (guard && proofGuardFailed(e)) return 0;
      throw e;
    }
    return (res[1] as unknown[]).length;
  }
  return h.db.transaction(async (tx: any) => {
    const n = await updatedRows(h, tx.update(t).set({ usedBy: userId }).where(mineCond), t.id);
    if (n === 1) {
      await auditStatement(h, { ...audit, target: id }, tx);
      if (grant) {
        await grant.build(tx);
        await auditStatement(h, grant.audit, tx);
      }
    }
    return n;
  }, h.provider === "sqlite" ? undefined : INVITE_TX);
}

async function acceptOnce(c: Context, s: Services): Promise<Response> {
  const h = s.db;
  const ip = (await s.clientIp?.(c.req.raw)) ?? null;
  if (!(await consume(h, `invite-accept|${ipBucket(ip)}`, ACCEPT_LIMIT.max, ACCEPT_LIMIT.windowMs, Date.now()))) return c.json({ error: "rate_limited" }, 429);
  const signUpEmail = s.auth.api?.signUpEmail;
  if (!signUpEmail) throw new Error("auth.api.signUpEmail 이 없다 (서비스 설정)");
  try {
    if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) throw invalid();
    const input = parse(await c.req.json().catch(() => null));
    if (!input) throw invalid();
    if (!INVITE_MODES.has((await readSettings(h)).signup_mode)) throw invalid();

    // 1. 찾기
    const t = h.schema.invites;
    const [inv] = await h.db
      .select({ id: t.id, email: t.email, role: t.role, expiresAt: t.expiresAt, usedAt: t.usedAt, revokedAt: t.revokedAt, createdBy: t.createdBy })
      .from(t)
      .where(eq(t.tokenHash, await tokenHash(input.token)));
    if (!inv || inv.usedAt !== null || inv.revokedAt !== null || new Date(inv.expiresAt).getTime() <= Date.now()) throw invalid();
    if (inv.email !== null && inv.email !== input.email) throw invalid();
    // 다층 방어: 관리자 초대는 이메일 지정일 때만 받는다 (만들기가 막지만 행이 직접 들어온 경우에도, 보안 리뷰 L-3)
    if (inv.role !== "member" && !(inv.role === "admin" && inv.email !== null)) throw invalid();
    // 관리자 초대는 등록 grant 를 함께 내야 하므로 MFA 정책이 있어야 받는다 (차지하기 전)
    const policy = inv.role === "admin" && s.mfa?.policy.state === "ready" ? s.mfa.policy.policy : null;
    if (inv.role === "admin" && !policy) throw invalid();

    // 2. 차지
    const mine = new Date();
    const claimed = await updatedRows(
      h,
      h.db.update(t).set({ usedAt: mine }).where(and(eq(t.id, inv.id), isNull(t.usedAt), isNull(t.revokedAt), gt(t.expiresAt, mine))),
      t.id,
    );
    if (claimed !== 1) throw invalid();

    // 3. 가입 · 4. 확인
    const email = inv.email ?? input.email;
    let userId: string | null = null;
    let authVersion = 0;
    try {
      const out = (await runAsInvite({ inviteId: inv.id, role: inv.role, email: inv.email, verified: inv.email !== null }, () =>
        signUpEmail({ body: { email, name: input.name, password: input.password } }),
      )) as { user?: { id?: unknown } } | null;
      const id = out?.user?.id;
      if (typeof id === "string") {
        const u = h.schema.user;
        const [row] = await h.db.select({ id: u.id, email: u.email, authVersion: u.authVersion }).from(u).where(eq(u.id, id));
        if (row && String(row.email).toLowerCase() === email) {
          userId = row.id;
          authVersion = Number(row.authVersion);
        }
      }
    } catch (e) {
      const code = (e as { body?: { code?: unknown } })?.body?.code;
      console.warn(`[invites] 초대 가입 실패 (${typeof code === "string" ? code : ((e as Error)?.name ?? "알 수 없음")})`);
    }
    if (userId === null) {
      await release(h, inv.id, mine);
      throw invalid();
    }

    // 5. 마무리 (관리자 초대면 등록 grant 도 같은 단위)
    const now = new Date();
    const grant = policy
      ? await grantInsert(h, s.mfa!.key, policy, { userId, purpose: "promotion", issuedBy: inv.createdBy, authVersion, now })
      : null;
    const done = await finish(h, inv.id, mine, userId, {
      actorId: userId,
      action: "invite.accept",
      detail: { role: inv.role, emailBound: inv.email !== null, userId },
      ip,
      now,
    }, grant ? { build: grant.build, audit: { actorId: inv.createdBy, action: "mfa.grant_issue", target: userId, detail: { purpose: "promotion", via: "invite" }, ip, now } } : null);
    if (done !== 1) console.warn(`[invites] 초대 ${inv.id} 수락 마무리가 차지와 맞지 않는다 (회원은 만들어졌다)`);
    if (!grant || done !== 1) return c.json({ emailVerified: inv.email !== null }, 201);
    // 등록 grant 는 이 응답에만 한 번 나간다
    c.header("Cache-Control", "no-store");
    return c.json({ emailVerified: inv.email !== null, mfaGrant: { grant: grant.token, expiresAt: grant.expiresAt.toISOString() } }, 201);
  } catch (e) {
    if (e instanceof Invalid) return c.json({ error: "invalid_invite" }, 400);
    throw e;
  }
}

export function inviteAcceptRoutes(services: () => Promise<Services>) {
  const r = new Hono();
  r.post("/accept", (c) => withRequestMemo(() => withMinDuration(SIGNUP_MIN_MS, async () => acceptOnce(c, await services()))));
  return r;
}
