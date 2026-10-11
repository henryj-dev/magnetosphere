// 가입 정책 시험(M2)의 Better Auth 단언. Node 네 DB(policy.test.ts, node-rig.ts)와 D1(apps/server/test/signup/signup.workers.test.ts)이 같은 함수를 부른다.
// 가입 거부는 생긴 행 수로 본다. 응답은 Better Auth 가 숨길 수 있다 (실행판 0절).
import { expect } from "vitest";
import { V32_CALLS } from "../verify-p3/measure.ts";
import { attempt, body, mail, userRows, type Invite, type Rig } from "./rig.ts";

const INVITE: Invite = { inviteId: "inv-test", role: "member", email: null, verified: false };

/** 설치 뒤·메일 있음·승인 끔·상한 없음 */
export async function installed(rig: Rig) {
  await rig.op("addAdmin");
  await rig.op("setMail", true);
  await rig.op("setSetting", "signup_requires_approval", false);
  await rig.op("setSetting", "daily_signup_cap", null);
}

/** V32 의 회원을 만들 수 있는 경로 각각의 HTTP 요청 (M0 이 쓴 요청 그대로) */
function backstopCalls(A: any) {
  return V32_CALLS.filter((c) => A.backstopTargets.includes(c.label ?? c.path)).map((c) => {
    const url = (c.label && c.label.startsWith("/") && !c.label.includes(" ") ? c.label : c.path) + (c.query ?? "");
    return { label: c.label ?? c.path, method: c.method ?? "POST", url, body: c.body?.({ e: mail("t1b-e"), other: mail("t1b-other"), tokenB: "t1b-token" }) };
  });
}

/**
 * TC-M2.T1.b user 를 만드는 다른 경로는 뒷받침 훅이 막는다 (V29·V32 의존). closed 에서 V32 의 createsUser 경로 각각과
 * internalAdapter.createUser·createOAuthUser 직접 호출 → 새 user 0. auth.api 경로 목록은 V32 가 본 목록과 같아야 한다 (새 경로가 생기면 실패).
 */
export async function tcM2T1b(rig: Rig, A: any) {
  await installed(rig);
  await rig.op("setSetting", "signup_mode", "closed");
  const before = await userRows(rig);
  const calls = backstopCalls(A);
  expect(calls.map((c) => c.label)).toEqual(A.backstopTargets);
  for (const c of calls) {
    const r = await attempt(rig, () => rig.request(c.method, c.url, c.method === "GET" ? undefined : c.body));
    expect({ path: c.label, user: r.user, account: r.account }).toEqual({ path: c.label, user: 0, account: 0 });
  }
  for (const fn of ["createUser", "createOAuthUser"] as const) {
    const r = await attempt(rig, () => rig.internalCreate(fn, mail(`t1b-${fn}`)));
    expect({ fn, status: r.status, code: r.code, user: r.user }).toEqual({ fn, status: 400, code: "signup_closed", user: 0 });
  }
  // 정책이 열려 있어도 /sign-up/email 이 아닌 회원 생성은 거부된다 (SSO JIT 는 5단계가 decideSignup 에 IdP 줄을 더할 때까지 닫힘)
  await rig.op("setSetting", "signup_mode", "open");
  for (const fn of ["createUser", "createOAuthUser"] as const) {
    const r = await attempt(rig, () => rig.internalCreate(fn, mail(`t1b-open-${fn}`)));
    expect({ fn, mode: "open", code: r.code, user: r.user }).toEqual({ fn, mode: "open", code: "signup_closed", user: 0 });
  }
  expect(await userRows(rig)).toBe(before);
  // 경로 목록 고정: V32 가 부른 경로 + 그 밖의 경로. 판 올림·플러그인으로 회원을 만드는 새 경로가 생기면 여기서 걸린다
  const want = [...new Set([...V32_CALLS.map((c) => c.path), ...A.otherPaths])].sort();
  expect((await rig.apiPaths()).sort()).toEqual(want);
}

/**
 * TC-M2.T1.g 초대 문맥의 서버 호출은 signUpGate 를 지난다 (V29 의존). invite_only: runAsInvite 안 auth.api.signUpEmail → 통과·user +1,
 * 문맥 없이 → APIError 403 SIGNUP_CLOSED·행 0. closed 에서는 문맥이 있어도 403·행 0 (Q3).
 */
export async function tcM2T1g(rig: Rig) {
  await installed(rig);
  await rig.op("setSetting", "signup_mode", "invite_only");
  const invited = await attempt(rig, () => rig.apiSignUp(body(mail("t1g-inv")), INVITE));
  expect({ status: invited.status, user: invited.user, account: invited.account }, invited.body).toEqual({ status: 200, user: 1, account: 1 });
  const bare = await attempt(rig, () => rig.apiSignUp(body(mail("t1g-bare"))));
  expect({ status: bare.status, code: bare.code, user: bare.user, account: bare.account }).toEqual({ status: 403, code: "signup_closed", user: 0, account: 0 });
  await rig.op("setSetting", "signup_mode", "closed");
  const closed = await attempt(rig, () => rig.apiSignUp(body(mail("t1g-closed")), INVITE));
  expect({ status: closed.status, code: closed.code, user: closed.user, account: closed.account }).toEqual({ status: 403, code: "signup_closed", user: 0, account: 0 });
  // 이메일을 지정한 초대는 다른 이메일로 쓸 수 없다 (Q4)
  await rig.op("setSetting", "signup_mode", "invite_only");
  const other = await attempt(rig, () => rig.apiSignUp(body(mail("t1g-other")), { ...INVITE, email: mail("t1g-named") }));
  expect({ status: other.status, code: other.code, user: other.user }).toEqual({ status: 403, code: "signup_closed", user: 0 });
}

/**
 * TC-M2.T2.d domain_allowlist 인데 허용 도메인이 비면 공개 가입은 모두 거부된다 (M1 리뷰). 설정 API 는 이 상태를 만들지 않지만
 * M1 쓰기 경쟁으로 남을 수 있어 app_settings 에 직접 넣는다. 메일 있음 → 403 domain_not_allowed·행 0.
 */
export async function tcM2T2d(rig: Rig) {
  await installed(rig);
  await rig.op("setSetting", "signup_mode", "domain_allowlist");
  await rig.op("setSetting", "allowed_domains", []);
  for (const e of [mail("t2d"), mail("t2d", "example.com"), "t2d-no-domain"]) {
    const r = await attempt(rig, () => rig.signUp(body(e)));
    expect({ e, status: r.status, code: r.code, user: r.user, account: r.account, mail: r.mail }).toEqual({ e, status: 403, code: "domain_not_allowed", user: 0, account: 0, mail: 0 });
  }
  // 대조: 허용 도메인을 넣으면 같은 정책에서 가입된다
  await rig.op("setSetting", "allowed_domains", ["example.test"]);
  const ok = await attempt(rig, () => rig.signUp(body(mail("t2d-ok"))));
  expect({ status: ok.status, user: ok.user }, ok.body).toEqual({ status: 200, user: 1 });
}
