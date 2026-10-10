// OmniRoute 관리 API 어댑터 (계획서 5.6). 회원 앱의 OmniRoute 호출은 이 패키지에서만 한다 (TC-S5.T2.h).
// 대상 버전은 3.8.51 이다 (tests/contract/docker-compose.yml 의 digest). 버전을 올리면 계약 테스트가 통과해야 한다.
//
// 인증 두 가지 (0단계 5절, V10)
//   - 접근 토큰: oma_live_… 를 Bearer 로. 회원 앱이 서버 간 호출에 쓴다 (범위 write, 계획서 5.8)
//   - 대시보드 쿠키: auth_token. 변경 요청(GET 이 아닌 것)에는 OmniRoute 주소의 Origin 을 붙인다 (TC-S5.T2.g).
//     3.8.51 은 Origin 이 없으면 통과시키고, 있는데 다르면 INVALID_ORIGIN 으로 막는다 (계약 환경 실측, src/server/origin/publicOrigin.ts).
//     0단계 메모의 "없으면 AUTH_001" 은 쿠키가 없던 요청이었다. 브라우저가 아닌 호출의 예외가 닫혀도 깨지지 않게 맞는 Origin 을 보낸다
//
// 키 범위(scopes)는 절대 보내지 않는다. write 토큰이 키에 manage 를 붙이면 admin 토큰까지 만들 수 있다 (V10 privilegeEscalation).
// 키 수정은 setKeyActive(isActive) 와 renameKey(name) 둘뿐이고, 본문은 그 필드 하나로만 만든다 (계획서 5.8, TC-S5.T2.i).
//
// Node 전용 API 를 쓰지 않는다 (Workers 에서도 같은 코드).
import type { z } from "zod";
import {
  accessTokenSchema,
  analyticsSchema,
  budgetReadSchema,
  budgetSchema,
  callLogsSchema,
  createdKeySchema,
  keyActiveSchema,
  keyListSchema,
  keyNameSchema,
  unusedBodySchema,
  whoamiSchema,
  type SCOPES,
} from "./schemas.ts";

export type Scope = (typeof SCOPES)[number];

/** OmniRoute 가 2xx 가 아닌 응답을 줬다 */
export class OmniRouteError extends Error {
  readonly status: number;
  /** 응답 본문의 오류 코드 (예: AUTH_001, BUDGET_EXCEEDED). 없으면 null */
  readonly code: string | null;
  constructor(method: string, path: string, status: number, code: string | null, detail: string) {
    super(`OmniRoute ${method} ${path} → ${status}${code ? ` ${code}` : ""}: ${detail}`);
    this.name = "OmniRouteError";
    this.status = status;
    this.code = code;
  }
}

/** 응답이 2xx 지만 우리가 쓰는 필드의 형식이 맞지 않는다 (OmniRoute 버전 변화 의심) */
export class OmniRouteFormatError extends Error {
  readonly issues: z.core.$ZodIssue[];
  constructor(method: string, path: string, issues: z.core.$ZodIssue[]) {
    super(`OmniRoute ${method} ${path} 응답 형식이 다르다: ${issues.map((i) => `${i.path.join(".") || "(본문)"} ${i.message}`).join("; ")}`);
    this.name = "OmniRouteFormatError";
    this.issues = issues;
  }
}

export interface ConnectOptions {
  /** OmniRoute 주소 (예: http://omniroute:20128). 끝 슬래시는 무시한다 */
  baseUrl: string;
  fetch?: typeof fetch;
  /** 요청 하나의 제한 시간 (기본 15초) */
  timeoutMs?: number;
  /** 여러 호출이 함께 쓸 중단 신호. 주면 timeoutMs 대신 이것만 쓴다 (호출 여러 개를 한 제한 시간에 묶을 때) */
  signal?: AbortSignal;
}

export type Credential = { token: string } | { cookie: string };

interface Request {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
  credential?: Credential;
  /** 쿠키 없이도 Origin 을 붙인다 (대시보드 로그인) */
  origin?: boolean;
}

function base(o: ConnectOptions): string {
  return o.baseUrl.replace(/\/+$/, "");
}

function errorCode(json: any): string | null {
  const c = json?.error?.code ?? json?.code;
  return typeof c === "string" ? c : null;
}

