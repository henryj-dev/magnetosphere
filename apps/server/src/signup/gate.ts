// 서버의 가입 앞 판정과 Better Auth 가입 훅 연결 (3단계 실행판 M2.T1·M2.T3, 계획서 4.2).
//   - publicSignupDenial: app.ts 의 /api/auth/sign-up* 미들웨어가 부른다. Better Auth 에 넘기기 전에 decideSignup 으로 공개 가입을 판정한다.
//     Better Auth 가 이메일을 찾기 전이라 같은 정책·같은 도메인이면 있는 이메일·없는 이메일이 같은 403 과 사유 코드를 받는다 (Q19 (가)).
//     초대 수락은 서버 안 호출(auth.api.signUpEmail)이라 이 미들웨어를 지나지 않는다 (Better Auth 의 signUpGate 가 초대 줄로 판정한다).
//   - 하루 상한에 닿은 거부는 그날 처음 한 번 감사 기록 alert.signup_cap 을 남긴다 (Q13).
//   - signupAuthHooks: createAuth 에 넘기는 판정 입력 메모와 가입 뒤 감사 기록 member.signup (Q17).
import { and, eq, sql } from "drizzle-orm";
import { decideSignup, loadSignupInputs, type SignupDenial, type SignupInputs } from "@magnetosphere/db/src/signup.ts";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { writeAudit } from "../audit/index.ts";
import { memo } from "./request-memo.ts";

/** 판정 입력. 요청 하나에서 한 번만 읽는다 (Better Auth 훅도 같은 메모를 쓴다) */
export function signupInputs(h: DbHandle): Promise<SignupInputs> {
  return memo("signup-inputs", () => loadSignupInputs(h.db, h.schema));
}

/** 요청 본문의 email. Better Auth 처럼 JSON·폼 본문을 읽는다. 못 읽으면 null (허용 도메인과 맞지 않는다) */
async function bodyEmail(req: Request): Promise<unknown> {
  const type = req.headers.get("content-type") ?? "";
  try {
    if (/^application\/x-www-form-urlencoded\b/i.test(type)) return new URLSearchParams(await req.clone().text()).get("email");
    const b = JSON.parse(await req.clone().text());
    return b && typeof b === "object" ? (b as { email?: unknown }).email : null;
  } catch {
    return null;
  }
}

/**
 * 하루 상한 알림을 그날 처음 한 번만 (rate_limit 칸 하나를 넣은 요청만 쓴다 — 여러 인스턴스가 동시에 닿아도 1행).
 * 그날 칸이 이미 있으면 읽기만 한다. 상한 뒤의 공개 거부는 인증 없이 얼마든지 오므로 거부마다 쓰지 않는다 (TC-M2.T3.d, 리뷰 M2).
 */
async function alertSignupCapOnce(h: DbHandle, cap: number | null, now: Date): Promise<void> {
  const t = h.schema.rateLimit;
  const day = now.toISOString().slice(0, 10);
  const key = `signup-cap-alert|${day}`;
  if ((await h.db.select({ id: t.id }).from(t).where(eq(t.key, key)).limit(1)).length) return;
  await h.db.delete(t).where(and(sql`${t.key} like 'signup-cap-alert|%'`, sql`${t.key} <> ${key}`));
  const row = { id: crypto.randomUUID(), key, count: 1, lastRequest: now.getTime() };
  const first = h.provider === "mysql" ? (await h.db.insert(t).ignore().values(row))[0].affectedRows === 1 : (await h.db.insert(t).values(row).onConflictDoNothing().returning()).length === 1;
  if (!first) return;
  try {
    await writeAudit(h, { actorId: null, action: "alert.signup_cap", target: null, detail: { day, cap }, ip: null, now });
  } catch (e) {
    // 다음 거부가 다시 쓸 수 있게 칸을 돌려준다
    await h.db.delete(t).where(eq(t.key, key));
    throw e;
  }
}

/**
 * 공개 가입 앞 판정. 받으면 null, 막으면 응답할 { status, error }. 설치 전은 403 setup_required (TC-S4.T4.e).
 * 판정 입력을 읽지 못하면(DB 오류) 던진다 — 앱의 onError 가 500 으로 막는다 (fail-closed).
 */
export async function publicSignupDenial(h: DbHandle, req: Request, now = new Date()): Promise<{ status: 403; error: "setup_required" | SignupDenial } | null> {
  const inputs = await signupInputs(h);
  if (!inputs.adminExists) return { status: 403, error: "setup_required" };
  const d = decideSignup({ inputs, email: await bodyEmail(req), via: "public" });
  if (d.ok) return null;
  if (d.code === "signup_cap") {
    await alertSignupCapOnce(h, inputs.settings.daily_signup_cap, now).catch((e) => console.warn("[signup] 하루 상한 알림을 남기지 못했다", e));
  }
  return { status: 403, error: d.code };
}

/** createAuth 에 넘길 가입 훅 (packages/auth AuthConfig.signupInputs·onUserCreated) */
export function signupAuthHooks(h: DbHandle) {
  return {
    signupInputs: (load: () => Promise<SignupInputs>) => memo("signup-inputs", load),
    onUserCreated: async (e: { userId: string; via: "public" | "invite"; inviteId: string | null; ip: string | null }) => {
      // 감사 기록 detail 에 이메일·이름을 넣지 않는다 (Q17). target 은 회원 id
      await writeAudit(h, { actorId: e.userId, action: "member.signup", target: e.userId, detail: { via: e.via, inviteId: e.inviteId }, ip: e.ip, now: new Date() });
    },
  };
}
