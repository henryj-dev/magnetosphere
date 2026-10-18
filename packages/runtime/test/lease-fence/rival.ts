// 임대 경쟁 시험의 경쟁 루프 (TC-K1.T2.a 가 쓰고, TC-FOLLOWUP.Heartbeat.* 가 DB 없이 본다).
// 작업(job)이 시작을 알린 뒤부터 끝날 때까지 everyMs 마다 attempt 를 부르고, 작업이 어떻게 끝나든 루프를 멈추고 기다린다.
//   - job 이 던져도(하트비트 단언·임대 잃음·DB 예외) 루프를 멈춘다. 멈추지 않으면 afterAll 이 연결을 닫은 뒤에도 attempt 가 돌아
//     CLIENT_CLOSED 가 처리되지 않은 거부로 남고, 원래 실패를 가린다.
//   - job 이 시작을 알리지 않고 끝나도(임대를 못 잡아 false) 루프가 시작 신호를 기다린 채 멈춰 있지 않는다.
//   - attempt 의 예외는 곧바로 받아 둔다. job 이 도는 동안 처리되지 않은 거부로 남지 않는다.
// 예외는 던지지 않고 돌려준다. 어느 실패를 먼저 드러낼지는 부르는 쪽이 정한다.
// 이미 시작한 attempt 가 영구 대기하면 정리도 기다린다. 임의의 Promise.race 시간 초과로 진행 중인 DB 요청을 버리고 close 하지 않는다 (상한은 위 test·process 의 유한 제한이 맡는다).
import { setTimeout as sleep } from "node:timers/promises";

export interface Race<T> {
  /** job 이 끝까지 돌았을 때의 값 */
  ran?: boolean;
  /** attempt 결과 (부른 순서) */
  tries: T[];
  /** job 이 던진 원래 예외 */
  jobFailure?: { error: unknown };
  /** attempt 가 던진 원래 예외. 그 뒤로는 부르지 않는다 */
  rivalFailure?: { error: unknown };
}

export async function raceWhileRunning<T>(job: (started: () => void) => Promise<boolean>, attempt: () => Promise<T>, everyMs: number): Promise<Race<T>> {
  const race: Race<T> = { tries: [] };
  let running = true;
  let started!: () => void;
  const jobStarted = new Promise<void>((r) => (started = r));
  const rival = (async () => {
    await jobStarted;
    while (running) {
      await sleep(everyMs);
      if (running) race.tries.push(await attempt());
    }
  })().catch((error: unknown) => {
    race.rivalFailure = { error };
  });
  try {
    race.ran = await job(started);
  } catch (error) {
    race.jobFailure = { error };
  } finally {
    running = false;
    started();
    await rival;
  }
  return race;
}
