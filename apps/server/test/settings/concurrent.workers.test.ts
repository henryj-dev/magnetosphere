// TC-M1.T1.d 같은 키 동시 쓰기 (Workers + D1, pnpm test:workers). 시험 Worker(test/settings/concurrent-wrangler.jsonc)를
// wrangler dev 로 띄워 운영과 같은 설정 쓰기 둘을 로컬 D1 에서 요청 20건으로 동시에 부른다. Node 네 DB 판은 concurrent.db.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWranglerDev, wrangler, type WranglerDev } from "../wrangler-dev.mjs";

const CONFIG = "test/settings/concurrent-wrangler.jsonc";
const N = 20;
let d: WranglerDev;
let persistTo: string;
beforeAll(async () => {
  persistTo = mkdtempSync(path.join(tmpdir(), "mg-settings-d1-"));
  const mig = wrangler(["d1", "migrations", "apply", "DB", "--local", "--config", CONFIG, "--persist-to", persistTo]);
  expect(mig.code, `${mig.out}${mig.err}`).toBe(0);
  d = await startWranglerDev({ config: CONFIG, persistTo, vars: {} });
});
afterAll(async () => {
  await d?.close();
  if (persistTo) rmSync(persistTo, { recursive: true, force: true });
});

const write = async (via: "settings" | "setup", key: string, value: unknown) => {
  const r = await fetch(`${d.baseUrl}/__test/write`, { method: "POST", body: JSON.stringify({ via, key, value }) });
  return r.status === 200 ? null : `${r.status} ${(await r.text()).slice(0, 200)}`;
};
const values = async (key: string) => ((await (await fetch(`${d.baseUrl}/__test/rows?key=${key}`)).json()) as { values: unknown[] }).values;

describe("TC-M1.T1.d Workers + D1 동시 설정 쓰기", () => {
  it(`TC-M1.T1.d Workers + D1: 같은 키에 쓰기 ${N}건 동시 → 실패 0·행 정확히 1·값은 ${N}개 중 하나 (설정 저장소·설치 쓰기)`, async () => {
    const caps = Array.from({ length: N }, (_, i) => i);
    expect((await Promise.all(caps.map((v) => write("settings", "daily_signup_cap", v)))).filter(Boolean), "writeSetting 실패").toEqual([]);
    const cap = await values("daily_signup_cap");
    expect(cap).toHaveLength(1);
    expect(caps).toContain(cap[0]);

    expect(await write("setup", "public_base_url", "https://first.example")).toBeNull();
    const urls = Array.from({ length: N }, (_, i) => `https://llm-${i}.example`);
    expect((await Promise.all(urls.map((u) => write("setup", "public_base_url", u)))).filter(Boolean), "설치 writeSetting 실패").toEqual([]);
    const url = await values("public_base_url");
    expect(url).toHaveLength(1);
    expect(urls).toContain(url[0]);
  });
});
