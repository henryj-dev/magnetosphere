// K1.T4 주기 작업 등록 (DB 없이). 등록 목록과 Workers Cron 설정이 어긋나지 않는지 본다.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cronIntervalMinutes, type Job, type Runtime } from "@magnetosphere/runtime/types";
import { JOBS, registerJobs } from "../../src/jobs.ts";

/** wrangler.toml 의 최상위 [triggers] crons. 환경([env.*])은 triggers 를 물려받는다 */
function wranglerCrons(): string[] {
  const toml = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
  const section = /^\[triggers\]\s*$([\s\S]*?)(?=^\[)/m.exec(toml);
  const crons = section && /^crons\s*=\s*(\[.*\])\s*$/m.exec(section[1]);
  if (!crons) throw new Error("wrangler.toml 에 [triggers] crons 가 없다");
  expect(toml.match(/crons\s*=/g), "crons 는 한 곳에만 둔다").toHaveLength(1);
  return JSON.parse(crons[1]);
}

describe("TC-K1.T4.a 작업 큐 실행기가 1분 주기로 등록된다 (Q2 의존)", () => {
  it('JOBS 에 name "omniroute_jobs" 하나, cron "* * * * *" → registerJobs 가 그대로 schedule 하고 1분 주기', () => {
    expect(JOBS.filter((j) => j.name === "omniroute_jobs").map((j) => j.cron)).toEqual(["* * * * *"]);
    const scheduled: { name: string; cron: string; fn: Job }[] = [];
    const rt = { schedule: (name: string, cron: string, fn: Job) => void scheduled.push({ name, cron, fn }), secret: () => undefined } as unknown as Runtime;
    registerJobs(rt);
    const queue = scheduled.filter((s) => s.name === "omniroute_jobs");
    expect(queue.map((s) => s.cron)).toEqual(["* * * * *"]);
    expect(typeof queue[0].fn).toBe("function");
    // Node 는 이 cron 을 1분 경계 타이머로, Workers 는 같은 문자열의 Cron Trigger 로 돈다
    expect(cronIntervalMinutes(queue[0].cron)).toBe(1);
    expect(wranglerCrons()).toContain(queue[0].cron);
  });
});

describe("TC-K1.T4.b wrangler crons 집합이 JOBS cron 집합과 같다", () => {
  it("wrangler.toml 의 triggers.crons 집합 == JOBS cron 집합", () => {
    const fromJobs = [...new Set(JOBS.map((j) => j.cron))].sort();
    expect(fromJobs.length).toBeGreaterThan(0);
    expect([...new Set(wranglerCrons())].sort()).toEqual(fromJobs);
  });
});
