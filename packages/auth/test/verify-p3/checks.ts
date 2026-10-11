// TC-M0.T2~T5 의 단언 (M0). 측정(measure.ts)의 관찰을 docs/verify/V<n>.json 의 answer 와 비교한다.
// Node 네 DB 시험(이 폴더 v<n>.test.ts)과 D1 시험(apps/server/test/verify-p3/v<n>.workers.test.ts)이 같은 함수를 부른다.
import { expect } from "vitest";
import * as M from "./measure.ts";
import type { Rig } from "./measure.ts";

/** TC-M0.T2.a 앞 판정(hooks.before 403)은 이메일 존재와 무관하고 행·메일을 남기지 않는다 */
export async function tcM0T2a(rig: Rig, A: any) {
  expect(await M.v29BeforeHook(rig)).toEqual(A.beforeHook);
}

/** TC-M0.T2.b 뒷받침 훅(user.create.before) 403 은 가짜 200·행 0, 400 은 숨기지 않는다 */
export async function tcM0T2b(rig: Rig, A: any) {
  expect(await M.v29CreateHook(rig)).toEqual({ createHook403: A.createHook403, createHook400: A.createHook400 });
}

/** TC-M0.T2.c 훅이 돌려준 data 가 가입 기본값(emailVerified false 등)을 덮고, 발송기가 그 값을 본다 */
export async function tcM0T2c(rig: Rig, A: any) {
  const o = await M.v29HookData(rig);
  expect(o.status).toBe(200);
  expect({ hookDataOverrides: o.hookDataOverrides, mailerSeesVerified: o.mailerSeesVerified }).toEqual({ hookDataOverrides: A.hookDataOverrides, mailerSeesVerified: A.mailerSeesVerified });
}

/** TC-M0.T2.d 초대 문맥은 서버 호출의 두 훅에서만 보이고 공개 요청이 만들 수 없다, user.create.after 는 커밋 뒤 */
export async function tcM0T2d(rig: Rig, A: any) {
  const o = await M.v29Als(rig);
  expect(o.statuses).toEqual({ api: 200, publicRequest: 200, forged: 200 });
  const rt = rig.runtime;
  expect(o.alsVisible).toEqual({
    beforeHook: A.alsVisible.beforeHook[rt],
    createHook: A.alsVisible.createHook[rt],
    createAfter: A.alsVisible.createAfter[rt],
    publicRequest: A.alsVisible.publicRequest,
    forgeable: A.alsVisible.forgeable,
  });
  expect(o.createAfterRunsAfterCommit).toBe(A.createAfterRunsAfterCommit);
}

/** TC-M0.T3.a 세션 행을 지운 뒤 첫 요청부터 세션이 없다 */
export async function tcM0T3a(rig: Rig, A: any) {
  const o = await M.v30Delete(rig);
  // 대조: 지우기 전에는 세션이 있다
  expect({ signInStatus: o.signInStatus, sessionBeforeDelete: o.sessionBeforeDelete }).toEqual({ signInStatus: 200, sessionBeforeDelete: true });
  expect({ cookieCacheEnabled: o.cookieCacheEnabled, firstRequestAfterDelete: o.firstRequestAfterDelete }).toEqual({ cookieCacheEnabled: A.cookieCacheEnabled, firstRequestAfterDelete: A.firstRequestAfterDelete });
}

/** TC-M0.T3.b 비밀번호 변경·재설정은 기본으로 다른 세션을 남긴다 */
export async function tcM0T3b(rig: Rig, A: any) {
  const o = await M.v30Password(rig);
  expect({ changePasswordStatus: o.changePasswordStatus, resetStatus: o.resetStatus }).toEqual({ changePasswordStatus: 200, resetStatus: { off: 200, on: 200 } });
  expect({ otherSessionsAfterPasswordChange: o.otherSessionsAfterPasswordChange, sessionsAfterReset: o.sessionsAfterReset }).toEqual({
    otherSessionsAfterPasswordChange: A.otherSessionsAfterPasswordChange,
    sessionsAfterReset: A.sessionsAfterReset,
  });
}

/** TC-M0.T4.a 로그인 거부 훅(session.create.before)은 세션을 만들지 않는다 */
export async function tcM0T4a(rig: Rig, A: any) {
  const o = await M.v31Reject(rig);
  // 대조: 활성 회원은 같은 구성으로 로그인되고 세션 1행
  expect({ activeStatus: o.activeStatus, activeSessionRows: o.activeSessionRows }).toEqual({ activeStatus: 200, activeSessionRows: 1 });
  const { activeStatus: _s, activeSessionRows: _r, ...seen } = o;
  const keys = ["rejectStatus", "rejectCode", "pendingCode", "sessionRows", "sessionCookie", "wrongPasswordStatus"] as const;
  expect(seen).toEqual(Object.fromEntries(keys.map((k) => [k, A[k]])));
}

/** TC-M0.T4.b 재설정·인증 링크가 세션을 만드는지, session.create.after 가 방금 만든 세션을 지울 수 있는지 */
export async function tcM0T4b(rig: Rig, A: any) {
  const o = await M.v31Paths(rig);
  // 대조: 재설정·인증은 성공했고, after 훅 구성의 로그인은 쿠키를 심었다
  expect({ resetStatus: o.resetStatus, verifyStatus: o.verifyStatus, verifiedAfterLink: o.verifiedAfterLink, afterHookSignIn: o.afterHookSignIn }).toEqual({
    resetStatus: 200,
    verifyStatus: 302,
    verifiedAfterLink: true,
    afterHookSignIn: { status: 200, sessionCookie: true },
  });
  expect({ resetCreatesSession: o.resetCreatesSession, verifyCreatesSession: o.verifyCreatesSession, afterHookCanDelete: o.afterHookCanDelete }).toEqual({
    resetCreatesSession: A.resetCreatesSession,
    verifyCreatesSession: A.verifyCreatesSession,
    afterHookCanDelete: A.afterHookCanDelete,
  });
}

/** TC-M0.T5.a 회원 변경·생성 경로의 기본 상태가 V32 와 같다. auth.api 의 모든 경로가 V32 에 분류돼 있다 */
export async function tcM0T5a(rig: Rig, A: any) {
  const o = await M.v32Paths(rig);
  expect(o.paths).toEqual(A.paths.map(({ path, status, effect }: any) => ({ path, status, effect })));
  // 막을 경로(이메일 바뀜·회원 지워짐)와 뒷받침 훅 대상(createsUser)
  expect(A.mustDisable).toEqual(A.paths.filter((p: any) => /이메일 바뀜|회원 지워짐/.test(p.effect)).map((p: any) => p.path));
  expect(A.backstopTargets).toEqual(A.paths.filter((p: any) => p.createsUser).map((p: any) => p.path));
  // 1.7.7 auth.api 의 경로가 하나도 빠짐없이 부른 경로 또는 otherPaths 에 있다 (판 올림으로 생긴 새 경로를 잡는다)
  const called = new Set(M.V32_CALLS.map((c) => c.path));
  expect(o.allPaths).toEqual([...new Set([...called, ...A.otherPaths])].sort());
}
