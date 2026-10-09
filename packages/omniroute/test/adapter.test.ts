// 어댑터 단위 테스트 (OmniRoute 없이 가짜 fetch). 계약 테스트 설정(pnpm test:contract)에서도 같이 돈다.
import { describe, expect, it } from "vitest";
import { createClient, OmniRouteError, OmniRouteFormatError } from "../src/index.ts";

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** 경로마다 정한 응답을 주고 보낸 요청을 기록하는 fetch */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const sent: Sent[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    sent.push({ method, url, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body as string | undefined });
    const path = new URL(url).pathname;
    const r = routes[`${method} ${path}`] ?? routes[`${method} *`];
    if (!r) return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, sent };
}

const ANALYTICS = {
  summary: { totalCost: 0.014633, totalRequests: 3, promptTokens: 879, completionTokens: 132, uniqueModels: 2 },
  byApiKey: [{ apiKeyId: "k1", apiKeyName: "m_1", requests: 3, cost: 0.014633 }],
  dailyTrend: [],
};
const range = { apiKeyIds: ["k1"], startDate: "2026-10-01T00:00:00.000Z", endDate: "2026-10-31T00:00:00.000Z" };

describe("TC-S5.T2.f 응답 형식이 바뀌면 조용히 넘어가지 않고 오류를 낸다", () => {
  it("대조: 맞는 형식이면 summary 값을 그대로 돌려준다", async () => {
    const { fetch } = fakeFetch({ "GET /api/usage/analytics": { body: ANALYTICS } });
    const a = await createClient({ baseUrl: "http://omni.test", credential: { token: "oma_live_x" }, fetch }).getAnalytics(range);
    expect(a.totalCost).toBe(0.014633);
    expect(a.byApiKey).toEqual([{ apiKeyId: "k1", requests: 3, cost: 0.014633 }]);
  });

  it("summary.totalCost 가 문자열인 응답 → OmniRouteFormatError", async () => {
    const body = { ...ANALYTICS, summary: { ...ANALYTICS.summary, totalCost: "0.014633" } };
    const { fetch } = fakeFetch({ "GET /api/usage/analytics": { body } });
    const c = createClient({ baseUrl: "http://omni.test", credential: { token: "oma_live_x" }, fetch });
    await expect(c.getAnalytics(range)).rejects.toThrow(OmniRouteFormatError);
    await expect(c.getAnalytics(range)).rejects.toThrow(/summary\.totalCost/);
  });

  it("summary 가 없거나 비용이 NaN 이 되는 응답도 오류", async () => {
    for (const body of [{ byApiKey: [] }, { ...ANALYTICS, summary: { ...ANALYTICS.summary, totalCost: null } }, { ...ANALYTICS, byApiKey: [{ apiKeyId: "k1", requests: 3, cost: "x" }] }]) {
      const { fetch } = fakeFetch({ "GET /api/usage/analytics": { body } });
      await expect(createClient({ baseUrl: "http://omni.test", credential: { token: "t" }, fetch }).getAnalytics(range)).rejects.toThrow(OmniRouteFormatError);
    }
  });

  it("2xx 가 아니면 상태·코드를 담은 OmniRouteError", async () => {
    const { fetch } = fakeFetch({ "GET /api/usage/analytics": { status: 403, body: { error: { code: "AUTH_SCOPE", message: "no" } } } });
    const err = await createClient({ baseUrl: "http://omni.test", credential: { token: "t" }, fetch }).getAnalytics(range).catch((e) => e);
    expect(err).toBeInstanceOf(OmniRouteError);
    expect({ status: err.status, code: err.code }).toEqual({ status: 403, code: "AUTH_SCOPE" });
  });
});

describe("TC-S5.T2.i 어댑터는 키 범위(scopes)를 보내지 않는다", () => {
  it("모든 함수의 요청 본문에 scopes 가 없고, 키 수정 본문은 isActive 또는 name 하나뿐이다", async () => {
    const { fetch, sent } = fakeFetch({
      "GET /api/keys": { body: { keys: [{ id: "k1", name: "m_1", isActive: true, scopes: ["self:usage"] }] } },
      "POST /api/keys": { status: 201, body: { id: "k1", key: "sk-abc", name: "m_1" } },
      "PATCH *": { body: { isActive: false, name: "m_2" } },
      "DELETE *": { body: { success: true } },
      "POST /api/usage/budget": { body: { success: true, apiKeyId: "k1", budget: { monthlyLimitUsd: 1, resetInterval: "monthly" } } },
      "GET /api/usage/analytics": { body: ANALYTICS },
      "GET /api/usage/call-logs": { body: [] },
      "GET /api/cli/whoami": { body: { id: "tok_1", name: "x", scope: "write", expiresAt: null } },
    });
    for (const credential of [{ token: "oma_live_x" }, { cookie: "auth_token=y" }]) {
      const c = createClient({ baseUrl: "http://omni.test", credential, fetch });
      await c.whoami();
      await c.listKeys();
      await c.createKey("m_1");
      await c.setKeyActive("k1", false);
      await c.renameKey("k1", "m_2");
      await c.deleteKey("k1");
      await c.setBudget("k1", { monthlyUsd: 1 });
      await c.getAnalytics(range);
      await c.getCallLogs();
    }
    expect(sent.length).toBe(18);
    for (const s of sent) expect(s.body ?? "").not.toMatch(/scopes/i);
    const patches = sent.filter((s) => s.method === "PATCH").map((s) => JSON.parse(s.body!));
    expect(patches).toEqual([{ isActive: false }, { name: "m_2" }, { isActive: false }, { name: "m_2" }]);
  });

  it("키 수정 함수에 다른 값을 끼워 넣을 수 없다 (형식 검사로 거부, 요청을 보내지 않음)", async () => {
    const { fetch, sent } = fakeFetch({ "PATCH *": { body: { isActive: true, name: "x" } } });
    const c = createClient({ baseUrl: "http://omni.test", credential: { token: "t" }, fetch });
    const smuggled = { scopes: ["manage"] } as any;
    await expect(c.setKeyActive("k1", smuggled)).rejects.toThrow(TypeError);
    await expect(c.renameKey("k1", smuggled)).rejects.toThrow(TypeError);
    await expect(c.createKey(smuggled)).rejects.toThrow(TypeError);
    expect(sent).toHaveLength(0);
    // 클라이언트에는 키 범위를 다루는 함수가 없다
    expect(Object.keys(c).filter((k) => /scope/i.test(k))).toEqual([]);
  });
});

describe("TC-S5.T2.j 월 예산은 양수만 받는다 (0 은 OmniRoute 에서 무제한)", () => {
  it("0·음수·NaN·Infinity·문자열 → TypeError, 요청 0건. 양수는 보낸다", async () => {
    const { fetch, sent } = fakeFetch({
      "POST /api/usage/budget": { body: { success: true, apiKeyId: "k1", budget: { monthlyLimitUsd: 0.5, resetInterval: "monthly" } } },
    });
    const c = createClient({ baseUrl: "http://omni.test", credential: { token: "t" }, fetch });
    for (const monthlyUsd of [0, -0, -1, Number.NaN, Number.POSITIVE_INFINITY, "1" as any]) {
      await expect(c.setBudget("k1", { monthlyUsd })).rejects.toThrow(TypeError);
    }
    expect(sent).toHaveLength(0);
    await c.setBudget("k1", { monthlyUsd: 0.5 });
    expect(sent.map((x) => JSON.parse(x.body!).monthlyLimitUsd)).toEqual([0.5]);
  });
});
