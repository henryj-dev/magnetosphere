// K4.T5 회원 키 API 수명주기 계약 시험 (계획서 v5.7 5.2, V11·V18). 회원 앱(Node 런타임·실제 Better Auth·SQLite)을 계약 환경
// OmniRoute(127.0.0.1:20170)에 붙여 띄우고, 설치 → 회원 로그인 → /api/me/keys 로 발급·끄기·켜기·삭제를 HTTP 로 부른다.
// 주기 작업은 등록하지 않는다 (key.delete 는 시험이 가짜 시계 + 2분으로 직접 돈다). 관리 호출은 어댑터로만 한다 (G-S5.9).
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient, loginWithPassword, type OmniRouteClient } from "@magnetosphere/omniroute";
import { createNodeRuntime, listen, type NodeRuntime } from "@magnetosphere/runtime/node";
import { createApp, type Services } from "../../../src/app.ts";
import { buildServices } from "../../../src/config.ts";
import { CONFIRMED_KEY } from "../../../src/limits/daily.ts";
import { dayKey } from "../../../src/limits/month.ts";
import { rebalanceAll } from "../../../src/limits/rebalance.ts";
import { writeSetting } from "../../../src/limits/store.ts";
import { omnirouteHandlers } from "../../../src/queue/handlers.ts";
import { KEY_DELETE_DELAY_MS, runDue } from "../../../src/queue/index.ts";
import { ensureSetupToken } from "../../../src/setup/index.ts";
import { OMNIROUTE_TOKEN_KEY, readOmniRouteToken } from "../../../src/setup/omniroute.ts";
import { ADMIN, makeTestEnv, type TestEnv } from "../../helpers.ts";
import { infer, OMNI_PASSWORD, OMNI_URL, threeRequests } from "../limits/env.ts";

interface App {
  t: TestEnv;
  rt: NodeRuntime;
  s: Services;
  base: string;
  /** 회원 앱의 관리 토큰으로 만든 어댑터 (설치 때 부트스트랩한 write 토큰) */
  om: OmniRouteClient;
  close(): Promise<void>;
}

let app: App;
const cleanupKeys: string[] = [];

async function boot(): Promise<App> {
  const t = await makeTestEnv();
  const env = { ...t.env, OMNIROUTE_URL: OMNI_URL, OMNIROUTE_INITIAL_PASSWORD: OMNI_PASSWORD };
  const rt = createNodeRuntime({ env, trustedProxies: [] });
  const s = await buildServices(rt, { waitUntil: (p) => void p.catch(() => undefined) });
  const logs: string[] = [];
  const server = createApp({ services: async () => s, assets: async (c) => c.text("spa"), setupTokenFromSecret: false, log: (l) => logs.push(l), carryRequest: (a, b) => rt.carryPeer(a, b) });
  const listening = await listen(rt, server.fetch, { port: 0, hostname: "127.0.0.1" });
  const base = `http://127.0.0.1:${listening.port}`;
  const token = await ensureSetupToken(s.db, { rotate: true, log: (l) => logs.push(l), fixedToken: null });
  const setup = await post(base, "/api/setup", { token, ...ADMIN });
  expect(await setup.json(), "설치가 OmniRoute 토큰을 부트스트랩했다").toEqual({ ok: true, omniroute: "connected" });
  // 오늘 첫 분배의 어제 확정·대조 호출을 이 시험에서 뺀다 (한도 분배 계약 시험과 같다)
  await writeSetting(s.db, CONFIRMED_KEY, dayKey(new Date()), new Date());
  const om = createClient({ baseUrl: OMNI_URL, credential: { token: (await readOmniRouteToken(s.db, s.cipher))! } });
  return {
    t,
    rt,
    s,
    base,
    om,
    async close() {
      for (const id of cleanupKeys.splice(0)) await om.deleteKey(id).catch(() => undefined);
      await revokeAppToken(s).catch(() => undefined);
      await listening.close();
      await rt.close();
      t.cleanup();
    },
  };
}

const post = (base: string, path: string, body: unknown, cookie?: string) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });

