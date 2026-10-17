// M6 후속 인증 고침 시험. MG_TEST_DBS=sqlite,mysql,mariadb,pg pnpm -C packages/auth test -t "TC-M6.T5.c|TC-M6.T5.d"
// c (U3): 비밀번호 변경 rotate 가 새 세션을 만든 뒤 쿠키 쓰기·최종 확인에서 실패하면 새 세션을 지우고 쿠키 없이 401 하나로 닫는다.
// d (L3): 없는 메일 로그인도 있는 메일과 같은 DB 읽기 수·HMAC 수를 거친다. 결과(LOGIN 문맥)는 남기지 않는다.
// 실패 출력에 세션 token·비밀번호 해시를 넣지 않는다 (응답 본문은 고정 오류 본문이다).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createAuth } from "../src/index.ts";
import { signupConfirmation } from "../src/signup-confirmation.ts";
import { BASE } from "./client.ts";
import { OPEN, type TestDb } from "./db.ts";
import { makeAuthConfig } from "./helpers.ts";
import { mail, OPS, PASSWORD, reply } from "./signup-policy/rig.ts";

// setSessionCookie 를 한 번만 고장 낸다. 진짜 쿠키를 쓴 뒤 실패해야 응답 헤더에서 지우는지까지 본다
const cookieFault = vi.hoisted(() => ({ mode: null as null | "throw" | "after", after: null as null | (() => Promise<void>), fired: 0 }));
vi.mock("better-auth/cookies", async (importOriginal) => {
  const real = await importOriginal<typeof import("better-auth/cookies")>();
  return {
    ...real,
    setSessionCookie: async (...args: Parameters<typeof real.setSessionCookie>) => {
      const mode = cookieFault.mode;
      cookieFault.mode = null;
      await real.setSessionCookie(...args);
      if (mode === null) return;
      cookieFault.fired++;
      if (mode === "throw") throw new Error("cookie_write_fault");
      await cookieFault.after?.();
    },
  };
});

const kinds = (process.env.MG_TEST_DBS ?? "sqlite").split(",") as (keyof typeof OPEN)[];
const cookie = (headers: Headers) => headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
const json = { origin: BASE, "content-type": "application/json" };

