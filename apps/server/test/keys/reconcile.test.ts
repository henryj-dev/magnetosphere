// K3.T3 정합성 점검 (계획서 v5.7 5.7·5.8, Q3·Q6). SQLite 파일 DB, 가짜 어댑터·시계. 실제 OmniRoute 는 test/contract/keys.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { holdLease } from "@magnetosphere/runtime/lease";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { KeyConflictError, requestEnable } from "../../src/keys/apply.ts";
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
    // 목록으로는 이미 맞아 보이는 failed 키도 목록 값(옛 값일 수 있다)을 믿지 않고 한 번 다시 건다 (리뷰 #4)
    const other = await addMember(h, null, [{ ork: "ork-g2", state: "disabled", reason: "member" }]);
    await h.db.update(k()).set({ syncState: "failed" }).where(eq(k().id, other.keyIds["ork-g2"]));
    om.add("ork-g2", { isActive: false });
    om.calls.length = 0;
    await reconcile({ db: h, client: () => om.client(), now: T0 });
    expect(om.seq()).toEqual(["listKeys", "setKeyActive(false)"]);
    expect((await keyOf(other.keyIds["ork-g2"])).syncState).toBe("synced");
    // synced 가 된 뒤에는 목록이 맞으면 부르지 않는다
    om.calls.length = 0;
    await reconcile({ db: h, client: () => om.client(), now: T0 });
    expect(om.seq()).toEqual(["listKeys"]);
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

describe("TC-K3.T3.i manage 범위 키는 꺼진 이유와 상관없이 admin 으로 고정한다 (리뷰 #1, V10)", () => {
  it("회원이 끈 키(member)에 scopes [manage] → reconcile → disabled_reason admin, 회원 켜기 요청 409", async () => {
    const { keyIds } = await addMember(h, null, [{ ork: "ork-mm", state: "disabled", reason: "member" }]);
    const keyId = keyIds["ork-mm"];
    const om = fakeKeys();
    om.add("ork-mm", { isActive: false, scopes: ["manage"] });
    await reconcile({ db: h, client: () => om.client(), now: T0 });
    expect(await keyOf(keyId)).toMatchObject({ state: "disabled", disabledReason: "admin" });
    expect(await alertsOf("alert.manage_scope_key")).toHaveLength(1);
    await expect(requestEnable(h, keyId, "member", { client: () => om.client(), now: T0 })).rejects.toBeInstanceOf(KeyConflictError);
    expect(om.of("setKeyActive")).toEqual([]);
  });
});

describe("TC-K3.T3.j 점검은 시간 예산 안에서 멈추고 다음 실행이 이어 가며, 끊겨도 꺼진 키의 알림은 남는다 (리뷰 #2)", () => {
  it("어긋난 키 다섯·한 실행에 셋 → 두 실행이면 다섯 모두 맞춤. manage 키를 끈 뒤 임대를 잃어도 alert.manage_scope_key 가 남는다", async () => {
    const { keyIds } = await addMember(
      h,
      null,
      ["k1", "k2", "k3", "k4", "k5"].map((ork) => ({ ork, state: "disabled" as const, reason: "member" })),
    );
    const om = fakeKeys();
    for (const id of Object.keys(keyIds)) om.add(id, { isActive: true });
    // 시계는 읽을 때마다 100ms 간다. 시간 예산 350ms 면 한 실행에 키 셋
    let t = T0.getTime();
    const clock = () => (t += 100);
    const first = await reconcile({ db: h, client: () => om.client(), now: T0, clock, budgetMs: 350 });
    expect(first.stopped).toBe(true);
    const second = await reconcile({ db: h, client: () => om.client(), now: T0, clock, budgetMs: 350 });
    expect(second.stopped).toBe(false);
    expect([...om.keys.values()].map((k) => [k.id, k.isActive])).toEqual(["k1", "k2", "k3", "k4", "k5"].map((id) => [id, false]));

    // 끊김: manage 키를 끈 다음 키에서 임대를 잃는다
    const om2 = fakeKeys();
    om2.add("a-manage", { name: "m_deadbeef_00000001", isActive: true, scopes: ["manage"] });
    const b = await addMember(h, null, [{ ork: "b-key", state: "disabled", reason: "member" }, { ork: "c-key", state: "disabled", reason: "member" }]);
    void b;
    om2.add("b-key", { isActive: true });
    om2.add("c-key", { isActive: true });
    const ac = new AbortController();
    om2.before = (call) => {
      if (call.fn === "setKeyActive" && call.id === "b-key") ac.abort(new Error("임대를 잃었다"));
    };
    await expect(reconcile({ db: h, client: () => om2.client(), now: T0, signal: ac.signal })).rejects.toThrow();
    expect(om2.keys.get("a-manage")?.isActive).toBe(false);
    expect((await alertsOf("alert.manage_scope_key")).map((a: { target: string }) => a.target)).toEqual(["a-manage"]);
  });
});

describe("TC-K3.T3.m 옛 목록 값으로 synced 를 적지 않는다 (리뷰 #4)", () => {
  it("sync_state pending·목표 off 키, 목록은 isActive false(옛 값)지만 실제는 켜짐 → reconcile 이 setKeyActive(false) 를 부른다", async () => {
    const { keyIds } = await addMember(h, null, [{ ork: "ork-stale", state: "disabled", reason: "member" }]);
    const keyId = keyIds["ork-stale"];
    await h.db.update(k()).set({ syncState: "pending" }).where(eq(k().id, keyId));
    const om = fakeKeys();
    om.add("ork-stale", { isActive: true });
    const stale = () => ({ ...om.client(), listKeys: async () => [{ id: "ork-stale", name: "m_x", isActive: false, scopes: [] }] });
    await reconcile({ db: h, client: stale as never, now: T0 });
    expect(om.seq()).toEqual(["setKeyActive(false)"]);
    expect(om.keys.get("ork-stale")?.isActive).toBe(false);
    expect((await keyOf(keyId)).syncState).toBe("synced");
  });
});

describe("TC-K3.T3.n disabled 인데 이유가 없는 키는 alert.key_stuck 을 하루 한 번 남긴다 (리뷰 #8)", () => {
  it("state disabled·disabled_reason NULL 키 → reconcile 두 번(같은 날) → alert.key_stuck 1행(target 그 키), 켜지 않는다", async () => {
    const { keyIds } = await addMember(h, null, [{ ork: "ork-stuck", state: "disabled", reason: null }]);
    void keyIds;
    const om = fakeKeys();
    om.add("ork-stuck", { isActive: false });
    await reconcile({ db: h, client: () => om.client(), now: T0 });
    await reconcile({ db: h, client: () => om.client(), now: new Date(T0.getTime() + 5 * 60_000) });
    expect((await alertsOf("alert.key_stuck")).map((a: { target: string }) => a.target)).toEqual(["ork-stuck"]);
    expect(om.of("setKeyActive")).toEqual([]);
  });
});
