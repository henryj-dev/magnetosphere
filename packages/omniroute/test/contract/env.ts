// 계약 테스트 공용: 계약 환경(tests/contract) 주소와 회원 도구 쪽 추론 요청.
// 주소·비밀번호는 tests/contract/run.mjs 가 넘긴다. 기본값은 tests/contract/docker-compose.yml 과 같다.
// 관리 API 는 어댑터(src/)로 부른다. 여기서 직접 부르는 것은 회원 도구가 쓰는 /v1 과, 어댑터에 두지 않는 시험 정리(접근 토큰 회수)뿐이다.

export const OMNI_URL = process.env.OMNI_URL ?? "http://127.0.0.1:20170";
export const OMNI_PASSWORD = process.env.OMNI_PASSWORD ?? "contract-initial-password-5c1e9a";
/** tests/contract/setup.mjs 가 등록한 가짜 모델 */
export const MODELS = { openai: "mko/mock-gpt", anthropic: "mka/claude-mock" } as const;

export interface InferResult {
  status: number;
  headers: Headers;
  body: string;
  json: any;
}

/** 회원 키로 추론 요청을 보낸다. 스트리밍이면 본문을 끝까지 읽어 OmniRoute 가 기록을 마치게 한다 */
export async function infer(key: string | null, kind: "openai" | "anthropic", opts: { stream?: boolean; path?: string } = {}): Promise<InferResult> {
  const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
  if (key) headers.authorization = `Bearer ${key}`;
  const messages = [{ role: "user", content: "contract ping" }];
  const [path, body] =
    kind === "openai"
      ? ["/v1/chat/completions", { model: MODELS.openai, messages, stream: !!opts.stream }]
      : ["/v1/messages", { model: MODELS.anthropic, max_tokens: 50, messages, stream: !!opts.stream }];
  const res = await fetch(OMNI_URL + (opts.path ?? path), { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 스트리밍 본문은 JSON 이 아니다
  }
  return { status: res.status, headers: res.headers, body: text, json };
}

/** 대시보드 비밀번호 로그인 쿠키 (시험 정리용) */
async function adminCookie(): Promise<string> {
  const res = await fetch(`${OMNI_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: OMNI_URL },
    body: JSON.stringify({ password: OMNI_PASSWORD }),
  });
  const cookie = res.headers.getSetCookie().map((s) => s.split(";")[0]).find((s) => s.startsWith("auth_token="));
  if (!cookie) throw new Error(`로그인 실패 ${res.status}`);
  return cookie;
}

/**
 * 시험에서 만든 접근 토큰을 회수한다. write 토큰은 토큰을 못 지우므로(V10) 대시보드 쿠키로 지운다.
 * 회원 앱은 토큰을 회수하지 않으므로 어댑터에 두지 않는다.
 */
export async function revokeTokens(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const cookie = await adminCookie();
  for (const id of ids) {
    await fetch(`${OMNI_URL}/api/cli/tokens/${id}`, { method: "DELETE", headers: { cookie, origin: OMNI_URL } });
  }
}