describe.each(kinds)("%s M6.T5 인증 후속", (kind) => {
  let h: TestDb, cfg: ReturnType<typeof makeAuthConfig>, auth: ReturnType<typeof createAuth>;
  const api = () => auth.api as any;
  const s = () => h.schema as any;
  const add = async (tag: string) => {
    const email = mail(`m6-${tag}`);
    const id = await OPS.addPasswordUser(h.db, h.schema, email, PASSWORD, "member");
    return { id, email };
  };
  const signInHttp = (email: string, password: string) => auth.handler(new Request(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: json, body: JSON.stringify({ email, password }) }));
  /** 없는 메일 로그인의 고정 오류 본문. staleLogin 과 같은 생성 경로다 */
  const missingBody = async () => {
    const res = await signInHttp(mail("m6-missing"), PASSWORD);
    expect(res.headers.getSetCookie()).toEqual([]);
    return reply(res);
  };
  const rotate = async (signedCookie: string) => auth.handler(new Request(`${BASE}/api/auth/change-password`, { method: "POST", headers: { ...json, cookie: signedCookie }, body: JSON.stringify({ currentPassword: PASSWORD, newPassword: "m6-rotated-password-123", revokeOtherSessions: true }) }));
  beforeAll(async () => { h = await OPEN[kind](); cfg = makeAuthConfig(h); auth = createAuth(cfg); });
  afterAll(async () => {
    cookieFault.mode = null;
    cookieFault.after = null;
    while (cfg?.pending.length) await Promise.all(cfg.pending.splice(0));
    await h?.close();
  });

  it(`TC-M6.T5.c ${kind}: rotate 의 쿠키 쓰기가 실패하면 새 세션을 지우고 쿠키 없이 401 로 닫는다`, async () => {
    const x = await add("c-throw");
    const signed = await api().signInEmail({ body: { email: x.email, password: PASSWORD }, returnHeaders: true });
    const expected = await missingBody();
    cookieFault.fired = 0;
    cookieFault.mode = "throw";
    const res = await rotate(cookie(signed.headers));
    expect(cookieFault.fired).toBe(1); // 고장이 실제로 rotate 안에서 났다
    expect(res.headers.getSetCookie()).toEqual([]);
    const r = await reply(res);
    expect({ status: r.status, code: r.code }).toEqual({ status: 401, code: "invalid_email_or_password" });
    expect(r.body).toBe(expected.body);
    // rotate 가 지운 기존 세션도, 만든 새 세션도 남지 않는다
    expect(await OPS.sessionsOf(h.db, h.schema, x.email)).toBe(0);
    expect(await api().getSession({ headers: new Headers({ cookie: cookie(signed.headers) }) })).toBeNull();
  });

  it(`TC-M6.T5.c ${kind}: 쿠키를 쓴 뒤 최종 확인 전에 authVersion 이 바뀌면 새 세션을 지우고 쿠키 없이 401 로 닫는다`, async () => {
    const x = await add("c-after");
    const signed = await api().signInEmail({ body: { email: x.email, password: PASSWORD }, returnHeaders: true });
    const expected = await missingBody();
    cookieFault.fired = 0;
    cookieFault.after = async () => {
      await h.db.update(s().user).set({ authVersion: sql`${s().user.authVersion} + 1` }).where(eq(s().user.id, x.id));
    };
    cookieFault.mode = "after";
    try {
      const res = await rotate(cookie(signed.headers));
      expect(cookieFault.fired).toBe(1);
      expect(res.headers.getSetCookie()).toEqual([]);
      const r = await reply(res);
      expect({ status: r.status, code: r.code }).toEqual({ status: 401, code: "invalid_email_or_password" });
      expect(r.body).toBe(expected.body);
      expect(await OPS.sessionsOf(h.db, h.schema, x.email)).toBe(0);
    } finally {
      cookieFault.after = null;
    }
  });

  it(`TC-M6.T5.d ${kind}: 없는 메일의 loginSnapshot 은 있는 메일과 같은 DB 읽기 3번·HMAC 1번을 하고 문맥을 남기지 않는다`, async () => {
    const x = await add("d-snapshot");
    const measure = async (email: string) => {
      let selects = 0;
      const db = new Proxy(h.db as any, {
        get(real, key) {
          if (key === "select") return (...args: unknown[]) => { selects++; return real.select(...args); };
          const value = Reflect.get(real, key, real);
          return typeof value === "function" ? value.bind(real) : value;
        },
      });
      const hooks = signupConfirmation({ ...cfg, database: { ...h, db } }, async () => {});
      const sign = vi.spyOn(crypto.subtle, "sign");
      const importKey = vi.spyOn(crypto.subtle, "importKey");
      const ctx = { path: "/sign-in/email", body: { email, password: PASSWORD }, context: {} as Record<symbol, unknown> };
      try {
        await hooks.loginSnapshot(ctx);
        return { selects, signs: sign.mock.calls.length, importKeys: importKey.mock.calls.length, snapshots: Object.getOwnPropertySymbols(ctx.context).length };
      } finally {
        sign.mockRestore();
        importKey.mockRestore();
      }
    };
    expect(await measure(x.email)).toEqual({ selects: 3, signs: 1, importKeys: 1, snapshots: 1 });
    expect(await measure(mail("m6-d-missing"))).toEqual({ selects: 3, signs: 1, importKeys: 1, snapshots: 0 });
  });

  it(`TC-M6.T5.d ${kind}: 없는 메일과 틀린 비밀번호 로그인은 같은 상태·본문이고 쿠키·세션을 남기지 않는다`, async () => {
    const x = await add("d-http");
    const missing = await signInHttp(mail("m6-d-http-missing"), PASSWORD);
    const wrong = await signInHttp(x.email, "m6-wrong-password-123");
    expect(missing.headers.getSetCookie()).toEqual([]);
    expect(wrong.headers.getSetCookie()).toEqual([]);
    const [m, w] = [await reply(missing), await reply(wrong)];
    expect({ status: m.status, code: m.code }).toEqual({ status: 401, code: "invalid_email_or_password" });
    expect(w).toEqual(m);
    expect(await OPS.sessionsOf(h.db, h.schema, x.email)).toBe(0);
  });
});
