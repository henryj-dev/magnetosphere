#!/usr/bin/env node
// 계약 환경 준비 (S5.T1). 0단계와 같은 방식으로 가짜 상위 서버를 제공자 둘로 붙이고 가격을 넣는다.
//   1. 대시보드 비밀번호 로그인 → auth_token 쿠키. 쿠키 인증 변경 요청에는 Origin 을 붙인다 (0단계 5절)
//   2. 제공자 노드 둘: OpenAI 호환(접두사 mko) · Anthropic 호환(접두사 mka) → POST /api/provider-nodes
//   3. 노드마다 연결 하나 → POST /api/providers, 만든 연결은 꺼져 있으므로 PATCH isActive=true
//   4. 가격 (백만 토큰당 입력 10, 출력 50, 캐시 읽기 1, 캐시 쓰기 12.5) → PATCH /api/pricing.
//      가격표 키는 제공자 id 와 접두사 둘 다 넣는다 (0단계 추가 3)
// 여러 번 돌려도 같은 상태가 된다. 이미 있는 노드·연결은 다시 만들지 않는다.
// 이 파일은 계약 환경을 만드는 시험 도구다. 회원 앱의 OmniRoute 호출은 packages/omniroute 에만 둔다.
//
// 환경 변수: OMNI_URL (기본 http://127.0.0.1:20170), OMNI_PASSWORD (기본 docker-compose.yml 의 INITIAL_PASSWORD)
import { pathToFileURL } from "node:url";

export const OMNI_URL = process.env.OMNI_URL ?? "http://127.0.0.1:20170";
export const OMNI_PASSWORD = process.env.OMNI_PASSWORD ?? "contract-initial-password-5c1e9a";
/** OmniRoute 컨테이너에서 본 가짜 상위 서버 주소 (compose 내부망) */
const MOCK = process.env.MOCK_UPSTREAM_URL ?? "http://mock:18080";

export const PRICE = { input: 10, output: 50, cached: 1, reasoning: 50, cache_creation: 12.5 };
export const NODES = [
  { type: "openai-compatible", name: "MockOpenAI", prefix: "mko", apiType: "chat", baseUrl: `${MOCK}/v1`, model: "mock-gpt" },
  { type: "anthropic-compatible", name: "MockAnthropic", prefix: "mka", baseUrl: MOCK, model: "claude-mock" },
];
/** 계약 테스트가 부르는 모델 이름 */
export const MODELS = { openai: "mko/mock-gpt", anthropic: "mka/claude-mock" };

async function http(method, path, { cookie, body } = {}) {
  const headers = { origin: OMNI_URL };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(OMNI_URL + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 본문이 JSON 이 아니면 text 만 쓴다
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return { res, json };
}

async function login() {
  const { res } = await http("POST", "/api/auth/login", { body: { password: OMNI_PASSWORD } });
  const cookie = res.headers.getSetCookie().map((s) => s.split(";")[0]).find((s) => s.startsWith("auth_token="));
  if (!cookie) throw new Error("로그인 응답에 auth_token 쿠키가 없다");
  return cookie;
}

/** OmniRoute 가 응답할 때까지 기다린다 (compose --wait 뒤에도 로그인 경로가 늦게 열릴 수 있다) */
async function waitReady(timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(`${OMNI_URL}/livez`)).ok) return;
    } catch {
      // 아직 안 떴다
    }
    if (Date.now() > end) throw new Error(`${OMNI_URL} 이 ${timeoutMs}ms 안에 뜨지 않았다`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function setup() {
  await waitReady();
  const cookie = await login();

  const nodes = (await http("GET", "/api/provider-nodes", { cookie })).json?.nodes ?? [];
  const ids = {};
  for (const n of NODES) {
    const { model, ...body } = n;
    let node = nodes.find((x) => x.prefix === n.prefix && x.type === n.type);
    if (!node) node = (await http("POST", "/api/provider-nodes", { cookie, body })).json.node;
    ids[n.prefix] = node.id;
  }

  const conns = (await http("GET", "/api/providers", { cookie })).json?.connections ?? [];
  for (const n of NODES) {
    const provider = ids[n.prefix];
    let conn = conns.find((c) => c.provider === provider);
    if (!conn) {
      conn = (await http("POST", "/api/providers", { cookie, body: { provider, name: `conn-${n.prefix}`, url: "x", apiKey: "mock-upstream-key" } })).json.connection;
    }
    if (!conn.isActive) await http("PATCH", `/api/providers/${conn.id}`, { cookie, body: { isActive: true } });
  }

  const pricing = {};
  for (const n of NODES) {
    pricing[ids[n.prefix]] = { [n.model]: PRICE };
    pricing[n.prefix] = { [n.model]: PRICE };
  }
  await http("PATCH", "/api/pricing", { cookie, body: pricing });
  return { nodes: ids };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await setup();
  console.log(`[contract] OmniRoute 준비 완료 ${OMNI_URL} 노드 ${JSON.stringify(r.nodes)}`);
}
