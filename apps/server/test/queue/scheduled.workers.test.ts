// K1.T4 Workers Cron 분기 (pnpm test:workers). 시험 Worker(test/queue/wrangler.jsonc)를 wrangler dev --test-scheduled 로 띄워
// /__scheduled?cron=… 으로 Cron 호출을 흉내 낸다. 작업은 로컬 D1 의 job_leases 임대 아래에서 돈다.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startWranglerDev, wrangler, type WranglerDev } from "../wrangler-dev.mjs";

const CONFIG = "test/queue/wrangler.jsonc";
const RAN = /\[k1-cron\] ran (k1_every_minute|k1_every_five) fence=\d+/g;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** 지금까지 작업별 실행 기록 수 */
const ran = (d: WranglerDev) => {
  const n = { k1_every_minute: 0, k1_every_five: 0 };
  for (const m of d.output().matchAll(RAN)) n[m[1] as keyof typeof n]++;
  return n;
};

async function cron(d: WranglerDev, expr: string) {
  const res = await fetch(`${d.baseUrl}/__scheduled?cron=${encodeURIComponent(expr)}`);
  await res.arrayBuffer();
  expect(res.status, `/__scheduled?cron=${expr}`).toBe(200);
}

describe("TC-K1.T4.c Workers scheduled 는 받은 cron 의 작업만 돈다", () => {
  it('시험용 작업 둘("* * * * *"·"*/5 * * * *") → "* * * * *" 호출엔 첫 작업만, "*/5 * * * *" 호출엔 둘째만 실행 기록', async () => {
    const persistTo = mkdtempSync(path.join(tmpdir(), "mg-cron-"));
    cleanups.push(() => rmSync(persistTo, { recursive: true, force: true }));
    const mig = wrangler(["d1", "migrations", "apply", "DB", "--local", "--config", CONFIG, "--persist-to", persistTo]);
    expect(mig.code, `${mig.out}${mig.err}`).toBe(0);
    const d = await startWranglerDev({ config: CONFIG, persistTo, vars: {}, testScheduled: true });
    cleanups.push(() => d.close());

    // 대조: 등록하지 않은 cron 호출은 아무것도 돌지 않는다
    await cron(d, "*/2 * * * *");
    await cron(d, "* * * * *");
    await d.waitOutput(RAN, 1);
    expect(ran(d)).toEqual({ k1_every_minute: 1, k1_every_five: 0 });

    await cron(d, "*/5 * * * *");
    await d.waitOutput(RAN, 2);
    expect(ran(d)).toEqual({ k1_every_minute: 1, k1_every_five: 1 });
    // 작업마다 임대를 잡았다 (첫 임대라 fence 1)
    expect(d.output()).toMatch(/ran k1_every_minute fence=1\b/);
    expect(d.output()).toMatch(/ran k1_every_five fence=1\b/);
  });
});
