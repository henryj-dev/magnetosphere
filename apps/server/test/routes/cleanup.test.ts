// K4 보안 리뷰 M2: 발급 도중 죽어 남은 자리 행·OmniRoute 키를 5분 정합성 점검(K3 reconcile)이 치운다.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "../../src/keys/reconcile.ts";
import { KEY_DELETE_DELAY_MS } from "../../src/queue/index.ts";
import { STALE_SLOT_MS } from "../../src/keys/reconcile.ts";
import { fakeKeys } from "../keys/fake.ts";
import { addUser, keysOf, openRoutes, type RouteEnv } from "./env.ts";

let e: RouteEnv;
beforeEach(async () => {
  e = await openRoutes();
});
afterEach(async () => {
  await e.close();
});

const NOW = new Date("2026-10-07T03:00:00.000Z");

/** 자리 행 (발급 중 상태 그대로) */
async function slot(userId: string, ageMs: number) {
  const id = randomUUID();
  await e.h.db.insert(e.h.schema.apiKeys).values({
    id,
    userId,
    omnirouteKeyId: `pending-${id}`,
    keyPreview: "",
    state: "disabled",
    disabledReason: "member",
    syncState: "pending",
    createdAt: new Date(NOW.getTime() - ageMs),
  });
  return id;
}

const jobs = async () => (await e.h.db.select().from(e.h.schema.omnirouteJobs)) as { action: string; payload: string; nextRunAt: Date }[];
const alerts = async (action: string) => (await e.h.db.select().from(e.h.schema.auditLog)).filter((a: { action: string }) => a.action === action);

describe("TC-K4.T1.j 오래된 자리 행은 정합성 점검이 지운다", () => {
  it("created_at 이 10분보다 오래된 pending- 행 → reconcile 1회 → 행 0·자리 반환. 대조: 5분 된 자리 행은 그대로", async () => {
    expect(STALE_SLOT_MS).toBe(600_000);
    const u = await addUser(e.h);
    const old = await slot(u, 11 * 60_000);
    const fresh = await slot(u, 5 * 60_000);
    const om = fakeKeys();
    await reconcile({ db: e.h, client: () => om.client(), now: NOW });
    expect((await keysOf(e.h, u)).map((r: { id: string }) => r.id)).toEqual([fresh]);
    expect(old).not.toBe(fresh);
    expect(om.of("setKeyActive")).toEqual([]);
  });
});

describe("TC-K4.T1.k createKey 직후 죽어 남은 매핑 없는 m_ 키는 끄고 2분 뒤 지운다", () => {
  it("이름 m_<회원8>_<자리 행8> 인 매핑 없는 키 → setKeyActive(false)·key.delete 끈 뒤 120,000ms·행 0·unknown 알림 0. 대조: 10분 안 된 자리 행의 키와 id 가 안 맞는 m_ 키는 끄지 않는다", async () => {
    const u = await addUser(e.h);
    const dead = await slot(u, 11 * 60_000);
    const young = await slot(u, 5 * 60_000);
    const om = fakeKeys();
    om.add("ork-dead", { name: `m_${u.slice(0, 8)}_${dead.slice(0, 8)}` });
    om.add("ork-young", { name: `m_${u.slice(0, 8)}_${young.slice(0, 8)}` });
    om.add("ork-other", { name: `m_${u.slice(0, 8)}_deadbeef` });
    await reconcile({ db: e.h, client: () => om.client(), now: NOW });
    expect(om.keys.get("ork-dead")?.isActive).toBe(false);
    expect([om.keys.get("ork-young")?.isActive, om.keys.get("ork-other")?.isActive]).toEqual([true, true]);
    expect(om.of("setKeyActive").map((c) => c.id)).toEqual(["ork-dead"]);
    const del = (await jobs()).filter((j) => j.action === "key.delete");
    expect(del.map((j) => JSON.parse(j.payload).omnirouteKeyId)).toEqual(["ork-dead"]);
    expect(new Date(del[0].nextRunAt).getTime() - NOW.getTime()).toBe(KEY_DELETE_DELAY_MS);
    expect((await keysOf(e.h, u)).map((r: { id: string }) => r.id)).toEqual([young]);
    // 치운 키는 운영자 키 알림 대상이 아니다. 나머지 둘은 그대로 알린다 (Q6)
    expect((await alerts("alert.unknown_m_key")).map((a: { target: string }) => a.target).sort()).toEqual(["ork-other", "ork-young"]);
    // 끄기가 실패하면 자리 행을 남겨 다음 점검이 다시 본다
    const dead2 = await slot(u, 20 * 60_000);
    om.add("ork-dead2", { name: `m_${u.slice(0, 8)}_${dead2.slice(0, 8)}` });
    om.fail.setKeyActive = [new Error("down")];
    await reconcile({ db: e.h, client: () => om.client(), now: NOW });
    expect((await keysOf(e.h, u)).map((r: { id: string }) => r.id).sort()).toEqual([young, dead2].sort());
    await reconcile({ db: e.h, client: () => om.client(), now: NOW });
    expect(om.keys.get("ork-dead2")?.isActive).toBe(false);
    expect((await keysOf(e.h, u)).map((r: { id: string }) => r.id)).toEqual([young]);
  });
});
