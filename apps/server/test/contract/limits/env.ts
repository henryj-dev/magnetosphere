// 한도 분배 계약 시험 공용 (K2.T6·T7). 계약 환경(tests/contract, 127.0.0.1:20170)의 OmniRoute 에 실제로 붙는다.
// 관리 호출은 어댑터로 한다. 여기서 직접 부르는 것은 회원 도구가 쓰는 추론(/v1)과 시험 정리(접근 토큰 회수)뿐이다.
// 회원 앱 DB 는 마이그레이션을 적용한 SQLite 파일이다 (test/helpers.ts).
import { randomUUID } from "node:crypto";
import { createAccessToken, createClient, type OmniRouteClient } from "@magnetosphere/omniroute";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
// @ts-expect-error 시험 도우미는 타입 선언이 없는 .mjs 다
import { isBudgetBlocked } from "../../../../../tests/contract/budget-block.mjs";
import { CONFIRMED_KEY } from "../../../src/limits/daily.ts";
import { dayKey } from "../../../src/limits/month.ts";
import type { LimitsClient } from "../../../src/limits/rebalance.ts";
import { writeSetting } from "../../../src/limits/store.ts";
import { makeTestEnv, type TestEnv } from "../../helpers.ts";

export const OMNI_URL = process.env.OMNI_URL ?? "http://127.0.0.1:20170";
const OMNI_PASSWORD = process.env.OMNI_PASSWORD ?? "contract-initial-password-5c1e9a";
/** tests/contract/setup.mjs 가 등록한 가짜 모델의 요청 1건 비용 (0단계 회원 B, TC-S5.T2.e) */
export const OPENAI_COST = 0.00221;
export const THREE_COST = 0.00221 + 0.0062115 * 2;

export interface Ctx {
  env: TestEnv;
  h: DbHandle;
  client: OmniRouteClient;
  /** 어댑터 호출 기록 (함수 이름과 키 id) */
  calls: { fn: string; id: string; value?: unknown }[];
  /** 기록하는 분배용 클라이언트 */
  limits: () => LimitsClient;
  /** 시험이 만든 OmniRoute 키 (끝나면 지운다) */
  keys: string[];
  close(): Promise<void>;
}

export async function open(name: string): Promise<Ctx> {
  const env = await makeTestEnv();
  const h = await connectNode(env.env.DATABASE_URL);
  const t = await createAccessToken({ baseUrl: OMNI_URL }, { password: OMNI_PASSWORD, scope: "write", name, expiresInDays: 1 });
  const client = createClient({ baseUrl: OMNI_URL, credential: { token: t.token } });
  const calls: Ctx["calls"] = [];
  const limits = (): LimitsClient => ({
    getAnalytics: (q) => client.getAnalytics(q),
    async setBudget(id, b) {
      calls.push({ fn: "setBudget", id, value: b.monthlyUsd });
      await client.setBudget(id, b);
    },
    async clearBudget(id) {
      calls.push({ fn: "clearBudget", id });
      await client.clearBudget(id);
    },
    async setKeyActive(id, active) {
      calls.push({ fn: "setKeyActive", id, value: active });
      await client.setKeyActive(id, active);
    },
  });
  // 날 확정은 이미 한 것으로 둔다 (오늘 첫 분배의 어제 창·대조 호출을 이 시험들에서 빼려고). TC-K2.T7.d 는 따로 지운다
  await writeSetting(h, CONFIRMED_KEY, dayKey(new Date()), new Date());
  const ctx: Ctx = {
    env,
    h,
    client,
    calls,
    limits,
    keys: [],
    async close() {
      for (const id of ctx.keys) await client.deleteKey(id).catch(() => {});
      await revokeToken(t.id).catch(() => {});
      await h.close();
      env.cleanup();
    },
  };
  return ctx;
}

