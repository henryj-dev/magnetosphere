// 주기 작업 목록. Node 는 시작할 때 runtime.schedule 로 프로세스 안 타이머(1분 경계)에 걸고, Workers 는 Cron Trigger 가 scheduled() 로 부른다.
// 두 런타임 모두 job_leases 임대·하트비트 아래에서 돈다 (K1.T2). 작업은 { db, lease, signal } 을 받는다.
// cron 문자열 집합은 wrangler.toml 의 [triggers] crons 와 같아야 한다 (Workers 는 그 cron 으로만 깨어난다, TC-K1.T4.b).
// 본문이 있는 작업만 등록한다. 정합성 점검(reconcile, "*\/5 * * * *")은 K3 이 붙인다.
import type { Job, Runtime } from "@magnetosphere/runtime/types";
import { rebalanceJob } from "./limits/rebalance.ts";
import { queueJob } from "./queue/runner.ts";

export interface JobDef {
  name: string;
  cron: string;
  run: (rt: Runtime) => Job;
}

export const JOBS: readonly JobDef[] = [
  // 작업 큐 실행기. 재시도 간격의 최소 단위가 1분이다 (계획서 v5.6 Q2)
  { name: "omniroute_jobs", cron: "* * * * *", run: queueJob },
  // 남은 한도 분배. 오늘 창 분석 한 번 + 지난 날 저장값으로 회원 한도를 키 예산에 나눈다 (계획서 v5.7 5.3, K2.T6)
  { name: "budget_rebalance", cron: "* * * * *", run: rebalanceJob },
];

export function registerJobs(rt: Runtime, jobs: readonly JobDef[] = JOBS): void {
  for (const j of jobs) rt.schedule(j.name, j.cron, j.run(rt));
}
