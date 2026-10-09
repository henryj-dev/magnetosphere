// OmniRoute 부트스트랩 (계획서 4.7 3번, 5.8, V10).
//   최초 관리자를 만든 같은 설치 요청에서 INITIAL_PASSWORD 로 POST /api/cli/connect 를 불러 write 범위 oma_live_ 토큰을 만들고,
//   whoami 로 범위를 확인한 뒤 APP_ENCRYPTION_KEY 로 암호화해 app_settings 에 둔다.
//   자동 발급이 안 되면(주소·비밀번호 없음, 비밀번호 틀림, 연결 실패) 설치는 그대로 끝내고 "manual_required" 를 돌려준다
//   (관리자는 이미 만들어졌다, TC-S5.T3.c). 관리자는 로그인한 뒤 토큰을 붙여 넣는다 (saveManualToken).
// 범위는 정확히 write 만 받는다. admin 토큰은 제공자 연결까지 바꿀 수 있어 받지 않고, read 는 키를 못 만든다 (V10).
// 이 파일은 OmniRoute 를 직접 부르지 않고 @magnetosphere/omniroute 어댑터만 쓴다 (TC-S5.T2.h).
//
// 환경 변수 (런타임 secret)
//   OMNIROUTE_URL               회원 앱이 보는 OmniRoute 주소 (Docker: http://omniroute:20128, 계획서 3.3)
//   OMNIROUTE_INITIAL_PASSWORD  OmniRoute INITIAL_PASSWORD 와 같은 값. 없으면 자동 발급을 건너뛰고 붙여 넣기로 간다
import { eq } from "drizzle-orm";
import { createAccessToken, createClient, OmniRouteError, type ConnectOptions } from "@magnetosphere/omniroute";
import type { Cipher } from "@magnetosphere/runtime/crypto";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { writeSetting } from "./index.ts";

export const OMNIROUTE_TOKEN_KEY = "omniroute_token";
/** 토큰 암호문의 AAD. 다른 자리로 옮겨 붙인 암호문은 열리지 않는다 */
export const OMNIROUTE_TOKEN_AAD = "app_settings.omniroute_token";
/** 회원 앱이 쓰는 관리 토큰 범위 (V10 answer.minScope) */
export const OMNIROUTE_SCOPE = "write";
/** /api/cli/connect 가 받는 최대 기간. 갱신 흐름은 아직 없다 */
const TOKEN_DAYS = 3650;
const TIMEOUT_MS = 10_000;

export interface OmniRouteConfig {
  baseUrl: string | null;
  initialPassword: string | null;
  fetch?: typeof fetch;
}

export type OmniRouteStatus = "connected" | "manual_required";

interface StoredToken {
  /** cipher.encrypt 결과 ("v1:...") */
  token: string;
  id: string;
  scope: string;
  expiresAt: string | null;
}

function conn(cfg: OmniRouteConfig): ConnectOptions {
  return { baseUrl: cfg.baseUrl!, fetch: cfg.fetch, timeoutMs: TIMEOUT_MS };
}

/** 실패 이유. 비밀번호·토큰은 넣지 않는다 */
function reason(e: unknown): string {
  if (e instanceof OmniRouteError) return `OmniRoute ${e.status}${e.code ? ` ${e.code}` : ""}`;
  return e instanceof Error ? e.name : "unknown";
}

async function store(h: DbHandle, cipher: Cipher, token: string, info: { id: string; scope: string; expiresAt: string | null }, updatedBy: string | null) {
  const value: StoredToken = { token: await cipher.encrypt(token, OMNIROUTE_TOKEN_AAD), id: info.id, scope: info.scope, expiresAt: info.expiresAt };
  await writeSetting(h, OMNIROUTE_TOKEN_KEY, value, updatedBy);
}

/** 토큰으로 whoami 를 불러 범위가 write 인지 본다. 아니면 이유를 돌려준다 */
async function checkScope(cfg: OmniRouteConfig, token: string) {
  const me = await createClient({ ...conn(cfg), credential: { token } }).whoami();
  return me.scope === OMNIROUTE_SCOPE ? { ok: true as const, me } : { ok: false as const, scope: me.scope };
}

/** 설치 3단계: 비밀번호로 토큰을 만들어 저장한다. 실패해도 예외를 던지지 않는다 */
export async function bootstrapOmniRoute(
  h: DbHandle,
  cipher: Cipher,
  cfg: OmniRouteConfig,
  updatedBy: string,
): Promise<{ status: OmniRouteStatus; reason?: string }> {
  if (!cfg.baseUrl) return { status: "manual_required", reason: "OMNIROUTE_URL 없음" };
  if (!cfg.initialPassword) return { status: "manual_required", reason: "OMNIROUTE_INITIAL_PASSWORD 없음" };
  try {
    const t = await createAccessToken(conn(cfg), {
      password: cfg.initialPassword,
      scope: OMNIROUTE_SCOPE,
      name: `magnetosphere-${new Date().toISOString().slice(0, 10)}`,
      expiresInDays: TOKEN_DAYS,
    });
    const checked = await checkScope(cfg, t.token);
    if (!checked.ok) return { status: "manual_required", reason: `범위가 ${checked.scope}` };
    await store(h, cipher, t.token, checked.me, updatedBy);
    return { status: "connected" };
  } catch (e) {
    return { status: "manual_required", reason: reason(e) };
  }
}

export type ManualTokenResult = { ok: true } | { ok: false; error: "invalid_token" | "scope_not_write" | "omniroute_unreachable" };

/** 관리자가 붙여 넣은 토큰을 whoami 로 확인하고 저장한다 */
export async function saveManualToken(h: DbHandle, cipher: Cipher, cfg: OmniRouteConfig, token: unknown, updatedBy: string): Promise<ManualTokenResult> {
  if (typeof token !== "string" || !/^oma_live_[A-Za-z0-9_-]+$/.test(token.trim())) return { ok: false, error: "invalid_token" };
  if (!cfg.baseUrl) return { ok: false, error: "omniroute_unreachable" };
  try {
    const checked = await checkScope(cfg, token.trim());
    if (!checked.ok) return { ok: false, error: "scope_not_write" };
    await store(h, cipher, token.trim(), checked.me, updatedBy);
    return { ok: true };
  } catch (e) {
    if (e instanceof OmniRouteError && (e.status === 401 || e.status === 403)) return { ok: false, error: "invalid_token" };
    return { ok: false, error: "omniroute_unreachable" };
  }
}

/** 저장된 토큰 원문. 없으면 null. 복호화 실패(키·AAD·변조)는 예외 */
export async function readOmniRouteToken(h: DbHandle, cipher: Cipher): Promise<string | null> {
  const t = h.schema.appSettings;
  const [row] = await h.db.select({ value: t.value }).from(t).where(eq(t.key, OMNIROUTE_TOKEN_KEY));
  if (!row) return null;
  return cipher.decrypt((JSON.parse(row.value) as StoredToken).token, OMNIROUTE_TOKEN_AAD);
}

export async function omniRouteStatus(h: DbHandle): Promise<OmniRouteStatus> {
  const t = h.schema.appSettings;
  const rows = await h.db.select({ key: t.key }).from(t).where(eq(t.key, OMNIROUTE_TOKEN_KEY));
  return rows.length > 0 ? "connected" : "manual_required";
}