async function call<S extends z.ZodType>(o: ConnectOptions, req: Request, schema: S): Promise<{ data: z.infer<S>; headers: Headers }> {
  const url = base(o) + req.path;
  const headers: Record<string, string> = { accept: "application/json" };
  if (req.credential && "token" in req.credential) headers.authorization = `Bearer ${req.credential.token}`;
  if (req.credential && "cookie" in req.credential) headers.cookie = req.credential.cookie;
  // 쿠키 인증 변경 요청에는 OmniRoute 주소의 Origin 을 붙인다 (CSRF 방어 검사, 위 머리 주석)
  if (req.origin || (req.credential && "cookie" in req.credential && req.method !== "GET")) headers.origin = new URL(url).origin;
  if (req.body !== undefined) headers["content-type"] = "application/json";
  const res = await (o.fetch ?? fetch)(url, {
    method: req.method,
    headers,
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
    signal: o.signal ?? AbortSignal.timeout(o.timeoutMs ?? 15_000),
    // 리다이렉트를 따라가지 않는다. 307·308 은 본문({password} 포함)과 함께 다른 출처로 넘어간다 (S5 보안 리뷰 L1).
    // "error" 는 Workers fetch 가 받지 않아(TypeError, S6 E2E workers-* 에서 발견) "manual" 로 받고, 3xx 는 아래 !res.ok 로 오류가 된다
    redirect: "manual",
  });
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    // JSON 이 아니면 아래에서 형식 오류나 HTTP 오류로 처리한다
  }
  if (!res.ok) throw new OmniRouteError(req.method, req.path, res.status, errorCode(json), text.slice(0, 300));
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new OmniRouteFormatError(req.method, req.path, parsed.error.issues);
  return { data: parsed.data, headers: res.headers };
}

function requireText(name: string, v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") throw new TypeError(`${name} 는 비어 있지 않은 문자열이어야 한다`);
  return v;
}

/**
 * OmniRoute 키 id. 실측 id 는 UUID 다. 영숫자·_·- 만 받는다 (S5 보안 리뷰 L3):
 * "."·".." 은 경로를 바꾸고(/api/keys/.. → /api), 쉼표는 getAnalytics 의 apiKeyIds 를 여러 키로 늘린다
 */
function requireId(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]+$/.test(v)) throw new TypeError("키 id 는 영숫자·_·- 로만 된 문자열이어야 한다");
  return v;
}

const keyPath = (id: string) => `/api/keys/${requireId(id)}`;

/** 대시보드 비밀번호 로그인. 돌려준 쿠키로 createClient({ credential: { cookie } }) 를 만든다 */
export async function loginWithPassword(o: ConnectOptions, password: string): Promise<{ cookie: string }> {
  const path = "/api/auth/login";
  const { headers } = await call(o, { method: "POST", path, body: { password: requireText("password", password) }, origin: true }, unusedBodySchema);
  const cookie = headers.getSetCookie().map((s) => s.split(";")[0]).find((s) => s.startsWith("auth_token="));
  if (!cookie) throw new OmniRouteFormatError("POST", path, [{ code: "custom", path: ["set-cookie"], message: "auth_token 쿠키가 없다", input: undefined }]);
  return { cookie };
}

export interface AccessToken {
  token: string;
  id: string;
  scope: Scope;
  expiresAt: string | null;
}

/**
 * 관리 비밀번호(INITIAL_PASSWORD)로 oma_live_ 접근 토큰을 만든다 (V10 mintApi, 계획서 4.7 3번).
 * 공개 경로라 다른 인증이 필요 없다. 비밀번호가 틀리면 401, 실패가 5번 쌓이면 15분 동안 429 다.
 */
export async function createAccessToken(
  o: ConnectOptions,
  input: { password: string; scope: Scope; name: string; expiresInDays: number },
): Promise<AccessToken> {
  const { data } = await call(
    o,
    {
      method: "POST",
      path: "/api/cli/connect",
      body: {
        password: requireText("password", input.password),
        name: requireText("name", input.name),
        scope: input.scope,
        expiresInDays: input.expiresInDays,
      },
    },
    accessTokenSchema,
  );
  return data;
}

export interface KeyInfo {
  id: string;
  name: string;
  isActive: boolean;
  /** OmniRoute 키 범위. 회원 앱은 쓰지 않고 읽기만 한다 (정합성 점검, 계획서 5.8) */
  scopes: string[];
}

export interface Analytics {
  totalCost: number;
  totalRequests: number;
  promptTokens: number;
  completionTokens: number;
  byApiKey: { apiKeyId: string | null; requests: number; cost: number }[];
}

