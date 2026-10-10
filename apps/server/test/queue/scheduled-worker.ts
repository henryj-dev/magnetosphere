// TC-K1.T4.c 시험 Worker. 진입점 workers.ts 의 scheduled() 와 같은 runCron 에 시험용 작업 둘을 넘긴다.
// 작업은 실행 기록 한 줄을 남긴다 (wrangler dev 표준 출력으로 나온다). 진입 모듈이라 default 말고는 내보내지 않는다.
import type { WorkersEnv } from "@magnetosphere/runtime/workers";
import { runCron, type ExecutionContext, type ScheduledController } from "../../src/cron.ts";
import type { JobDef } from "../../src/jobs.ts";

const TEST_JOBS: readonly JobDef[] = [
  { name: "k1_every_minute", cron: "* * * * *", run: () => async ({ lease }) => console.log(`[k1-cron] ran k1_every_minute fence=${lease.fence}`) },
  { name: "k1_every_five", cron: "*/5 * * * *", run: () => async ({ lease }) => console.log(`[k1-cron] ran k1_every_five fence=${lease.fence}`) },
];

export default {
  // wrangler dev 가 떴는지 보는 /healthz 용
  fetch: () => new Response("ok"),
  scheduled: (controller: ScheduledController, env: WorkersEnv, ctx: ExecutionContext) => runCron(TEST_JOBS, controller, env, ctx),
};
