// 주기 작업 목록. Node 는 시작할 때 runtime.schedule 로 프로세스 안 타이머에 걸고, Workers 는 Cron Trigger 가 scheduled() 로 부른다.
// cron 문자열은 wrangler.toml 의 [triggers] crons 와 같아야 한다 (Workers 는 그 cron 으로만 깨어난다).
// 1단계에는 등록할 작업이 없다. 키 정합성 점검(계획서 5.7, 5분마다)이 2단계에서 여기에 붙는다.
import type { Job, Runtime } from "@magnetosphere/runtime/types";

export const JOB_CRON = "*/5 * * * *";

export interface JobDef {
  name: string;
  cron: string;
  run: (rt: Runtime) => Job;
}

export const JOBS: readonly JobDef[] = [];

export function registerJobs(rt: Runtime, jobs: readonly JobDef[] = JOBS): void {
  for (const j of jobs) rt.schedule(j.name, j.cron, j.run(rt));
}
