// 최초 설치 TC (pnpm test). Node 진입점을 실제로 띄우고 콘솔 출력(log)에서 설치 토큰을 읽는다.
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startNodeServer } from "../src/node.ts";
import { fakeWebDir, makeTestEnv, type TestEnv } from "./helpers.ts";

const ORIGIN = "http://localhost:3000";
const ADMIN = { email: "Admin@Example.com", password: "correct horse battery", name: "관리자", publicBaseUrl: "https://llm.example.com" };

interface Running {
  t: TestEnv;
  logs: string[];
  base: string;
  close(): Promise<void>;
}

const opened: Running[] = [];

async function boot(t?: TestEnv): Promise<Running> {
  const env = t ?? (await makeTestEnv());
  const logs: string[] = [];
  const s = await startNodeServer({ env: env.env, port: 0, hostname: "127.0.0.1", webDir: fakeWebDir(env.dir), log: (l) => logs.push(l) });
  const r = { t: env, logs, base: `http://127.0.0.1:${s.port}`, close: () => s.close() };
  opened.push(r);
  return r;
}

const tokenIn = (logs: string[]) => logs.join("\n").match(/최초 설치 토큰: (\S+)/)?.[1];

const post = (r: Running, path: string, body: unknown) =>
  fetch(`${r.base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(body) });

async function sql(t: TestEnv, q: string) {
  const c = createClient({ url: `file:${t.dbFile}` });
  try {
    return (await c.execute(q)).rows;
  } finally {
    c.close();
  }
}

afterEach(async () => {
  for (const r of opened.splice(0)) {
    await r.close();
    r.t.cleanup();
  }
});

describe("TC-S4.T4.a 설치 토큰은 한 번만 쓰인다", () => {
  it("관리자 생성 성공 → 같은 토큰으로 다시 /setup → 409", async () => {
    const r = await boot();
    const token = tokenIn(r.logs);
    expect(token).toBeTruthy();
    expect(await (await fetch(`${r.base}/api/setup`)).json()).toEqual({ needed: true });

    const first = await post(r, "/api/setup", { token, ...ADMIN });
    expect(first.status).toBe(201);
    const again = await post(r, "/api/setup", { token, ...ADMIN, email: "second@example.com" });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "already_set_up" });

    // 최초 관리자: role=admin, is_bootstrap_admin, 이메일 인증 완료, 소문자 이메일. 관리자는 하나뿐
    const users = await sql(r.t, "SELECT email, role, is_bootstrap_admin, email_verified FROM user");
    expect(users).toHaveLength(1);
    expect({ ...users[0] }).toEqual({ email: "admin@example.com", role: "admin", is_bootstrap_admin: 1, email_verified: 1 });
    const [url] = await sql(r.t, "SELECT value FROM app_settings WHERE key = 'public_base_url'");
    expect(JSON.parse(String(url.value))).toBe(ADMIN.publicBaseUrl);
    expect(await sql(r.t, "SELECT 1 FROM app_settings WHERE key = 'setup_token_hash'")).toHaveLength(0);

    // Better Auth 이메일 로그인이 그대로 된다
    const login = await post(r, "/api/auth/sign-in/email", { email: ADMIN.email, password: ADMIN.password });
    expect(login.status).toBe(200);
    expect(await (await fetch(`${r.base}/api/setup`)).json()).toEqual({ needed: false });
  });
});

describe("TC-S4.T4.b 틀린 토큰은 거부된다", () => {
  it("틀린 토큰·토큰 없음 → 401, user 행 증가 0. 맞는 토큰이면 그 뒤에도 쓸 수 있다", async () => {
    const r = await boot();
    const token = tokenIn(r.logs)!;
    for (const bad of [{ token: token.slice(0, -1) + (token.endsWith("A") ? "B" : "A") }, { token: "" }, {}]) {
      const res = await post(r, "/api/setup", { ...ADMIN, ...bad });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_token" });
    }
    expect(await sql(r.t, "SELECT id FROM user")).toHaveLength(0);
    // 입력 오류는 토큰을 소비하지 않는다
    expect((await post(r, "/api/setup", { token, ...ADMIN, password: "short" })).status).toBe(400);
    expect((await post(r, "/api/setup", { token, ...ADMIN, publicBaseUrl: "ftp://x" })).status).toBe(400);
    expect((await post(r, "/api/setup", { token, ...ADMIN })).status).toBe(201);
  });
});

describe("TC-S4.T4.c 토큰 원문이 DB 에 없다", () => {
  it("설치 전·후 DB 전체(행 덤프와 파일 바이트)에서 토큰 원문·메일 API 키 원문 0건", async () => {
    const r = await boot();
    const token = tokenIn(r.logs)!;
    const apiKey = "re_live_super_secret_api_key_123";
    const dump = async () => {
      const tables = await sql(r.t, "SELECT name FROM sqlite_master WHERE type = 'table'");
      let all = "";
      for (const { name } of tables) all += JSON.stringify(await sql(r.t, `SELECT * FROM "${String(name)}"`));
      for (const f of [r.t.dbFile, `${r.t.dbFile}-wal`]) {
        try {
          all += readFileSync(f).toString("latin1");
        } catch {
          // WAL 파일은 없을 수 있다
        }
      }
      return all;
    };
    const before = await dump();
    expect(before).toContain("setup_token_hash");
    expect(before.includes(token)).toBe(false);

    const res = await post(r, "/api/setup", { token, ...ADMIN, mail: { provider: "resend", apiKey, from: "noreply@example.com" } });
    expect(res.status).toBe(201);
    const after = await dump();
    expect(after.includes(token)).toBe(false);
    expect(after.includes(apiKey)).toBe(false);
    expect(after).toContain('"apiKey":"v1:');
  });
});

describe("TC-S4.T4.d 관리자가 있으면 설치 토큰을 만들지 않는다", () => {
  it("관리자 존재 상태로 재시작 → 콘솔에 토큰 출력 없음, /setup → 409", async () => {
    const first = await boot();
    const token = tokenIn(first.logs)!;
    expect((await post(first, "/api/setup", { token, ...ADMIN })).status).toBe(201);
    await first.close();
    opened.splice(opened.indexOf(first), 1);

    const again = await boot(first.t);
    expect(tokenIn(again.logs)).toBeUndefined();
    expect(again.logs.join("\n")).not.toContain("설치 토큰");
    expect(await sql(again.t, "SELECT 1 FROM app_settings WHERE key = 'setup_token_hash'")).toHaveLength(0);
    expect(await (await fetch(`${again.base}/api/setup`)).json()).toEqual({ needed: false });
    expect((await post(again, "/api/setup", { token, ...ADMIN })).status).toBe(409);
    expect((await post(again, "/api/setup", { token: "anything", ...ADMIN })).status).toBe(409);
  });

  it("관리자가 없으면 재시작할 때마다 새 토큰을 만들고 이전 토큰은 못 쓴다", async () => {
    const first = await boot();
    const old = tokenIn(first.logs)!;
    await first.close();
    opened.splice(opened.indexOf(first), 1);
    const again = await boot(first.t);
    const fresh = tokenIn(again.logs)!;
    expect(fresh).not.toBe(old);
    expect((await post(again, "/api/setup", { token: old, ...ADMIN })).status).toBe(401);
    expect((await post(again, "/api/setup", { token: fresh, ...ADMIN })).status).toBe(201);
  });
});

describe("메일 발송 설정 (계획서 4.7 5번)", () => {
  it("설치 때 넣은 Resend 설정으로 비밀번호 재설정 메일을 보낸다 (복호화한 API 키)", async () => {
    const r = await boot();
    const token = tokenIn(r.logs)!;
    const apiKey = "re_test_key_abc";
    expect((await post(r, "/api/setup", { token, ...ADMIN, mail: { provider: "resend", apiKey, from: "noreply@example.com" } })).status).toBe(201);
    const realFetch = globalThis.fetch;
    const sent: { url: string; auth: string | null; body: any }[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://api.resend.com/")) return realFetch(input, init);
      sent.push({ url, auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
      return Response.json({ id: "1" });
    });
    try {
      const res = await post(r, "/api/auth/request-password-reset", { email: ADMIN.email, redirectTo: "/reset" });
      expect(res.status).toBe(200);
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0].auth).toBe(`Bearer ${apiKey}`);
      expect(sent[0].body.to).toEqual(["admin@example.com"]);
    } finally {
      spy.mockRestore();
    }
  });
});