/** 회원 하나 (Better Auth 이메일 가입과 같은 모양의 credential 계정) 를 만들고 로그인한 쿠키 */
async function member(a: App, limitUsd: number | null): Promise<{ id: string; cookie: string }> {
  const id = randomUUID();
  const email = `k4-${id}@example.com`;
  const password = "k4 contract member password";
  const now = new Date();
  await a.s.db.db.insert(a.s.db.schema.user).values({ id, name: "k4", email, emailVerified: true, monthlyLimitUsd: limitUsd, createdAt: now, updatedAt: now });
  await a.s.db.db.insert(a.s.db.schema.account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: await hashPassword(password), createdAt: now, updatedAt: now });
  const res = await post(a.base, "/api/auth/sign-in/email", { email, password });
  expect(res.status, "회원 로그인").toBe(200);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { id, cookie };
}

async function api(a: App, method: string, path: string, cookie: string) {
  const res = await fetch(a.base + path, { method, headers: { origin: "http://localhost:3000", cookie, ...(method === "POST" && path === "/api/me/keys" ? { "content-type": "application/json" } : {}) }, body: method === "POST" && path === "/api/me/keys" ? "{}" : undefined });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

/** 그 키의 OmniRoute id (회원 앱 매핑) */
async function orkOf(a: App, keyId: string): Promise<string> {
  const k = a.s.db.schema.apiKeys;
  const [r] = await a.s.db.db.select({ ork: k.omnirouteKeyId }).from(k).where(eq(k.id, keyId));
  return r.ork;
}

const permissionDenied = (r: { status: number; json: any }) => r.status === 403 && r.json?.error?.code === "permission_denied";

/** 회원 앱이 설치 때 만든 접근 토큰 회수 (write 토큰은 토큰을 못 지워 대시보드 쿠키로 지운다, V10) */
async function revokeAppToken(s: Services) {
  const t = s.db.schema.appSettings;
  const [row] = await s.db.db.select({ value: t.value }).from(t).where(eq(t.key, OMNIROUTE_TOKEN_KEY));
  if (!row) return;
  const { id } = JSON.parse(row.value) as { id: string };
  const { cookie } = await loginWithPassword({ baseUrl: OMNI_URL }, OMNI_PASSWORD);
  await fetch(`${OMNI_URL}/api/cli/tokens/${id}`, { method: "DELETE", headers: { cookie, origin: OMNI_URL } });
}

beforeEach(async () => {
  app = await boot();
});
afterEach(async () => {
  await app.close();
});

describe("TC-K4.T5.a 발급한 키로 Anthropic 형식 요청이 되고, 끄면 403, 지우면 바로 거부되고 DELETE 뒤 401 이다 (V18 의존)", () => {
  it("POST /api/me/keys → 원문 → /v1/messages 200 → disable → 403 permission_denied → enable → 200 → DELETE → 403 → 65초 뒤 key.delete → listKeys 에 없음, 401", { timeout: 240_000 }, async () => {
    const m = await member(app, 5);
    const issued = await api(app, "POST", "/api/me/keys", m.cookie);
    expect(issued.status, JSON.stringify(issued.json)).toBe(201);
    const secret = issued.json.secret as string;
    const keyId = issued.json.key.id as string;
    const ork = await orkOf(app, keyId);
    cleanupKeys.push(ork);
    const info = (await app.om.listKeys()).find((k) => k.id === ork);
    expect(info, "OmniRoute 에 m_ 이름으로 켜져 있다").toMatchObject({ name: `m_${m.id.slice(0, 8)}_${keyId.slice(0, 8)}`, isActive: true });
    expect((await infer(secret, "anthropic")).status, "발급 직후").toBe(200);

    expect((await api(app, "POST", `/api/me/keys/${keyId}/disable`, m.cookie)).status).toBe(200);
    const off = await infer(secret, "anthropic");
    expect(permissionDenied(off), `끈 뒤 첫 요청 ${off.status} ${JSON.stringify(off.json)}`).toBe(true);

    expect((await api(app, "POST", `/api/me/keys/${keyId}/enable`, m.cookie)).status).toBe(200);
    expect((await infer(secret, "anthropic")).status, "다시 켠 뒤").toBe(200);

    expect((await api(app, "DELETE", `/api/me/keys/${keyId}`, m.cookie)).status).toBe(200);
    const gone = await infer(secret, "anthropic");
    expect(permissionDenied(gone), `삭제 뒤 첫 요청 ${gone.status} ${JSON.stringify(gone.json)}`).toBe(true);
    expect((await app.om.listKeys()).find((k) => k.id === ork)?.isActive, "DELETE 전에는 꺼진 채 남아 있다").toBe(false);

    // OmniRoute 키 검증 캐시(60초)가 지나도록 실제로 기다린 뒤, 가짜 시계 + 2분으로 key.delete 를 돈다
    await new Promise((r) => setTimeout(r, 65_000));
    const handlers = omnirouteHandlers(() => app.om);
    const ran = await runDue(app.s.db, handlers, new Date(Date.now() + KEY_DELETE_DELAY_MS));
    expect(ran.done).toBeGreaterThanOrEqual(1);
    expect((await app.om.listKeys()).find((k) => k.id === ork), "DELETE 뒤 목록에 없다").toBeUndefined();
    expect((await infer(secret, "anthropic")).status, "DELETE 뒤").toBe(401);
    // 행은 삭제 표시로 남는다 (사용액이 회원 합계에 남는다)
    const [row] = await app.s.db.db.select().from(app.s.db.schema.apiKeys).where(eq(app.s.db.schema.apiKeys.id, keyId));
    expect(row.state).toBe("deleted");
  });
});

describe("TC-K4.T5.b 남은 한도 0 인 회원은 발급이 막히고 OmniRoute 에 키가 늘지 않는다", () => {
  it("한도 0.01, 키 하나로 요청 3건 → 분배 → 키 삭제 → 새 발급 409 limit_exhausted, listKeys 의 그 회원 m_ 키 수 변화 0", { timeout: 180_000 }, async () => {
    const m = await member(app, 0.01);
    const issued = await api(app, "POST", "/api/me/keys", m.cookie);
    expect(issued.status, JSON.stringify(issued.json)).toBe(201);
    const keyId = issued.json.key.id as string;
    const ork = await orkOf(app, keyId);
    cleanupKeys.push(ork);
    expect(await threeRequests(issued.json.secret)).toEqual([200, 200, 200]);
    // 기록이 분석에 잡힐 때까지 (3건 합계 0.014633 > 한도 0.01)
    const end = Date.now() + 90_000;
    while ((await app.om.getAnalytics({ apiKeyIds: [ork], startDate: new Date(Date.now() - 86_400_000), endDate: new Date(Date.now() + 60_000) })).totalRequests < 3 && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 500));
    }
    await rebalanceAll({ db: app.s.db, now: new Date(), client: () => app.om });
    const k = app.s.db.schema.apiKeys;
    const [afterRebalance] = await app.s.db.db.select().from(k).where(eq(k.id, keyId));
    expect([afterRebalance.state, afterRebalance.disabledReason], "분배가 남은 한도 0 으로 껐다").toEqual(["disabled", "limit"]);
    expect((await api(app, "DELETE", `/api/me/keys/${keyId}`, m.cookie)).status).toBe(200);

    const mine = async () => (await app.om.listKeys()).filter((x) => x.name.startsWith(`m_${m.id.slice(0, 8)}_`)).length;
    const before = await mine();
    // 회원 앱이 OmniRoute 에 키를 만들려 했는지 본다 (만들었다가 되돌려 지운 키는 listKeys 에 남지 않는다)
    const created: string[] = [];
    const real = app.s.keysClient!;
    app.s.keysClient = async () => {
      const f = await real();
      return f && ((o) => {
        const c = f(o);
        return { ...c, createKey: async (name: string) => (created.push(name), c.createKey(name)) };
      });
    };
    const again = await api(app, "POST", "/api/me/keys", m.cookie);
    expect([again.status, again.json?.error]).toEqual([409, "limit_exhausted"]);
    expect(created, "createKey 를 부르지 않았다").toEqual([]);
    expect(await mine(), "OmniRoute 에 키가 늘지 않았다").toBe(before);
    expect((await api(app, "GET", "/api/me/keys", m.cookie)).json.keys).toEqual([]);
  });
});
