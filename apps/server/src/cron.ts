// Workers Cron 호출 하나 (wrangler.toml [triggers]). Worker 진입점(workers.ts)과 시험 Worker(TC-K1.T4.c)가 같이 쓴다.
// 진입 모듈의 이름 있는 내보내기는 workerd 가 진입점으로 읽으므로 이 함수는 따로 둔다.
import { createWorkersRuntime, type WorkersEnv } from "@magnetosphere/runtime/workers";
import { registerJobs, type JobDef } from "./jobs.ts";

export interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
}

export interface ScheduledController {
  cron: string;
  /** Cron 이 예약한 시각 (ms). 경계 번호를 이것으로 정한다 */
  scheduledTime: number;
}

/** 받은 cron 에 등록된 작업만 돌고 DB 연결을 닫는다 */
export async function runCron(jobs: readonly JobDef[], controller: ScheduledController, env: WorkersEnv, ctx: ExecutionContext): Promise<void> {
  const runtime = createWorkersRuntime(env);
  registerJobs(runtime, jobs);
  try {
    await runtime.runScheduled(controller.cron, controller.scheduledTime);
  } finally {
    ctx.waitUntil(runtime.close());
  }
}
