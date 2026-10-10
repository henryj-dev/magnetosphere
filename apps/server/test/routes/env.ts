// 회원 키 API 시험 공용 (K4). 마이그레이션한 SQLite 파일 DB 에 앱(createApp)을 띄우지 않고 app.request 로 부른다.
//   - 세션: 가짜 인증 handler 가 /api/auth/get-session 에 쿠키 mg_test_session=<회원 id> 의 회원을 돌려준다.
//     라우터가 세션에서 얻는 것은 회원 id 하나뿐이고 역할·상태는 DB 에서 읽는다 (그것을 시험한다).
//   - OmniRoute: 키 상태를 기억하는 가짜 어댑터. 호출은 경로가 아니라 어댑터 함수 이름으로 적는다 (G-S5.9).
//   - 클라이언트 IP: 시험 헤더 x-test-ip (런타임 어댑터 대신).
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Analytics } from "@magnetosphere/omniroute";
import { seedAppSettings } from "@magnetosphere/db/src/seed.ts";
import type { Cipher } from "@magnetosphere/runtime/crypto";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { createApp, type Services } from "../../src/app.ts";
import type { KeysClient } from "../../src/routes/issue.ts";
import { makeTestEnv, type TestEnv } from "../helpers.ts";

export const ORIGIN = "http://localhost:3000";
export const SESSION_COOKIE = "mg_test_session";

export interface OmniCall {
  fn: "createKey" | "getAnalytics" | "setBudget" | "clearBudget" | "setKeyActive" | "deleteKey" | "regenerate";
  id?: string;
  value?: number | boolean | string;
  apiKeyIds?: string[];
}

export interface FakeOmni {
  /** OmniRoute 쪽 키 (id → 이름·켜짐·원문) */
  keys: Map<string, { id: string; name: string; isActive: boolean; secret: string; budget: number | null }>;
  calls: OmniCall[];
  /** createKey 가 돌려준 원문 전부 (지운 키 포함) */
  secrets: string[];
  /** 함수 이름 → 다음 호출들이 던질 오류 (앞에서부터 하나씩) */
  fail: Partial<Record<OmniCall["fn"], unknown[]>>;
  /** OmniRoute 키 id → 오늘 창 비용 (getAnalytics) */
  costs: Record<string, number>;
  client: () => KeysClient;
  /** 함수 이름 순서. setKeyActive 는 값까지 (예: "setKeyActive(false)") */
  seq: () => string[];
  /** 읽기(getAnalytics)를 뺀 순서 */
  writes: () => string[];
  of: (fn: OmniCall["fn"]) => OmniCall[];
}

export function fakeOmni(): FakeOmni {
  const f: FakeOmni = {
    keys: new Map(),
    calls: [],
    secrets: [],
    fail: {},
    costs: {},
    client: () => client,
    seq: () => f.calls.map((c) => (c.fn === "setKeyActive" ? `setKeyActive(${c.value})` : c.fn)),
    writes: () => f.seq().filter((x) => x !== "getAnalytics"),
    of: (fn) => f.calls.filter((c) => c.fn === fn),
  };
  const record = (call: OmniCall) => {
    const e = f.fail[call.fn]?.shift();
    f.calls.push(call);
    if (e !== undefined) throw e;
  };
  const client: KeysClient = {
    async createKey(name: string) {
      record({ fn: "createKey", value: name });
      const id = randomUUID();
      const secret = `sk-${randomBytes(24).toString("hex")}`;
      f.keys.set(id, { id, name, isActive: true, secret, budget: null });
      f.secrets.push(secret);
      return { id, key: secret, name };
    },
    async getAnalytics(q): Promise<Analytics> {
      record({ fn: "getAnalytics", apiKeyIds: q.apiKeyIds });
      const byApiKey = Object.entries(f.costs)
        .filter(([id]) => !q.apiKeyIds || q.apiKeyIds.includes(id))
        .map(([apiKeyId, cost]) => ({ apiKeyId, requests: 1, cost }));
      return { totalCost: byApiKey.reduce((s, x) => s + x.cost, 0), totalRequests: byApiKey.length, promptTokens: 0, completionTokens: 0, byApiKey };
    },
    async setBudget(id, b) {
      record({ fn: "setBudget", id, value: b.monthlyUsd });
      const k = f.keys.get(id);
      if (k) k.budget = b.monthlyUsd;
    },
    async clearBudget(id) {
      record({ fn: "clearBudget", id });
    },
    async setKeyActive(id, active) {
      record({ fn: "setKeyActive", id, value: active });
      const k = f.keys.get(id);
      if (k) k.isActive = active;
    },
    async deleteKey(id) {
      record({ fn: "deleteKey", id });
      f.keys.delete(id);
    },
  };
  return f;
}

