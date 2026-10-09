// 어댑터 계약 테스트 (S5.T2, 계획서 5.6). 계약 환경의 실제 OmniRoute 3.8.51 에 어댑터로 붙는다.
// 테스트마다 키를 새로 만들고 끝나면 지운다. 접근 토큰은 파일에서 하나만 만들고 끝나면 회수한다.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccessToken, createClient, loginWithPassword, OmniRouteError, type OmniRouteClient } from "../../src/index.ts";
import { infer, OMNI_PASSWORD, OMNI_URL, revokeTokens } from "./env.ts";

const conn = { baseUrl: OMNI_URL };
const tokenIds: string[] = [];
const keyIds: string[] = [];
let client: OmniRouteClient;
let adapterToken = "";

beforeAll(async () => {
  const t = await createAccessToken(conn, { password: OMNI_PASSWORD, scope: "write", name: "contract-adapter", expiresInDays: 1 });
  tokenIds.push(t.id);
  adapterToken = t.token;
  client = createClient({ ...conn, credential: { token: t.token } });
});

afterAll(async () => {
  for (const id of keyIds) await client.deleteKey(id).catch(() => {});
  await revokeTokens(tokenIds);
});

async function newKey(label: string) {
  const k = await client.createKey(`contract-${label}-${Date.now().toString(36)}`);
  keyIds.push(k.id);
  return k;
}

/** 0단계 회원 B 와 같은 요청 3건: OpenAI 비스트리밍 0.00221 + Anthropic 비스트리밍 0.0062115 + Anthropic 스트리밍 0.0062115 */
async function threeRequests(key: string) {
  const statuses = [
    (await infer(key, "openai")).status,
    (await infer(key, "anthropic")).status,
    (await infer(key, "anthropic", { stream: true })).status,
  ];
  expect(statuses).toEqual([200, 200, 200]);
}
const THREE_COST = 0.00221 + 0.0062115 * 2;

