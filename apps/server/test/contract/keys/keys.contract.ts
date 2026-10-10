// K3.T3 정합성 점검 계약 시험 (계획서 v5.7 5.7·5.8). 실제 OmniRoute(계약 환경)의 키 목록으로 점검 한 번을 돌린다.
// 저장소 최상위 pnpm test:contract -t "TC-K3.T3.…" 가 계약 환경을 띄우고 이 파일을 돈다.
// 회원 앱 DB·접근 토큰·키 만들기·추론 요청은 한도 분배 계약 시험의 도구(../limits/env.ts)를 같이 쓴다.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient, loginWithPassword } from "@magnetosphere/omniroute";
// @ts-expect-error 시험 도우미는 타입 선언이 없는 .mjs 다
import { grantScopes } from "../../../../../tests/contract/key-scopes.mjs";
import { reconcile, type ReconcileClient } from "../../../src/keys/reconcile.ts";
import { addUser, infer, isActive, issue, OMNI_PASSWORD, OMNI_URL, offRejected, open, type Ctx } from "../limits/env.ts";

let c: Ctx;
beforeEach(async () => {
  c = await open("contract-k3");
});
afterEach(async () => {
  await c.close();
});

/** 회원 앱이 OmniRoute 에 보낸 요청 본문 (fetch 를 감싸 기록) */
let sentBodies: string[] = [];

/** 점검이 쓰는 클라이언트: 접근 토큰(write)으로 만든 어댑터, 요청 본문을 기록한다 */
function reconcileClient(): () => ReconcileClient {
  sentBodies = [];
  const record: typeof fetch = async (input, init) => {
    if (typeof init?.body === "string") sentBodies.push(init.body);
    return fetch(input, init);
  };
  const client = createClient({ baseUrl: OMNI_URL, credential: { token: c.token }, fetch: record });
  return () => client;
}

const keyRow = async (omniId: string) => {
  const k = c.h.schema.apiKeys;
  const [r] = await c.h.db.select().from(k).where(eq(k.omnirouteKeyId, omniId));
  return { state: r.state as string, reason: r.disabledReason as string | null, syncState: r.syncState as string };
};

describe("TC-K3.T3.a OmniRoute 에서 켜진 키의 목표가 꺼짐이면 점검이 끈다 (계약)", () => {
  it("매핑 키를 대시보드 쿠키로 setKeyActive(true) → 회원 status suspended(DB) → reconcile 1회 → listKeys 의 그 키 isActive false, 요청 403", { timeout: 120_000 }, async () => {
    const u = await addUser(c, null);
    const key = await issue(c, u);
    expect((await infer(key.key)).status, "쓰기 전 요청").toBe(200);
    // 누군가 대시보드에서 키를 켠다 (반영 실패·수동 조작으로 생긴 어긋남)
    const dashboard = createClient({ baseUrl: OMNI_URL, credential: await loginWithPassword({ baseUrl: OMNI_URL }, OMNI_PASSWORD) });
    await dashboard.setKeyActive(key.id, true);
    // 회원 정지는 DB 에서만 바뀐다 (정지 API 는 3단계)
    await c.h.db.update(c.h.schema.user).set({ status: "suspended" }).where(eq(c.h.schema.user.id, u));
    const r = await reconcile({ db: c.h, client: reconcileClient(), now: new Date() });
    expect(r.applied).toBeGreaterThanOrEqual(1);
    expect(await isActive(c, key.id)).toBe(false);
    expect(offRejected(await infer(key.key), true), "정지 회원 키 요청").toBe(true);
    expect(await keyRow(key.id)).toEqual({ state: "disabled", reason: "user_status", syncState: "synced" });
  });
});

describe("TC-K3.T3.c scopes 에 manage 가 붙은 m_ 키는 끄고 알린다 (계약, V10)", () => {
  it("매핑 키에 scopes [manage] (시험 도구의 대시보드 쿠키 호출) → reconcile 1회 → isActive false, alert.manage_scope_key 1행, 회원 앱 요청 본문에 scopes 0건", { timeout: 120_000 }, async () => {
    const u = await addUser(c, null);
    const key = await issue(c, u);
    expect(await grantScopes(OMNI_URL, OMNI_PASSWORD, key.id, ["manage"])).toBe(200);
    expect((await c.client.listKeys()).find((k) => k.id === key.id)?.scopes, "범위가 붙었다").toContain("manage");
    const r = await reconcile({ db: c.h, client: reconcileClient(), now: new Date() });
    expect(r.manageScope).toBeGreaterThanOrEqual(1);
    expect(await isActive(c, key.id)).toBe(false);
    const alerts = (await c.h.db.select().from(c.h.schema.auditLog)).filter((a: { action: string; target: string }) => a.action === "alert.manage_scope_key" && a.target === key.id);
    expect(alerts).toHaveLength(1);
    expect(sentBodies.filter((b) => /scopes/i.test(b))).toEqual([]);
    // 다음 점검이 다시 켜지 않게 관리자가 끈 것으로 남는다
    expect(await keyRow(key.id)).toMatchObject({ state: "disabled", reason: "admin" });
    await reconcile({ db: c.h, client: reconcileClient(), now: new Date() });
    expect(await isActive(c, key.id)).toBe(false);
  });
});

describe("TC-K3.T3.k listKeys 는 limit 없이 모든 키를 한 번에 받는다 (계약, V28)", () => {
  it("OmniRoute 키를 120개 이상으로 채운다 → listKeys 한 번에 만든 키가 모두 있고 개수 ≥ 120 (어댑터의 total 검사 통과)", { timeout: 300_000 }, async () => {
    const before = (await c.client.listKeys()).length;
    const made: string[] = [];
    for (let i = 0; i < Math.max(120 - before, 3); i++) {
      const k = await c.client.createKey(`contract-k3-list-${Date.now().toString(36)}-${i}`);
      c.keys.push(k.id);
      made.push(k.id);
    }
    const all = await c.client.listKeys();
    expect(all.length).toBeGreaterThanOrEqual(120);
    const ids = new Set(all.map((k) => k.id));
    expect(made.filter((id) => !ids.has(id))).toEqual([]);
  });
});
