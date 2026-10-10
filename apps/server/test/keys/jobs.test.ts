// K3.T3 정합성 점검 주기 등록 (DB 없이). wrangler crons 와 JOBS 가 같은지는 TC-K1.T4.b 가 본다 (G-K3.16 이 함께 돈다).
import { describe, expect, it } from "vitest";
import { cronIntervalMinutes, type Job, type Runtime } from "@magnetosphere/runtime/types";
import { JOBS, registerJobs } from "../../src/jobs.ts";

describe("TC-K3.T3.f 정합성 점검은 5분마다 등록된다", () => {
  it('JOBS 의 reconcile cron == "*/5 * * * *" 하나, registerJobs 가 그대로 schedule, 5분 주기', () => {
    expect(JOBS.filter((j) => j.name === "reconcile").map((j) => j.cron)).toEqual(["*/5 * * * *"]);
    const scheduled: { name: string; cron: string; fn: Job }[] = [];
    const rt = { schedule: (name: string, cron: string, fn: Job) => void scheduled.push({ name, cron, fn }), secret: () => undefined } as unknown as Runtime;
    registerJobs(rt);
    const reconcile = scheduled.filter((s) => s.name === "reconcile");
    expect(reconcile.map((s) => s.cron)).toEqual(["*/5 * * * *"]);
    expect(typeof reconcile[0].fn).toBe("function");
    expect(cronIntervalMinutes(reconcile[0].cron)).toBe(5);
  });
});