/** OmniRoute 가 기록을 마칠 때까지 조건을 다시 본다 */
async function eventually<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (done(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
}

describe("TC-S5.T2.a 키 없는 /v1 요청은 401 이다", () => {
  it("/v1/models, /v1/chat/completions 키 없이 → 둘 다 401", async () => {
    const models = await fetch(`${OMNI_URL}/v1/models`);
    expect(models.status).toBe(401);
    expect((await infer(null, "openai")).status).toBe(401);
  });
});

describe("TC-S5.T2.b 생성 → 끄기 → 예산 → 켜기 → 요청 순서가 동작한다", () => {
  it("createKey → setKeyActive(false) → setBudget(monthly 1.0) → setKeyActive(true) → 요청 200, 로그·분석에 그 키", async () => {
    const start = new Date(Date.now() - 60_000);
    const k = await newKey("t2b");
    await client.setKeyActive(k.id, false);
    await client.setBudget(k.id, { monthlyUsd: 1.0 });
    await client.setKeyActive(k.id, true);
    expect((await infer(k.key, "openai")).status).toBe(200);

    const listed = (await client.listKeys()).find((x) => x.id === k.id);
    expect(listed).toMatchObject({ id: k.id, name: k.name, isActive: true });
    const logs = await eventually(() => client.getCallLogs({ limit: 50 }), (rows) => rows.some((r) => r.apiKeyId === k.id));
    expect(logs.find((r) => r.apiKeyId === k.id)).toMatchObject({ status: 200, tokens: { in: 111, out: 22 } });
    const a = await eventually(
      () => client.getAnalytics({ apiKeyIds: [k.id], startDate: start, endDate: new Date(Date.now() + 60_000) }),
      (x) => x.totalRequests === 1,
    );
    expect(a.totalCost).toBeCloseTo(0.00221, 9);
  });
});

describe("TC-S5.T2.c 끈 키는 거부된다", () => {
  it("setKeyActive(false) 직후(지연 0ms, V11 delayMs 0) 요청 → 403 permission_denied", async () => {
    const k = await newKey("t2c");
    expect((await infer(k.key, "openai")).status).toBe(200);
    await client.setKeyActive(k.id, false);
    const r = await infer(k.key, "openai");
    expect(r.status).toBe(403);
    expect(r.json?.error?.code).toBe("permission_denied");
  });
});

describe("TC-S5.T2.d 예산을 넘으면 429 로 막는다", () => {
  it("월 예산 0.01, 요청 3건(0.014633) 후 → 429, 예산 초과 (arm64 BUDGET_EXCEEDED · amd64 rate_limit_exceeded + 예산 메시지)", async () => {
    const k = await newKey("t2d");
    await client.setBudget(k.id, { monthlyUsd: 0.01 });
    await threeRequests(k.key);
    const r = await infer(k.key, "openai");
    const body = JSON.stringify(r.json);
    expect(r.status, body).toBe(429);
    // 같은 3.8.51 digest 라도 아키텍처마다 다른 빌드다 (S7 CI 실측: BUILD_ID 가 다르고 amd64 빌드에는 BUDGET_EXCEEDED 문자열이 없다).
    // arm64 는 code "BUDGET_EXCEEDED", amd64 는 code "rate_limit_exceeded" 에 "Monthly budget exceeded: $0.0146 / $0.01".
    // 회원 앱은 code 에 기대지 않으므로 둘 다 예산 차단으로 받되, 예산 때문인 것은 확인한다 (그냥 요청 수 제한과 구별)
    const code = r.json?.error?.code ?? r.json?.code;
    const message = String(r.json?.error?.message ?? r.json?.message ?? "");
    expect(code === "BUDGET_EXCEEDED" || (code === "rate_limit_exceeded" && /^Monthly budget exceeded: \$0\.0146 \/ \$0\.01/.test(message)), body).toBe(true);
  });
});

describe("TC-S5.T2.e 분석이 키별 비용을 정확히 낸다 (스트리밍 포함)", () => {
  it("3건(스트리밍 1건 포함) 뒤 getAnalytics(apiKeyIds=[그 키]) → totalCost 0.014633 (오차 1e-9)", async () => {
    const start = new Date(Date.now() - 60_000);
    const k = await newKey("t2e");
    await threeRequests(k.key);
    const a = await eventually(
      () => client.getAnalytics({ apiKeyIds: [k.id], startDate: start, endDate: new Date(Date.now() + 60_000) }),
      (x) => x.totalRequests === 3,
    );
    expect(a.totalRequests).toBe(3);
    expect(Math.abs(a.totalCost - THREE_COST)).toBeLessThan(1e-9);
    expect(a.byApiKey.find((x) => x.apiKeyId === k.id)?.requests).toBe(3);
  });
});

describe("TC-S5.T2.g 쿠키 인증 변경 요청에 Origin 이 붙는다", () => {
  it("다른 Origin 을 단 대조 요청 → INVALID_ORIGIN, 어댑터 경유 → 2xx 이고 Origin 은 OmniRoute 주소", async () => {
    const { cookie } = await loginWithPassword(conn, OMNI_PASSWORD);
    const foreign = await fetch(`${OMNI_URL}/api/keys`, {
      method: "POST",
      headers: { cookie, origin: "http://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ name: "contract-t2g-foreign" }),
    });
    expect(foreign.status).toBe(403);
    expect((await foreign.json()).error?.code).toBe("INVALID_ORIGIN");

    // 어댑터가 실제로 보낸 Origin 을 본다. 3.8.51 은 Origin 이 없어도 통과시키므로 2xx 만으로는 Origin 을 뺀 회귀를 못 잡는다
    const origins: (string | null)[] = [];
    const spy: typeof fetch = (input, init) => {
      if ((init?.method ?? "GET") !== "GET") origins.push(new Headers(init?.headers).get("origin"));
      return fetch(input, init);
    };
    const viaCookie = createClient({ ...conn, credential: { cookie }, fetch: spy });
    const k = await viaCookie.createKey(`contract-t2g-${Date.now().toString(36)}`);
    keyIds.push(k.id);
    await viaCookie.setKeyActive(k.id, false);
    await viaCookie.deleteKey(k.id);
    expect(origins).toEqual([new URL(OMNI_URL).origin, new URL(OMNI_URL).origin, new URL(OMNI_URL).origin]);
    const err = await viaCookie.deleteKey(k.id).catch((e) => e);
    expect(err).toBeInstanceOf(OmniRouteError);
    expect(err.status).toBe(404);
  });
});

describe("TC-S5.T2.j 월 예산은 양수만 받는다 (0 은 OmniRoute 에서 무제한)", () => {
  it("대조: 어댑터를 거치지 않고 monthlyLimitUsd 0 을 넣으면 3건(0.014633) 뒤 4번째 요청도 200", async () => {
    const k = await newKey("t2j");
    const token = adapterToken;
    const res = await fetch(`${OMNI_URL}/api/usage/budget`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ apiKeyId: k.id, dailyLimitUsd: 0, weeklyLimitUsd: 0, monthlyLimitUsd: 0, resetInterval: "monthly" }),
    });
    expect(res.status).toBe(200);
    await threeRequests(k.key);
    expect((await infer(k.key, "openai")).status).toBe(200);
    // 어댑터는 0 을 보내지 않는다
    await expect(client.setBudget(k.id, { monthlyUsd: 0 })).rejects.toThrow(TypeError);
  });
});
