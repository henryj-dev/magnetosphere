// K1 리뷰 #1: 키별 순서. 오래된 "켜기" 재시도가 그 뒤의 "끄기"를 덮지 않는다 (pnpm test:db, 네 DB).
// key.apply_state 는 넣을 때의 값이 아니라 실행할 때 api_keys·회원 상태로 다시 계산한 목표를 건다.
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OmniRouteError, type OmniRouteClient } from "@magnetosphere/omniroute";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../../../../packages/runtime/test/dbs.ts";
import { omnirouteHandlers } from "../../src/queue/handlers.ts";
import { ACTIONS, CLAIM_MS, enqueue, runDue, type Handlers } from "../../src/queue/index.ts";

/** OmniRoute 키 켜짐 상태 하나. failNext 번 만큼 503 */
function fakeOmniRoute() {
  const state = { active: new Map<string, boolean>(), failNext: 0, calls: [] as string[] };
  const client = {
    async setKeyActive(id: string, active: boolean) {
      state.calls.push(`setKeyActive(${active})`);
      if (state.failNext > 0) {
        state.failNext--;
        throw new OmniRouteError("PATCH", "/keys", 503, null, "unavailable");
      }
      state.active.set(id, active);
    },
    async deleteKey(id: string) {
      state.calls.push("deleteKey");
      state.active.delete(id);
    },
    async setBudget() {
      state.calls.push("setBudget");
    },
  } as unknown as OmniRouteClient;
  return { state, client };
}

