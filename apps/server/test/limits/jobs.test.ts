// K2.T6 1분 분배 등록. 등록 목록과 Workers Cron 설정(wrangler.toml)이 어긋나지 않는지 본다 (TC-K1.T4.b 와 같은 규칙).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cronIntervalMinutes, type Job, type Runtime } from "@magnetosphere/runtime/types";
import { JOBS, registerJobs } from "../../src/jobs.ts";

function wranglerCrons(): string[] {
  const toml = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
  const section = /^\[triggers\]\s*$([\s\S]*?)(?=^\[)/m.exec(toml);
  const crons = section && /^crons\s*=\s*(\[.*\])\s*$/m.exec(section[1]);
  if (!crons) throw new Error("wrangler.toml 에 [triggers] crons 가 없다");
  return JSON.parse(crons[1]);
}

describe("TC-K2.T6.i 분배는 1분마다 등록된다", () => {
  it('JOBS 의 budget_rebalance cron == "* * * * *" 하나, registerJobs 가 그대로 schedule, wrangler crons 에 "* * * * *" 포함', () => {
    expect(JOBS.filter((j) => j.name === "budget_rebalance").map((j) => j.cron)).toEqual(["* * * * *"]);
    const scheduled: { name: string; cron: string; fn: Job }[] = [];
    const rt = { schedule: (name: string, cron: string, fn: Job) => void scheduled.push({ name, cron, fn }), secret: () => undefined } as unknown as Runtime;
    registerJobs(rt);
    const rebalance = scheduled.filter((s) => s.name === "budget_rebalance");
    expect(rebalance.map((s) => s.cron)).toEqual(["* * * * *"]);
    expect(typeof rebalance[0].fn).toBe("function");
    expect(cronIntervalMinutes(rebalance[0].cron)).toBe(1);
    expect(wranglerCrons()).toContain("* * * * *");
  });
});