/** 세션을 돌려주는 가짜 인증. 쿠키 mg_test_session 의 값이 회원 id 다 */
export function fakeAuth(): Services["auth"] {
  return {
    async handler(req: Request) {
      const url = new URL(req.url);
      if (url.pathname !== "/api/auth/get-session") return new Response("not found", { status: 404 });
      const m = /(?:^|;\s*)mg_test_session=([^;]+)/.exec(req.headers.get("cookie") ?? "");
      return Response.json(m ? { user: { id: decodeURIComponent(m[1]) }, session: { id: "s" } } : null);
    },
  };
}

export interface RouteEnv {
  t: TestEnv;
  h: DbHandle;
  om: FakeOmni;
  app: ReturnType<typeof createApp>;
  logs: string[];
  /** OmniRoute 연결을 끊는다 (keysClient → null) */
  disconnect(): void;
  close(): Promise<void>;
}

export async function openRoutes(opts: { url?: string; h?: DbHandle } = {}): Promise<RouteEnv> {
  const t = await makeTestEnv();
  const h = opts.h ?? (await connectNode(opts.url ?? t.env.DATABASE_URL));
  if (!opts.h) await seedAppSettings(h.db, h.schema as { appSettings: unknown });
  const om = fakeOmni();
  const logs: string[] = [];
  let connected = true;
  const services: Services = {
    db: h,
    auth: fakeAuth(),
    cipher: {} as Cipher,
    omniroute: { baseUrl: null, initialPassword: null },
    clientIp: (req) => req.headers.get("x-test-ip") ?? "203.0.113.1",
    appOrigin: ORIGIN,
    keysClient: async () => (connected ? () => om.client() : null),
  };
  const app = createApp({ services: async () => services, assets: async (c) => c.text("spa"), setupTokenFromSecret: false, log: (l) => logs.push(l) });
  return {
    t,
    h,
    om,
    app,
    logs,
    disconnect: () => void (connected = false),
    async close() {
      if (!opts.h) await h.close();
      t.cleanup();
    },
  };
}

export interface UserSpec {
  status?: string;
  emailVerified?: boolean;
  limitUsd?: number | null;
  maxKeys?: number | null;
  role?: string;
}

export async function addUser(h: DbHandle, spec: UserSpec = {}): Promise<string> {
  const id = randomUUID();
  await h.db.insert(h.schema.user).values({
    id,
    name: "회원",
    email: `member-${id}@example.com`,
    emailVerified: spec.emailVerified ?? true,
    status: spec.status ?? "active",
    role: spec.role ?? "member",
    monthlyLimitUsd: spec.limitUsd === undefined ? 5 : spec.limitUsd,
    maxKeys: spec.maxKeys ?? null,
  });
  return id;
}

export interface CallOpts {
  user?: string;
  body?: unknown;
  /** JSON 이 아닌 본문을 그대로 보낸다 (content-type 은 application/json) */
  raw?: string;
  /** 기본 같은 출처. null 이면 Origin 헤더를 빼고 보낸다 */
  origin?: string | null;
  ip?: string;
}

export async function call(e: RouteEnv, method: string, path: string, o: CallOpts = {}) {
  const headers: Record<string, string> = {};
  if (o.user) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(o.user)}`;
  if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  if (o.ip) headers["x-test-ip"] = o.ip;
  let body: string | undefined;
  if (o.body !== undefined || o.raw !== undefined) {
    headers["content-type"] = "application/json";
    body = o.raw ?? JSON.stringify(o.body);
  }
  const res = await e.app.request(`${ORIGIN}${path}`, { method, headers, body });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // JSON 이 아닌 응답
  }
  return { status: res.status, json, text };
}

/** api_keys 행 (OmniRoute id 로) */
export async function keyByOrk(h: DbHandle, ork: string) {
  const k = h.schema.apiKeys;
  const [r] = await h.db.select().from(k).where(eq(k.omnirouteKeyId, ork));
  return r;
}

export async function keysOf(h: DbHandle, userId: string) {
  const k = h.schema.apiKeys;
  return h.db.select().from(k).where(eq(k.userId, userId));
}

/** 회원의 키 행 하나를 직접 넣는다 (OmniRoute 가짜에도 키를 만든다) */
export async function seedKey(e: RouteEnv, userId: string, o: { state?: string; reason?: string | null; budgetUsd?: number | null; budgetMonth?: string | null; isActive?: boolean } = {}) {
  const id = randomUUID();
  const ork = randomUUID();
  e.om.keys.set(ork, { id: ork, name: `m_${userId.slice(0, 8)}_${id.slice(0, 8)}`, isActive: o.isActive ?? (o.state ?? "active") === "active", secret: `sk-${randomBytes(8).toString("hex")}`, budget: o.budgetUsd ?? null });
  await e.h.db.insert(e.h.schema.apiKeys).values({
    id,
    userId,
    omnirouteKeyId: ork,
    keyPreview: "abcd",
    state: o.state ?? "active",
    disabledReason: o.reason ?? null,
    budgetUsd: o.budgetUsd ?? null,
    budgetMonth: o.budgetMonth ?? null,
    createdAt: new Date(Date.now() - 60_000),
  });
  return { id, ork };
}