describe.each(enabledDbs())("%s", (kind: DbKind) => {
  let t: TestDb;
  let h: DbHandle;
  beforeAll(async () => {
    t = await createTestDb(kind);
    h = await connectNode(t.url);
  });
  afterAll(async () => {
    await h?.close();
    await t?.drop();
  });

  async function activeKey(): Promise<{ keyId: string; ork: string }> {
    const userId = randomUUID();
    const keyId = randomUUID();
    const ork = `ork-${keyId}`;
    await h.db.insert(h.schema.user).values({ id: userId, name: "order", email: `order-${userId}@example.com` });
    await h.db.insert(h.schema.apiKeys).values({ id: keyId, userId, omnirouteKeyId: ork, keyPreview: "abcd", state: "active", createdAt: new Date() });
    return { keyId, ork };
  }
  const disableByMember = (keyId: string) =>
    h.db.update(h.schema.apiKeys).set({ state: "disabled", disabledReason: "member" }).where(eq(h.schema.apiKeys.id, keyId));
  const pendingFor = async (keyId: string) => {
    const j = h.schema.omnirouteJobs;
    const rows = await h.db.select({ id: j.id, payload: j.payload }).from(j).where(and(isNull(j.doneAt), isNull(j.failedAt)));
    return rows.filter((r: { payload: string }) => r.payload.includes(keyId));
  };

  it(`TC-K1.T3.f ${LABEL[kind]}: 켜기 503 → T0+30초 끄기 성공 → T0+1분 옛 켜기 재시도 → 꺼진 채, CLAIM_MS 뒤 다시 집혀도 꺼진 채`, async () => {
    const om = fakeOmniRoute();
    const handlers = omnirouteHandlers(() => om.client);
    const T0 = new Date("2026-10-01T00:00:00.000Z");

    // 1) 키가 켜져 있어야 할 때 넣은 반영 작업이 503 으로 실패 → T0+1분 재시도 예약
    const a = await activeKey();
    const first = await enqueue(h, "key.apply_state", { keyId: a.keyId, omnirouteKeyId: a.ork, active: true }, { now: T0 });
    om.state.failNext = 1;
    await runDue(h, handlers, T0);
    // 2) T0+30초: 회원이 키를 끈다. 요청 안에서 바로 끄기 성공, 같은 키의 반영 작업은 하나로 합친다
    await disableByMember(a.keyId);
    await om.client.setKeyActive(a.ork, false);
    const again = await enqueue(h, "key.apply_state", { keyId: a.keyId, omnirouteKeyId: a.ork, active: false }, { now: new Date(T0.getTime() + 30_000) });
    expect(again, "같은 키의 미완료 반영 작업에 합친다").toBe(first);
    expect(await pendingFor(a.keyId)).toHaveLength(1);
    // 3) T0+1분: 옛 재시도가 돈다
    await runDue(h, handlers, new Date(T0.getTime() + 60_000));
    expect(om.state.active.get(a.ork), `호출 ${om.state.calls.join(", ")}`).toBe(false);
    expect(await pendingFor(a.keyId)).toHaveLength(0);

    // 4) 차지한 실행기가 멈춘(죽은) 채 CLAIM_MS 가 지나 다른 실행기가 다시 집는 경우
    const b = await activeKey();
    const T1 = new Date(T0.getTime() + 3_600_000);
    await enqueue(h, "key.apply_state", { keyId: b.keyId, omnirouteKeyId: b.ork, active: true }, { now: T1 });
    let release!: () => void;
    const stuck = new Promise<void>((r) => (release = r));
    const hang = Object.fromEntries(ACTIONS.map((act) => [act, () => stuck])) as unknown as Handlers;
    const dead = runDue(h, hang, T1);
    await new Promise((r) => setTimeout(r, 200));
    await disableByMember(b.keyId);
    await om.client.setKeyActive(b.ork, false);
    await runDue(h, handlers, new Date(T1.getTime() + CLAIM_MS));
    expect(om.state.active.get(b.ork)).toBe(false);
    // 깨어난 옛 실행기의 완료 쓰기는 0행이다 (차지가 바뀌었다)
    release();
    await dead;
    expect(om.state.active.get(b.ork)).toBe(false);
  });

  it(`TC-K1.T3.j ${LABEL[kind]}: 실행 중인 반영 작업에 끄기가 합쳐져도 키가 꺼진다 (핸들러가 켜기를 건 뒤·완료 쓰기 전에 회원이 끔)`, async () => {
    const om = fakeOmniRoute();
    const real = omnirouteHandlers(() => om.client);
    const T0 = new Date("2026-10-02T00:00:00.000Z");
    const a = await activeKey();
    om.state.active.set(a.ork, true);
    const first = await enqueue(h, "key.apply_state", { keyId: a.keyId }, { now: T0 });
    let hooked = false;
    // 핸들러가 목표 on 을 읽고 켜기를 건 뒤(다시 읽어도 on) 돌아온 직후, 완료 쓰기 전에 요청 쪽이 끈다. 즉시 반영은 503 → enqueue
    const handlers: Handlers = {
      ...real,
      async "key.apply_state"(p, ctx) {
        await real["key.apply_state"](p, ctx);
        if (hooked) return;
        hooked = true;
        await disableByMember(a.keyId);
        om.state.failNext = 1;
        await om.client.setKeyActive(a.ork, false).catch(() => undefined);
        expect(await enqueue(h, "key.apply_state", { keyId: a.keyId }, { now: new Date(T0.getTime() + 1_000) }), "실행 중인 작업에 합친다").toBe(first);
      },
    };
    const r1 = await runDue(h, handlers, T0);
    // 다음 tick 까지 돌려도 결과는 같아야 한다
    await runDue(h, handlers, new Date(T0.getTime() + 60_000));
    expect(om.state.active.get(a.ork), `호출 ${om.state.calls.join(", ")}`).toBe(false);
    expect(await pendingFor(a.keyId)).toHaveLength(0);
    expect((r1 as { stale?: number }).stale, "세대가 바뀐 완료 쓰기는 0행으로 따로 센다").toBe(1);
  });

  it(`TC-K1.T3.k ${LABEL[kind]}: 재시도 대기 중인 반영 작업에 끄기가 합쳐지면 바로 돌고 시도 횟수를 새로 센다`, async () => {
    const om = fakeOmniRoute();
    const handlers = omnirouteHandlers(() => om.client);
    const T0 = new Date("2026-10-03T00:00:00.000Z");
    const a = await activeKey();
    om.state.active.set(a.ork, true);
    const id = await enqueue(h, "key.apply_state", { keyId: a.keyId }, { now: T0 });
    // 켜기 시도가 세 번 실패해 다음 시도는 10분 뒤다
    let at = T0;
    for (let i = 0; i < 3; i++) {
      om.state.failNext = 1;
      await runDue(h, handlers, at);
      at = (await h.db.select().from(h.schema.omnirouteJobs).where(eq(h.schema.omnirouteJobs.id, id)))[0].nextRunAt;
    }
    const merged = new Date(T0.getTime() + 4 * 60_000);
    expect(at.getTime() - merged.getTime()).toBeGreaterThan(5 * 60_000);
    // 회원이 끈다. 즉시 반영 503 → enqueue 는 기다리는 작업에 합쳐진다
    await disableByMember(a.keyId);
    om.state.failNext = 1;
    await om.client.setKeyActive(a.ork, false).catch(() => undefined);
    expect(await enqueue(h, "key.apply_state", { keyId: a.keyId }, { now: merged })).toBe(id);
    const [row] = await h.db.select().from(h.schema.omnirouteJobs).where(eq(h.schema.omnirouteJobs.id, id));
    expect({ attempts: row.attempts, due: row.nextRunAt.getTime() <= merged.getTime() }).toEqual({ attempts: 0, due: true });
    await runDue(h, handlers, merged);
    expect(om.state.active.get(a.ork), `호출 ${om.state.calls.join(", ")}`).toBe(false);
    expect(await pendingFor(a.keyId)).toHaveLength(0);
  });
});
