// K3.T3 정합성 점검 (계획서 v5.7 5.7·5.8, Q3·Q6). SQLite 파일 DB, 가짜 어댑터·시계. 실제 OmniRoute 는 test/contract/keys.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { holdLease } from "@magnetosphere/runtime/lease";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { reconcile } from "../../src/keys/reconcile.ts";
import { omnirouteHandlers } from "../../src/queue/handlers.ts";
import { enqueue, runDue } from "../../src/queue/index.ts";
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
const k = () => h.schema.apiKeys;
const keyOf = async (keyId: string) => (await h.db.select().from(k()).where(eq(k().id, keyId)))[0];
const alertsOf = async (action: string) => (await h.db.select().from(h.schema.auditLog)).filter((r: { action: string }) => r.action === action);

describe("TC-K3.T3.b 매핑 없는 m_ 키는 알리기만 한다 (Q6 의존)", () => {
  it("OmniRoute 에 m_deadbeef_cafebabe(매핑 없음)·다른 이름 키 → alert.unknown_m_key 1행(target 그 키 id), deleteKey·setKeyActive 0건. 같은 날 다시 돌아도 1행", async () => {
    const om = fakeKeys();
    om.add("or-unknown", { name: "m_deadbeef_cafebabe", isActive: true });
    om.add("or-operator", { name: "operator-key", isActive: true });
    const r = await reconcile({ db: h, client: () => om.client(), now: T0 });
    expect(r).toMatchObject({ keys: 2, unknown: 1, alerts: 1 });
    const alerts = await alertsOf("alert.unknown_m_key");
    expect(alerts.map((a: { target: string }) => a.target)).toEqual(["or-unknown"]);
    expect(om.of("deleteKey")).toEqual([]);
    expect(om.of("setKeyActive")).toEqual([]);
    expect([...om.keys.values()].map((x) => x.isActive)).toEqual([true, true]);
    // 5분 뒤 다시 돌아도 같은 알림을 쌓지 않는다. 다음 날에는 다시 한 번
    await reconcile({ db: h, client: () => om.client(), now: new Date(T0.getTime() + 5 * 60_000) });
    expect(await alertsOf("alert.unknown_m_key")).toHaveLength(1);
    await reconcile({ db: h, client: () => om.client(), now: new Date(T0.getTime() + 86_400_000) });
    expect(await alertsOf("alert.unknown_m_key")).toHaveLength(2);
  });
});

describe("TC-K3.T3.d 점검은 임대를 잃으면 멈춘다", () => {
  it("어긋난 키 셋, 첫 setKeyActive 도중 renewLease false → 그 뒤 setKeyActive·deleteKey 0건, 점검은 실패로 끝난다", async () => {
    const { keyIds } = await addMember(h, null, [
      { ork: "ork-1", state: "disabled", reason: "member" },
      { ork: "ork-2", state: "disabled", reason: "member" },
      { ork: "ork-3", state: "deleted" },
    ]);
    const om = fakeKeys();
    for (const id of Object.keys(keyIds)) om.add(id, { isActive: true });
    let signal!: AbortSignal;
    const afterLoss: string[] = [];
    let held = false;
    om.before = async (call) => {
      if (signal.aborted) afterLoss.push(call.fn);
      // 첫 끄기가 OmniRoute 에 가 있는 동안 하트비트가 임대를 잃는다
      if (call.fn === "setKeyActive" && !held) {
        held = true;
        await new Promise((r) => signal.addEventListener("abort", r, { once: true }));
      }
    };
    const run = holdLease(
      async () => false,
      300,
      async (s) => {
        signal = s;
        await reconcile({ db: h, client: () => om.client(), now: T0, signal: s });
      },
    );
    await expect(run).rejects.toThrow();
    expect(afterLoss).toEqual([]);
    expect(om.of("setKeyActive")).toHaveLength(1);
    expect(om.of("deleteKey")).toEqual([]);
    // 나머지 키는 다음 점검(다른 인스턴스)이 맞춘다
    expect([om.keys.get("ork-2")?.isActive, om.keys.get("ork-3")?.isActive]).toEqual([true, true]);
  });
});

