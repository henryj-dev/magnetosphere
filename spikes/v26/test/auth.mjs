// DB 하나에 Better Auth 1.7.7 + Drizzle 어댑터 + SSO 플러그인을 묶는다. 요청은 auth.handler 에 Request 로 넣는다.
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { sso } from "@better-auth/sso";

export const BASE = "http://localhost:3998";
export const KC = "http://127.0.0.1:8181";
export const ISSUER = `${KC}/realms/v26`;

// hooks.resolve: 테스트가 바꿔 끼우는 resolveUser 본체. hooks.accountBefore: account 생성 직전 훅.
export function makeAuth(h, hooks = {}, { transaction = true } = {}) {
  return betterAuth({
    baseURL: BASE,
    secret: "v26-secret-v26-secret-v26-secret-v26",
    database: drizzleAdapter(h.db, { provider: h.provider, schema: h.schema, transaction }),
    emailAndPassword: { enabled: true },
    trustedOrigins: [BASE, KC],
    telemetry: { enabled: false },
    databaseHooks: {
      account: { create: { before: async (a) => { await hooks.accountBefore?.(a); } } },
    },
    plugins: [
      sso({
        resolveUser: async (input, ctx) => (hooks.resolve ? hooks.resolve(input, ctx) : { action: "continue" }),
      }),
    ],
  });
}

// 쿠키 상자 하나를 가진 간단한 클라이언트
export function client(auth) {
  const jar = new Map();
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const take = (res) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (/max-age=0/i.test(c) || v === "") jar.delete(k); else jar.set(k, v);
    }
  };
  async function req(method, pathOrUrl, body) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : BASE + "/api/auth" + pathOrUrl;
    const res = await auth.handler(new Request(url, {
      method,
      headers: { origin: BASE, ...(body ? { "content-type": "application/json" } : {}), ...(jar.size ? { cookie: cookie() } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
    }));
    take(res);
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, location: res.headers.get("location"), text };
  }
  return { req, jar, post: (p, b) => req("POST", p, b ?? {}), get: (p) => req("GET", p) };
}
