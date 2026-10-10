// K1.T4 Node 주기 작업: 같은 DB 에 붙은 런타임 둘이 1분 경계마다 하나만 돈다 (pnpm test:db). 시계는 가짜다.
// B 의 타이머는 A 보다 1초 늦게 울린다 (인스턴스마다 타이머·시계가 조금씩 어긋난다). A 가 끝난 뒤 깨어난 B 도 그 경계를 다시 돌면 안 된다.
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeRuntime, type Clock, type NodeRuntime } from "@magnetosphere/runtime/node";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../../../../packages/runtime/test/dbs.ts";
import { registerJobs, type JobDef } from "../../src/jobs.ts";

const MINUTE = 60_000;

/** 손으로 넘기는 시계. view(skew) 는 skew ms 늦은 시계를 보는 인스턴스다 (타이머도 그만큼 늦게 울린다) */
function manualClock(start: number) {
  let t = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    view(skew = 0): Clock {
      return {
        now: () => t - skew,
        setTimeout(fn, ms) {
          timers.set(++seq, { at: t + ms, fn });
          return seq;
        },
        clearTimeout: (id) => void timers.delete(id as number),
      };
    },
    /** to 까지 울릴 타이머를 시각 순서로 울린다 */
    advanceTo(to: number) {
      for (;;) {
        const next = [...timers.entries()].filter(([, x]) => x.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = to;
    },
  };
}

const runtimes: NodeRuntime[] = [];
const dbs: TestDb[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((rt) => rt.close()));
  await Promise.all(dbs.splice(0).map((d) => d.drop()));
});

describe.each(enabledDbs())("%s", (kind: DbKind) => {
  it(`TC-K1.T4.d ${LABEL[kind]}: 런타임 둘, 시험용 "* * * * *" 작업, 가짜 시계 3 경계 → 실행 기록 3, 경계마다 holder 하나`, async () => {
    const db = await createTestDb(kind);
    dbs.push(db);
    const start = Date.UTC(2026, 9, 1, 0, 0, 30);
    const clock = manualClock(start);
    const records: { holder: string; at: number }[] = [];
    const errors: unknown[] = [];
    const job: JobDef = { name: "k1_boundary", cron: "* * * * *", run: () => async ({ lease }) => void records.push({ holder: lease.holder, at: clock.view().now() }) };
    for (const [id, skew] of [["A", 0], ["B", 1_000]] as const) {
      const rt = createNodeRuntime({ env: { DATABASE_URL: db.url }, instanceId: id, clock: clock.view(skew), onJobError: (_n, e) => void errors.push(e) });
      runtimes.push(rt);
      registerJobs(rt, [job]);
    }
    const boundaries = [1, 2, 3].map((k) => Date.UTC(2026, 9, 1, 0, k, 0));
    for (const b of boundaries) {
      clock.advanceTo(b); // A 가 깨어난다
      await sleep(500);
      clock.advanceTo(b + 1_000); // B 가 깨어난다 (A 의 작업은 끝났다)
      await sleep(500);
    }
    expect(errors).toEqual([]);
    expect(records).toHaveLength(3);
    for (const b of boundaries) expect(records.filter((r) => r.at >= b && r.at < b + MINUTE), new Date(b).toISOString()).toHaveLength(1);
  });
});
