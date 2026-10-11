// 요청 문맥 메모 (3단계 실행판 M2.T1, #13 리뷰 "가입 경로가 설정을 두 번 읽는다"). 가입 요청 하나에서 판정 입력(관리자 있음·설정·메일·오늘 가입 수)을
// 한 번만 읽고 서버 앞 판정(app.ts)·Better Auth 앞 판정(signUpGate)·생성 훅이 같은 값을 쓴다. 메모는 그 요청의 비동기 흐름에만 있다.
// 인스턴스 캐시는 두지 않는다 — 정책을 닫아도 다른 인스턴스가 한동안 가입을 받게 된다 (TC-M2.T5.a). Workers 는 nodejs_compat 의 node:async_hooks.
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

/** fn 의 비동기 흐름이 요청 하나다 */
export function withRequestMemo<T>(fn: () => T): T {
  return store.run(new Map(), fn);
}

/** 요청 안에서는 key 마다 한 번만 load 한다 (실패도 그대로 나눠 받는다 — 판정은 fail-closed). 요청 밖이면 매번 load */
export function memo<T>(key: string, load: () => Promise<T>): Promise<T> {
  const m = store.getStore();
  if (!m) return load();
  let p = m.get(key) as Promise<T> | undefined;
  if (!p) m.set(key, (p = load()));
  return p;
}
