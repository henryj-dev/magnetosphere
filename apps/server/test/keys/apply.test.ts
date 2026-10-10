// K3.T2 반영: 즉시 실행, 실패하면 큐 (계획서 v5.7 5.2·5.7). SQLite 파일 DB, 가짜 어댑터·시계.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OmniRouteError } from "@magnetosphere/omniroute";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { applyKey, KeyConflictError, requestEnable } from "../../src/keys/apply.ts";
import { CONFIRMED_KEY } from "../../src/limits/daily.ts";
import { writeSetting } from "../../src/limits/store.ts";
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

describe("TC-K3.T2.a 끄기는 응답 전에 OmniRoute 에 반영된다", () => {
  it("applyKey(목표 off: 회원이 끈 키) → 돌아오기 전에 setKeyActive(false) 1건, sync_state synced, 큐 작업 0", async () => {
    const { keyIds } = await addMember(h, null, [{ ork: "ork-a", state: "disabled", reason: "member" }]);
    const keyId = keyIds["ork-a"];
    const om = fakeKeys();
    om.add("ork-a", { isActive: true });
    const r = await applyKey(h, keyId, { client: () => om.client(), now: T0 });
    expect(om.seq()).toEqual(["setKeyActive(false)"]);
    expect(om.keys.get("ork-a")?.isActive).toBe(false);
    expect(r).toEqual({ target: "off", syncState: "synced", calls: 1 });
    expect((await keyOf(keyId)).syncState).toBe("synced");
    expect(await jobsOf(keyId, "key.apply_state")).toEqual([]);
  });
});

describe("TC-K3.T2.b OmniRoute 실패면 반영 중으로 남고 1분 뒤 재시도가 잡힌다 (Q2 의존)", () => {
  it("setKeyActive → OmniRouteError 503 → sync_state pending, key.apply_state 작업 1개, next_run_at − now == 60,000ms", async () => {
    const { keyIds } = await addMember(h, null, [{ ork: "ork-b", state: "disabled", reason: "member" }]);
    const keyId = keyIds["ork-b"];
    const om = fakeKeys();
    om.add("ork-b", { isActive: true });
    om.fail.setKeyActive = [new OmniRouteError("PATCH", "/keys", 503, null, "unavailable")];
    const r = await applyKey(h, keyId, { client: () => om.client(), now: T0 });
    expect(r.syncState).toBe("pending");
    expect((await keyOf(keyId)).syncState).toBe("pending");
    const jobs = await jobsOf(keyId, "key.apply_state");
    expect(jobs.map((j: { nextRunAt: Date }) => j.nextRunAt.getTime() - T0.getTime())).toEqual([60_000]);
    // 그 작업이 돌면 끈다
    await runDue(h, omnirouteHandlers(() => om.client()), new Date(T0.getTime() + 60_000));
    expect(om.keys.get("ork-b")?.isActive).toBe(false);
    expect((await keyOf(keyId)).syncState).toBe("synced");
  });
});

describe("TC-K3.T2.c 목표가 켜짐이 아니면 켜지 않는다", () => {
  it("회원 suspended, 키 disabled_reason member → 회원이 켜기 요청 → 409, setKeyActive 0건, 키 행 그대로", async () => {
    const { keyIds } = await addMember(h, null, [{ ork: "ork-c", state: "disabled", reason: "member" }], "suspended");
    const keyId = keyIds["ork-c"];
    const om = fakeKeys();
    om.add("ork-c", { isActive: false });
    const err = await requestEnable(h, keyId, "member", { client: () => om.client(), now: T0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeyConflictError);
    expect((err as KeyConflictError).status).toBe(409);
    expect(om.calls).toEqual([]);
    expect(await keyOf(keyId)).toMatchObject({ state: "disabled", disabledReason: "member" });
    // 관리자가 끈 키도 회원은 켜지 못한다. 정지가 풀린 회원이 자기가 끈 키는 켤 수 있다
    const other = await addMember(h, null, [{ ork: "ork-c2", state: "disabled", reason: "admin" }]);
    await expect(requestEnable(h, other.keyIds["ork-c2"], "member", { client: () => om.client(), now: T0 })).rejects.toBeInstanceOf(KeyConflictError);
    expect(om.calls).toEqual([]);
  });
});

describe("TC-K3.T2.d 켜기 전에 예산을 건다", () => {
  it("정지가 풀린 회원(월 한도 5, 사용 1)의 user_status 키 → 어댑터 호출 순서 == [getAnalytics, setBudget, setKeyActive(true)]", async () => {
    await writeSetting(h, CONFIRMED_KEY, "2026-04-10", T0);
    const { keyIds } = await addMember(h, 5, [{ ork: "ork-d", state: "disabled", reason: "user_status" }]);
    const keyId = keyIds["ork-d"];
    const om = fakeKeys();
    om.add("ork-d", { isActive: false });
    om.costs = { "ork-d": 1 };
    const r = await applyKey(h, keyId, { client: () => om.client(), now: T0 });
    expect(om.seq()).toEqual(["getAnalytics", "setBudget", "setKeyActive(true)"]);
    expect(om.of("setBudget")[0].value).toBe(5);
    expect(r).toMatchObject({ target: "on", syncState: "synced" });
    expect(await keyOf(keyId)).toMatchObject({ state: "active", disabledReason: null, syncState: "synced" });
  });
});

describe("TC-K3.T2.e 삭제는 끄기 먼저, DELETE 는 끈 뒤 2분이 지나서다 (V18 의존)", () => {
  it("목표 삭제됨 → 돌아오기 전 setKeyActive(false) 1건·deleteKey 0건, key.delete next_run_at − 끈 시각 == 120,000ms → 그 작업 실행 → deleteKey 1건, 행은 남음", async () => {
    const { keyIds } = await addMember(h, 5, [{ ork: "ork-e", state: "deleted" }]);
    const keyId = keyIds["ork-e"];
    const om = fakeKeys();
    om.add("ork-e", { isActive: true });
    await applyKey(h, keyId, { client: () => om.client(), now: T0 });
    expect(om.seq()).toEqual(["setKeyActive(false)"]);
    const del = await jobsOf(keyId, "key.delete");
    expect(del.map((d: { nextRunAt: Date }) => d.nextRunAt.getTime() - T0.getTime())).toEqual([120_000]);
    // 30초 뒤 한 번 더 반영(이미 꺼짐)해도 key.delete 를 겹쳐 넣지 않는다. 다시 끈 것이 아니므로 시각도 그대로다
    await applyKey(h, keyId, { client: () => om.client(), now: new Date(T0.getTime() + 30_000), actual: false });
    expect((await jobsOf(keyId, "key.delete")).map((d: { nextRunAt: Date }) => d.nextRunAt.getTime() - T0.getTime())).toEqual([120_000]);
    // 끈 뒤 90초(차례 유예 30초 포함)가 지나기 전에는 집히지 않는다
    await runDue(h, omnirouteHandlers(() => om.client()), new Date(T0.getTime() + 89_000));
    expect(om.of("deleteKey")).toEqual([]);
    await runDue(h, omnirouteHandlers(() => om.client()), new Date(T0.getTime() + 120_000));
    expect(om.of("deleteKey")).toEqual([{ fn: "deleteKey", id: "ork-e" }]);
    expect(om.keys.has("ork-e")).toBe(false);
    expect((await keyOf(keyId)).state).toBe("deleted");
  });
});