/** OmniRoute 키를 만들고 회원 앱 매핑(api_keys)에 넣는다. disabledReason 이 있으면 OmniRoute 에서도 끈다 */
export async function issue(c: Ctx, userId: string, opts: { state?: "active" | "disabled"; reason?: string } = {}) {
  const k = await c.client.createKey(`contract-k2-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`);
  c.keys.push(k.id);
  if (opts.state === "disabled") await c.client.setKeyActive(k.id, false);
  await c.h.db.insert(c.h.schema.apiKeys).values({
    id: randomUUID(),
    userId,
    omnirouteKeyId: k.id,
    keyPreview: k.key.slice(-4),
    state: opts.state ?? "active",
    disabledReason: opts.reason ?? null,
    createdAt: new Date(),
  });
  return k;
}

export async function addUser(c: Ctx, limitUsd: number | null): Promise<string> {
  const id = randomUUID();
  await c.h.db.insert(c.h.schema.user).values({ id, name: "k2", email: `k2-${id}@example.com`, monthlyLimitUsd: limitUsd });
  return id;
}

export interface Infer {
  status: number;
  json: any;
}

/** 회원 키로 추론 요청 하나 (OpenAI 비스트리밍 0.00221, 또는 Anthropic) */
export async function infer(key: string, kind: "openai" | "anthropic" = "openai", stream = false): Promise<Infer> {
  const messages = [{ role: "user", content: "contract ping" }];
  const [path, body] =
    kind === "openai"
      ? ["/v1/chat/completions", { model: "mko/mock-gpt", messages, stream }]
      : ["/v1/messages", { model: "mka/claude-mock", max_tokens: 50, messages, stream }];
  const res = await fetch(OMNI_URL + path, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 스트리밍 본문은 JSON 이 아니다
  }
  return { status: res.status, json };
}

/** 0단계 회원 B 와 같은 요청 3건 (합계 0.014633) */
export async function threeRequests(key: string): Promise<number[]> {
  return [(await infer(key, "openai")).status, (await infer(key, "anthropic")).status, (await infer(key, "anthropic", true)).status];
}

/**
 * 끈 키의 거부. 쓴 적이 있는 키는 403 permission_denied (V11). 한 번도 쓰지 않은 채 꺼진 키는 키 검증 캐시에 없어
 * 401 AUTH_002 다 (OmniRoute 3.8.51 계약 환경 실측, K2). 둘 다 키가 꺼져 거부된 것이다
 */
export const offRejected = (r: Infer, used: boolean) =>
  (r.status === 403 && r.json?.error?.code === "permission_denied") || (!used && r.status === 401 && r.json?.error?.code === "AUTH_002");

/** OmniRoute 에서 그 키가 켜져 있는가 (listKeys) */
export async function isActive(c: Ctx, id: string): Promise<boolean | undefined> {
  return (await c.client.listKeys()).find((k) => k.id === id)?.isActive;
}

/** 막힌 응답인가: 예산 차단(K0.T11 도우미) 또는 끈 키 403 */
export const blocked = (r: Infer) => isBudgetBlocked(r.status, r.json) || r.status === 403;

/** OmniRoute 가 기록을 마칠 때까지 기다린다 (분석은 요청 직후 바로 잡히지 않을 수 있다) */
export async function settled(c: Ctx, ids: string[], requests: number, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const a = await c.client.getAnalytics({ apiKeyIds: ids, startDate: new Date(Date.now() - 86_400_000), endDate: new Date(Date.now() + 60_000) });
    if (a.totalRequests >= requests || Date.now() > end) return a;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** 시험에서 만든 접근 토큰 회수 (write 토큰은 토큰을 못 지워 대시보드 쿠키로 지운다, V10) */
async function revokeToken(id: string) {
  const res = await fetch(`${OMNI_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: OMNI_URL },
    body: JSON.stringify({ password: OMNI_PASSWORD }),
  });
  const cookie = res.headers.getSetCookie().map((s) => s.split(";")[0]).find((s) => s.startsWith("auth_token="));
  if (!cookie) return;
  await fetch(`${OMNI_URL}/api/cli/tokens/${id}`, { method: "DELETE", headers: { cookie, origin: OMNI_URL } });
}
