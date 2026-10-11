// 초대 문맥 통로 (3단계 실행판 M2.T1, V29 TC-M0.T2.d). 초대 수락(M3, apps/server/src/invites)이 runAsInvite 안에서 auth.api.signUpEmail 을
// 부르면, 가입 판정 두 자리(hooks.before signUpGate·databaseHooks.user.create.before)가 그 가입을 초대 줄로 판정한다.
// 패키지 진입점(".")의 내보내기 목록은 TC-S3.T3.d 가 고정하므로 이 통로는 "@magnetosphere/auth/invite-context" 로 따로 낸다.
// 값은 프로세스 안 AsyncLocalStorage 에만 있다. 요청 본문·헤더·쿠키는 읽지 않으므로 공개 HTTP 요청이 이 문맥을 만들 길이 없다 (TC-M2.T1.f).
// Workers 는 nodejs_compat 의 node:async_hooks 를 쓴다 (V29 alsVisible.workers).
import { AsyncLocalStorage } from "node:async_hooks";

/** 초대 하나가 주는 것. 초대 단계(M3)가 초대 행을 검사한 뒤 넘긴다 */
export interface InviteGrant {
  inviteId: string;
  role: "member" | "admin";
  /** 이메일을 지정한 초대면 그 이메일 (그 이메일로만 가입된다, Q4). 이메일 없는 링크는 null */
  email: string | null;
  /** 수락이 이메일 인증을 대신하나 (이메일 지정 초대, Q5) */
  verified: boolean;
}

const store = new AsyncLocalStorage<Readonly<InviteGrant>>();

/** fn 안에서 부른 가입만 초대 가입이다. 문맥은 fn 의 비동기 흐름에만 있다 */
export function runAsInvite<T>(grant: InviteGrant, fn: () => Promise<T>): Promise<T> {
  return store.run(Object.freeze({ ...grant }), fn);
}

/** 지금 흐름의 초대 문맥. 없으면 null */
export function currentInvite(): Readonly<InviteGrant> | null {
  return store.getStore() ?? null;
}