describe("TC-K3.T3.g 재시도를 다 쓴 키도 점검이 다시 맞춘다 (Q3 의존)", () => {
  it("sync_state failed 인 키(목표 off, OmniRoute isActive true) → reconcile 1회 → setKeyActive(false) 1건, sync_state synced", async () => {
    const { keyIds } = await addMember(h, null, [{ ork: "ork-g", state: "disabled", reason: "member" }]);
    const keyId = keyIds["ork-g"];
    await h.db.update(k()).set({ syncState: "failed" }).where(eq(k().id, keyId));
    const om = fakeKeys();
    om.add("ork-g", { isActive: true });
    const r = await reconcile({ db: h, client: () => om.client(), now: T0 });
    expect(om.seq()).toEqual(["listKeys", "setKeyActive(false)"]);
    expect(r).toMatchObject({ applied: 1, failed: 0 });
    expect((await keyOf(keyId)).syncState).toBe("synced");
    // 이미 맞는 failed 키는 부르지 않고 synced 로만 적는다
    const other = await addMember(h, null, [{ ork: "ork-g2", state: "disabled", reason: "member" }]);
    await h.db.update(k()).set({ syncState: "failed" }).where(eq(k().id, other.keyIds["ork-g2"]));
    om.add("ork-g2", { isActive: false });
    om.calls.length = 0;
    await reconcile({ db: h, client: () => om.client(), now: T0 });
    expect(om.seq()).toEqual(["listKeys"]);
    expect((await keyOf(other.keyIds["ork-g2"])).syncState).toBe("synced");
  });
});

describe("TC-K3.T3.h 작업 큐가 남긴 어긋남(다시 읽기 상한·늦게 적힌 실패)을 점검이 맞춘다 (K1 메모)", () => {
  it("① 반영 중 목표가 매번 바뀌어 핸들러가 다시 읽기 상한에서 끝남 ② 재시도가 10분 뒤로 잡힌 꺼야 할 키 → reconcile 1회 → 둘 다 목표대로, synced", async () => {
    // ① 핸들러가 걸 때마다 요청이 목표를 뒤집는다. 핸들러는 상한에서 멈추고 OmniRoute 는 목표와 다르다
    const a = await addMember(h, null, [{ ork: "ork-flip" }]);
    const flipId = a.keyIds["ork-flip"];
    const om = fakeKeys();
    om.add("ork-flip", { isActive: false });
    let flipping = true;
    om.before = async (call) => {
      if (!flipping || call.fn !== "setKeyActive") return;
      const row = await keyOf(flipId);
      const off = row.state === "active";
      await h.db.update(k()).set(off ? { state: "disabled", disabledReason: "member" } : { state: "active", disabledReason: null }).where(eq(k().id, flipId));
    };
    await enqueue(h, "key.apply_state", { keyId: flipId }, { now: T0 });
    const q = await runDue(h, omnirouteHandlers(() => om.client()), T0);
    expect(q.done).toBe(1);
    flipping = false;
    const want = (await keyOf(flipId)).state === "active";
    expect(om.keys.get("ork-flip")?.isActive, "큐가 남긴 어긋남").toBe(!want);
    expect((await keyOf(flipId)).syncState).toBe("pending");

    // ② 끄기 실패가 늦게 적혀 다음 시도가 10분 뒤인 키. OmniRoute 는 아직 켜져 있다
    const b = await addMember(h, null, [{ ork: "ork-late", state: "disabled", reason: "member" }]);
    const lateId = b.keyIds["ork-late"];
    om.add("ork-late", { isActive: true });
    await h.db.update(k()).set({ syncState: "pending" }).where(eq(k().id, lateId));
    await enqueue(h, "key.apply_state", { keyId: lateId }, { runAt: new Date(T0.getTime() + 10 * 60_000) });

    om.calls.length = 0;
    const r = await reconcile({ db: h, client: () => om.client(), now: new Date(T0.getTime() + 60_000) });
    expect(r).toMatchObject({ applied: 2, failed: 0 });
    expect(om.keys.get("ork-flip")?.isActive).toBe(want);
    expect(om.keys.get("ork-late")?.isActive).toBe(false);
    expect([(await keyOf(flipId)).syncState, (await keyOf(lateId)).syncState]).toEqual(["synced", "synced"]);
  });
});
