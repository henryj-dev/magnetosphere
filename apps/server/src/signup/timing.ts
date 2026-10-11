// 가입 응답 최소 시간 (3단계 실행판 M2.T4, S7 에서 찾은 노출). 새 가입만 DB 에 행을 써서(CI 러너 약 110ms) 응답이 늦으면,
// 요청 몇 번으로 그 이메일이 가입돼 있는지 알아낼 수 있다. 그래서 /api/auth/sign-up* 응답(앞 판정 거부·요청 수 제한 429·오류 포함)을
// 시작 시각 + SIGNUP_MIN_MS 까지 기다린 뒤 돌려준다. 초대 수락(M3)도 이 함수를 부른다.
// Node 는 setTimeout 이고, Workers 도 요청 안에서 기다린다 (응답 전이라 waitUntil 이 필요 없다).

/** 400ms = CI 러너의 가입 DB 쓰기(약 110ms) + 비밀번호 해시 + 여유 */
export const SIGNUP_MIN_MS = 400;

/** fn 의 결과(던진 오류도)를 시작 시각 + ms 까지 기다린 뒤 돌려준다 */
export async function withMinDuration<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  // Date.now() 는 밀리초로 잘리고 타이머는 조금 일찍 울릴 수 있어(CI 399.4ms) 고해상도 시계로 남은 시간이 0 이 될 때까지 다시 기다린다
  const start = performance.now();
  const wait = async () => {
    for (let left = ms - (performance.now() - start); left > 0; left = ms - (performance.now() - start)) {
      await new Promise<void>((r) => setTimeout(r, Math.ceil(left)));
    }
  };
  try {
    const out = await fn();
    await wait();
    return out;
  } catch (e) {
    await wait();
    throw e;
  }
}
