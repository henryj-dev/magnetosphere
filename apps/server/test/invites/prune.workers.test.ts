// 만료·취소한 초대 정리 (M3.T3) — Workers + D1 (pnpm test:workers). 시험 Worker(test/invites/prune-wrangler.jsonc)를 wrangler dev 로 띄워
// 운영과 같은 pruneInvites 를 로컬 D1 에서 부른다. 같은 단언의 Node 네 DB 판은 prune.db.test.ts ("지움 2·남음 6", prune-checks.ts).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWranglerDev, wrangler, type WranglerDev } from "../wrangler-dev.mjs";
import { T3_NOW, t3aRows } from "./prune-checks.ts";

const CONFIG = "test/invites/prune-wrangler.jsonc";
let d: WranglerDev;
let persistTo: string;
beforeAll(async () => {
  persistTo = mkdtempSync(path.join(tmpdir(), "mg-invite-prune-d1-"));
  const mig = wrangler(["d1", "migrations", "apply", "DB", "--local", "--config", CONFIG, "--persist-to", persistTo]);
  expect(mig.code, `${mig.out}${mig.err}`).toBe(0);
  d = await startWranglerDev({ config: CONFIG, persistTo, vars: {} });
});
afterAll(async () => {
  await d?.close();
  if (persistTo) rmSync(persistTo, { recursive: true, force: true });
});

async function post<T>(p: string, body: unknown): Promise<T> {
  const r = await fetch(`${d.baseUrl}${p}`, { method: "POST", body: JSON.stringify(body) });
  expect(r.status, `${p} ${await r.clone().text()}`).toBe(200);
  return (await r.json()) as T;
}
const ids = async () => ((await (await fetch(`${d.baseUrl}/__test/ids`)).json()) as { ids: string[] }).ids;
const prune = async (now: number, lease?: unknown) => (await post<{ deleted: number }>("/__test/prune", { now, lease })).deleted;

describe("TC-M3.T3 Workers + D1 만료·취소한 초대 정리", () => {
  it("TC-M3.T3.a Workers + D1: 만료 31일·만료 29일·취소 31일·사용됨 90일·유효 + 차지 중 31일·사용·취소·취소 29일(미사용·만료 미래) → 지움 2·남음 6, 임대를 잃으면 0행", async () => {
    const { drop, keep } = t3aRows();
    await post("/__test/insert", { rows: [...Object.values(drop), ...Object.values(keep)] });
    const { lease } = await post<{ lease: unknown }>("/__test/lease", { holder: "a", now: T3_NOW });
    expect(lease).not.toBeNull();
    expect(await prune(T3_NOW, lease)).toBe(2);
    expect((await ids()).sort()).toEqual(Object.values(keep).map((r) => r.id).sort());
    expect(await prune(T3_NOW, lease)).toBe(0);
    const later = T3_NOW + 60_000;
    const extra = t3aRows().drop.expired31;
    await post("/__test/insert", { rows: [extra] });
    expect((await post<{ lease: unknown }>("/__test/lease", { holder: "b", now: later })).lease).not.toBeNull();
    expect(await prune(later, lease)).toBe(0);
    expect(await ids()).toContain(extra.id);
    expect(await prune(later)).toBe(1);
  });
});
