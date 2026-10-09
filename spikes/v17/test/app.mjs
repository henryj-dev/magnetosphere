// V17 최소 앱: better-auth 1.7.7 + better-sqlite3 (메모리 DB). 요청은 auth.handler 에 Request 로 직접 넣는다.
import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";

export const BASE = "http://localhost:3999";

// protect=true  → 다섯 칼럼 모두 input:false (계획서 4.6)
// protect=false → 대조군, input 을 지정하지 않음
export function fields(protect) {
  const lock = protect ? { input: false } : {};
  return {
    role: { type: "string", required: false, defaultValue: "member", ...lock },
    status: { type: "string", required: false, defaultValue: "active", ...lock },
    monthly_limit_usd: { type: "number", required: false, ...lock },
    max_keys: { type: "number", required: false, ...lock },
    is_bootstrap_admin: { type: "boolean", required: false, defaultValue: false, ...lock },
  };
}

export async function makeApp(protect) {
  const db = new Database(":memory:");
  const auth = betterAuth({
    baseURL: BASE,
    secret: "v17-secret-v17-secret-v17-secret-v17",
    database: db,
    emailAndPassword: { enabled: true },
    user: { additionalFields: fields(protect) },
    telemetry: { enabled: false },
  });
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();

  let cookie = "";
  async function call(path, body) {
    const res = await auth.handler(
      new Request(BASE + "/api/auth" + path, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      }),
    );
    const sc = res.headers.getSetCookie?.() ?? [];
    if (sc.length) cookie = sc.map((c) => c.split(";")[0]).join("; ");
    return { status: res.status, json: await res.json().catch(() => null) };
  }
  const row = (email) => db.prepare("SELECT * FROM user WHERE email = ?").get(email);
  const count = () => db.prepare("SELECT COUNT(*) c FROM user").get().c;
  return { auth, db, call, row, count };
}

// 권한 값으로 쓰는 공격 본문
export const PRIV = { role: "admin", status: "active-admin", monthly_limit_usd: 999999, max_keys: 999, is_bootstrap_admin: true };
export const DEFAULTS = { role: "member", status: "active", monthly_limit_usd: null, max_keys: null, is_bootstrap_admin: 0 };
export const pick = (r) => Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, r?.[k] ?? null]));
