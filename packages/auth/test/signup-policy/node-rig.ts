// 가입 정책 시험의 packages/auth Rig — Node 네 DB. 운영 createAuth 의 handler·auth.api 를 바로 부른다 (서버 앞 판정 없이 Better Auth 의 두 자리만).
// internalAdapter 는 같은 구성(authOptions)으로 올린 betterAuth 의 $context 다.
import { betterAuth } from "better-auth";
import { authOptions } from "../../src/index.ts";
import { runAsInvite } from "../../src/invite-context.ts";
import { BASE } from "../client.ts";
import type { TestDb } from "../db.ts";
import { makeAuth, makeAuthConfig } from "../helpers.ts";
import { apiReply, OPS, reply, type Rig } from "./rig.ts";

export function nodeRig(h: TestDb): Rig {
  const app = makeAuth(h);
  const ctx = betterAuth(authOptions(makeAuthConfig(h))).$context;
  const send = async (method: string, path: string, b?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method,
        headers: { origin: BASE, ...(b !== undefined ? { "content-type": "application/json" } : {}), ...headers },
        body: b === undefined ? undefined : JSON.stringify(b),
        redirect: "manual",
      }),
    );
    const r = await reply(res);
    await app.settle();
    return r;
  };
  return {
    label: h.label,
    // 클라이언트 IP 는 makeAuth 의 시험 IP(요청마다 무작위)다
    signUp: (b, o = {}) => send("POST", "/sign-up/email", b, o.headers),
    apiSignUp: async (b, invite) => {
      const signUp = () => app.api.signUpEmail({ body: b as any });
      const r = await apiReply(invite ? runAsInvite(invite, signUp) : signUp());
      await app.settle();
      return r;
    },
    internalCreate: async (fn, email) => {
      const c = await ctx;
      return apiReply(
        fn === "createUser"
          ? c.internalAdapter.createUser({ email, name: "x", emailVerified: true }, { method: "email-password" } as any)
          : c.internalAdapter.createOAuthUser({ email, name: "x", emailVerified: true }, { providerId: "sso-idp", accountId: crypto.randomUUID() }),
      );
    },
    request: (method, path, b, headers) => send(method, path, b, headers),
    op: async (name, ...args) => (OPS[name] as any)(h.db, h.schema, ...args),
    outbox: async () => (await app.settle(), app.outbox),
    apiPaths: async () => Object.entries(app.api).map(([k, ep]: [string, any]) => ep.path ?? `(server) ${k}`),
  };
}