export interface CallLog {
  id: string;
  timestamp: string;
  status: number;
  model: string | null;
  requestedModel: string | null;
  apiKeyId: string;
  tokens: { in: number | null; out: number | null; cacheRead?: number | null; cacheWrite?: number | null };
}

const isoTime = (name: string, v: Date | string): string => {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new TypeError(`${name} 가 올바른 시각이 아니다`);
  return d.toISOString();
};

export function createClient(o: ConnectOptions & { credential: Credential }) {
  const credential = o.credential;
  const req = <S extends z.ZodType>(r: Omit<Request, "credential">, s: S) => call(o, { ...r, credential }, s).then((x) => x.data);

  return {
    /** 이 자격 증명의 범위. 접근 토큰이면 어떤 범위든 200 이다 (V10 tokenScopeVisibility) */
    whoami: () => req({ method: "GET", path: "/api/cli/whoami" }, whoamiSchema),

    /**
     * 모든 키. 3.8.51 은 limit 을 주지 않으면 페이지를 나누지 않고 전부 준다 (V28: SELECT * FROM api_keys ORDER BY created_at).
     * 받은 키가 total 보다 적으면 목록이 잘린 것으로 보고 OmniRouteFormatError 다 — 정합성 점검이 일부 키만 보고 지나가지 않게 (fail-closed).
     * 목록과 total 은 OmniRoute 가 따로 읽어 그 사이 키가 생기면 keys 가 더 많을 수 있다. 그것은 받는다
     */
    async listKeys(): Promise<KeyInfo[]> {
      const r = await req({ method: "GET", path: "/api/keys" }, keyListSchema);
      if (r.keys.length < r.total) {
        throw new OmniRouteFormatError("GET", "/api/keys", [{ code: "custom", path: ["keys"], message: `키 ${r.keys.length}개, total ${r.total} (목록이 잘렸다)`, input: r.total }]);
      }
      return r.keys;
    },

    /** 원문 키는 이 응답에 한 번만 온다. 저장하지 않고 회원에게 한 번 보여 준다 (계획서 5.2) */
    async createKey(name: string) {
      return req({ method: "POST", path: "/api/keys", body: { name: requireText("name", name) } }, createdKeySchema);
    },

    async setKeyActive(id: string, active: boolean): Promise<void> {
      if (typeof active !== "boolean") throw new TypeError("active 는 boolean 이어야 한다");
      const r = await req({ method: "PATCH", path: keyPath(id), body: { isActive: active } }, keyActiveSchema);
      if (r.isActive !== active) throw new OmniRouteFormatError("PATCH", keyPath(id), [{ code: "custom", path: ["isActive"], message: `요청 ${active}, 응답 ${r.isActive}`, input: r.isActive }]);
    },

    async renameKey(id: string, name: string): Promise<void> {
      await req({ method: "PATCH", path: keyPath(id), body: { name: requireText("name", name) } }, keyNameSchema);
    },

    async deleteKey(id: string): Promise<void> {
      await call(o, { method: "DELETE", path: keyPath(id), credential }, unusedBodySchema);
    },

    /**
     * 키 하나의 월 예산. 넘으면 OmniRoute 가 429 BUDGET_EXCEEDED 로 막는다 (TC-S5.T2.d).
     * OmniRoute 는 resetInterval 에 맞는 한도 하나만 본다. monthly 로 두지 않으면 monthlyLimitUsd 가 무시된다 (계약 환경 실측).
     * 한도 0 은 차단이 아니라 "한도 없음"이다 (OmniRoute 는 한도가 0보다 클 때만 막는다, TC-S5.T2.j). 그래서 양수만 받는다.
     * 남은 한도가 0 인 회원을 막으려면 예산 대신 setKeyActive(false) 로 키를 끈다 (S5 보안 리뷰 M1).
     */
    async setBudget(id: string, budget: { monthlyUsd: number }): Promise<void> {
      const monthly = budget.monthlyUsd;
      if (typeof monthly !== "number" || !Number.isFinite(monthly) || monthly <= 0) {
        throw new TypeError("monthlyUsd 는 0보다 큰 유한한 수여야 한다 (0 은 OmniRoute 에서 무제한이다. 막으려면 setKeyActive(false))");
      }
      const r = await req(
        {
          method: "POST",
          path: "/api/usage/budget",
          body: { apiKeyId: requireId(id), dailyLimitUsd: 0, weeklyLimitUsd: 0, monthlyLimitUsd: monthly, resetInterval: "monthly" },
        },
        budgetSchema,
      );
      if (r.budget.resetInterval !== "monthly" || r.budget.monthlyLimitUsd !== monthly) {
        throw new OmniRouteFormatError("POST", "/api/usage/budget", [{ code: "custom", path: ["budget"], message: `월 예산이 반영되지 않았다: ${JSON.stringify(r.budget)}`, input: r.budget }]);
      }
    },

    /**
     * 키의 월 예산을 푼다 (무제한). OmniRoute 는 한도 0 을 "한도 없음"으로 본다 (V20 zeroIsUnlimited).
     * 회원 한도가 무제한(NULL)으로 바뀐 경우에만 부른다 (K2 리뷰 M3, apps 에서는 분배의 무제한 전환 경로 한 곳, G-K2 grep).
     * 남은 한도 0 인 회원을 막는 데 쓰지 않는다. 그때는 setKeyActive(false) 다.
     */
    async clearBudget(id: string): Promise<void> {
      const r = await req(
        {
          method: "POST",
          path: "/api/usage/budget",
          body: { apiKeyId: requireId(id), dailyLimitUsd: 0, weeklyLimitUsd: 0, monthlyLimitUsd: 0, resetInterval: "monthly" },
        },
        budgetSchema,
      );
      if (r.budget.monthlyLimitUsd !== 0) {
        throw new OmniRouteFormatError("POST", "/api/usage/budget", [{ code: "custom", path: ["budget"], message: `월 예산이 풀리지 않았다: ${JSON.stringify(r.budget)}`, input: r.budget }]);
      }
    },

    /**
     * 키 하나의 월 예산 읽기 (GET /api/usage/budget?apiKeyId=). 0 은 무제한이다 (V20). 회원 앱 동작은 이 값을 읽지 않고
     * 우리 DB 의 budget_usd 를 쓴다 — 시험이 OmniRoute 에 실제로 걸린 예산을 교차 확인할 때 쓴다 (K5 리뷰 L2)
     */
    async getBudget(id: string): Promise<{ monthlyUsd: number; resetInterval: "daily" | "weekly" | "monthly" }> {
      const r = await req({ method: "GET", path: `/api/usage/budget?${new URLSearchParams({ apiKeyId: requireId(id) })}` }, budgetReadSchema);
      return { monthlyUsd: r.budget.monthlyLimitUsd, resetInterval: r.budget.resetInterval };
    },

    /**
     * 키별 사용량 (스트리밍 포함, 0단계 추가 1). startDate·endDate 는 ISO 시각으로 보낸다 (날짜만 보내면 0 이 나온다).
     * OmniRoute 는 timestamp >= startDate AND timestamp <= endDate 로 거른다 (양 끝 포함, 3.8.51).
     * apiKeyIds 를 빼면 모든 키다 (1분 분배의 오늘 창, 계획서 v5.7 5.3). 주면 비어 있지 않아야 한다 — 빈 목록을 "전체"로 읽으면
     * 회원 하나를 부르려다 모든 키 비용을 그 회원에게 더한다.
     */
    async getAnalytics(q: { apiKeyIds?: string[]; startDate: Date | string; endDate: Date | string }): Promise<Analytics> {
      if (q.apiKeyIds !== undefined && (!Array.isArray(q.apiKeyIds) || q.apiKeyIds.length === 0)) throw new TypeError("apiKeyIds 가 비어 있다");
      const p = new URLSearchParams({
        ...(q.apiKeyIds ? { apiKeyIds: q.apiKeyIds.map(requireId).join(",") } : {}),
        startDate: isoTime("startDate", q.startDate),
        endDate: isoTime("endDate", q.endDate),
      });
      const r = await req({ method: "GET", path: `/api/usage/analytics?${p}` }, analyticsSchema);
      return { ...r.summary, byApiKey: r.byApiKey };
    },

    /** 최근 호출 기록 중 완료 기록만 (apiKeyId 가 있는 줄, 0단계 2절). 비용은 없다 */
    async getCallLogs(q: { limit?: number; offset?: number } = {}): Promise<CallLog[]> {
      const p = new URLSearchParams({ limit: String(q.limit ?? 50), offset: String(q.offset ?? 0) });
      const rows = await req({ method: "GET", path: `/api/usage/call-logs?${p}` }, callLogsSchema);
      return rows.filter((r): r is CallLog => typeof r.apiKeyId === "string" && r.apiKeyId !== "");
    },
  };
}

export type OmniRouteClient = ReturnType<typeof createClient>;
