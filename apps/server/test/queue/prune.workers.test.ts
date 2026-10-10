// K6.T4 끝난 작업 정리 (Workers + D1, pnpm test:workers). 시험 Worker(test/queue/prune-wrangler.jsonc)를 wrangler dev 로 띄워
// 운영과 같은 pruneDone 을 로컬 D1 에서 부른다. 같은 단언의 Node 네 DB 판은 prune.db.test.ts (K6 리뷰 L2).
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DONE_RETENTION_MS } from "../../src/queue/index.ts";
import { startWranglerDev, wrangler, type WranglerDev } from "../wrangler-dev.mjs";

const CONFIG = "test/queue/prune-wrangler.jsonc";
let d: WranglerDev;
let persistTo: string;
beforeAll(async () => {
  persistTo = mkdtempSync(path.join(tmpdir(), "mg-prune-d1-"));
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

describe("TC-K6.T4.a·c Workers + D1 끝난 작업 정리", () => {
  const now = Date.parse("2026-10-11T00:00:00.000Z");
  const ago = (ms: number) => now - ms;

  it("TC-K6.T4.a Workers + D1: done_at 이 30일 넘은 작업만 지우고 실패·미완료·30일 안 작업은 남긴다, 임대를 잃으면 0행", async () => {
    const row = (doneAt: number | null, failedAt: number | null) => ({ id: randomUUID(), doneAt, failedAt });
    const old = row(ago(DONE_RETENTION_MS + 1_000), null);
    const recent = row(ago(DONE_RETENTION_MS - 1_000), null);
    const failed = row(null, ago(DONE_RETENTION_MS * 3));
    const failedAndDone = row(ago(DONE_RETENTION_MS * 2), ago(DONE_RETENTION_MS * 2));
    const pending = row(null, null);
    await post("/__test/insert", { rows: [old, recent, failed, failedAndDone, pending] });
    const { lease } = await post<{ lease: unknown }>("/__test/lease", { holder: "a", now });
    expect(lease).not.toBeNull();

    expect(await prune(now, lease)).toBe(1);
    expect((await ids()).sort()).toEqual([recent.id, failed.id, failedAndDone.id, pending.id].sort());

    const older = row(ago(DONE_RETENTION_MS * 2), null);
    await post("/__test/insert", { rows: [older] });
    const later = now + 60_000;
    expect((await post<{ lease: unknown }>("/__test/lease", { holder: "b", now: later })).lease).not.toBeNull();
    expect(await prune(later, lease)).toBe(0);
    expect(await ids()).toContain(older.id);
  });

  it("TC-K6.T4.c Workers + D1: 한 번에 최대 500행만 지운다 — 600행이면 500 → 100 → 0", async () => {
    const doneAt = ago(DONE_RETENTION_MS * 2);
    await post("/__test/insert", { rows: Array.from({ length: 600 }, () => ({ id: randomUUID(), doneAt, failedAt: null })) });
    // 지울 대상은 이 600행과 앞 시험에서 남긴 60일 전 끝난 행(older) 하나다
    expect(await prune(now)).toBe(500);
    expect(await prune(now)).toBe(101);
    expect(await prune(now)).toBe(0);
    expect(await ids()).toHaveLength(4);
  });
});
