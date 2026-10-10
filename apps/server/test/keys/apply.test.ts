// K3.T2 반영: 즉시 실행, 실패하면 큐 (계획서 v5.7 5.2·5.7). SQLite 파일 DB, 가짜 어댑터·시계.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { omnirouteHandlers } from "../../src/queue/handlers.ts";
import { enqueue, KEY_DELETE_DELAY_MS, runDue } from "../../src/queue/index.ts";
import { makeTestEnv, type TestEnv } from "../helpers.ts";
import { addMember } from "../limits/fake.ts";
import { fakeKeys } from "./fake.ts";

let env: TestEnv;
let h: DbHandle;
beforeEach(async () => {
  env = await makeTestEnv();
  h = await connectNode(env.env.DATABASE_URL);
});
afterEach(async () => {
  await h.close();
  env.cleanup();
});

const T0 = new Date("2026-04-10T12:00:00.000Z");

const jobsOf = async (keyId: string, action: string) => {
  const j = h.schema.omnirouteJobs;
  return (await h.db.select().from(j).where(eq(j.keyId, keyId))).filter((r: { action: string }) => r.action === action);
};
const keyOf = async (keyId: string) => (await h.db.select().from(h.schema.apiKeys).where(eq(h.schema.apiKeys.id, keyId)))[0];

describe("TC-K3.T2.f 작업 큐가 삭제 목표 키를 끄면 key.delete 를 끈 뒤 2분으로 잡는다 (V18 의존)", () => {
  it("state deleted 키의 key.apply_state 실행 → setKeyActive(false) 1건, key.delete 작업 next_run_at − 끈 시각 == 120,000ms, sync_state synced", async () => {
    const { keyIds } = await addMember(h, 5, [{ ork: "ork-del", state: "deleted" }]);
    const keyId = keyIds["ork-del"];
    const om = fakeKeys();
    om.add("ork-del", { isActive: true });
    await enqueue(h, "key.apply_state", { keyId }, { now: T0 });
    const r = await runDue(h, omnirouteHandlers(() => om.client()), T0);
    expect(r.done).toBe(1);
    expect(om.seq()).toEqual(["setKeyActive(false)"]);
    const del = await jobsOf(keyId, "key.delete");
    expect(del.map((d: { nextRunAt: Date }) => d.nextRunAt.getTime() - T0.getTime())).toEqual([KEY_DELETE_DELAY_MS]);
    expect((await keyOf(keyId)).syncState).toBe("synced");
  });
});
