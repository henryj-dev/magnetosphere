// OmniRoute 부트스트랩 계약 테스트 (S5.T3, 계획서 4.7 3번). 계약 환경(tests/contract)의 OmniRoute 에 실제로 붙는다.
// 회원 앱 Node 진입점을 띄워 /api/setup 을 부르고, 저장된 값은 SQLite 파일에서 직접 읽는다.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createAccessToken, createClient } from "@magnetosphere/omniroute";
import { createCipher } from "@magnetosphere/runtime/crypto";
import { OMNIROUTE_TOKEN_AAD } from "../../src/setup/omniroute.ts";
import { ADMIN, boot, closeAll, makeTestEnv, ORIGIN, post, sql, tokenIn, TEST_ENCRYPTION_KEY, type Running } from "../helpers.ts";

const OMNI_URL = process.env.OMNI_URL ?? "http://127.0.0.1:20170";
const OMNI_PASSWORD = process.env.OMNI_PASSWORD ?? "contract-initial-password-5c1e9a";
const V10 = JSON.parse(readFileSync(new URL("../../../../docs/verify/V10.json", import.meta.url), "utf8"));

afterEach(closeAll);

async function bootWith(password: string | null) {
  const t = await makeTestEnv();
  t.env.OMNIROUTE_URL = OMNI_URL;
  if (password !== null) t.env.OMNIROUTE_INITIAL_PASSWORD = password;
  return boot(t);
}

async function install(r: Running) {
  const res = await post(r, "/api/setup", { token: tokenIn(r.logs), ...ADMIN });
  return { status: res.status, body: await res.json() };
}

async function storedToken(r: Running): Promise<{ token: string; id: string; scope: string } | null> {
  const [row] = await sql(r.t, "SELECT value FROM app_settings WHERE key = 'omniroute_token'");
  return row ? JSON.parse(String(row.value)) : null;
}

async function decrypt(ciphertext: string) {
  return (await createCipher(TEST_ENCRYPTION_KEY)).decrypt(ciphertext, OMNIROUTE_TOKEN_AAD);
}

/** DB 전체 (행 덤프와 파일 바이트) */
async function dump(r: Running): Promise<string> {
  let all = "";
  for (const { name } of await sql(r.t, "SELECT name FROM sqlite_master WHERE type = 'table'")) {
    all += JSON.stringify(await sql(r.t, `SELECT * FROM "${String(name)}"`));
  }
  for (const f of [r.t.dbFile, `${r.t.dbFile}-wal`]) {
    try {
      all += readFileSync(f).toString("latin1");
    } catch {
      // WAL 파일은 없을 수 있다
    }
  }
  return all;
}

/** Better Auth 이메일 로그인 → 세션 쿠키 헤더 값 */
async function signIn(r: Running, email: string, password: string): Promise<string> {
  const res = await post(r, "/api/auth/sign-in/email", { email, password });
  expect(res.status).toBe(200);
  return res.headers.getSetCookie().map((s) => s.split(";")[0]).join("; ");
}

function putToken(r: Running, cookie: string | null, body: unknown, contentType = "application/json") {
  const headers: Record<string, string> = { "content-type": contentType, origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  return fetch(`${r.base}/api/setup/omniroute`, { method: "PUT", headers, body: JSON.stringify(body) });
}

describe("TC-S5.T3.a 설치가 끝나면 최소 범위 토큰이 암호화되어 저장된다", () => {
  it('/setup 완료 → 토큰 값이 "v1:" 로 시작, DB 덤프에 "oma_live_" 0건, 복호화 값으로 listKeys 200', async () => {
    const r = await bootWith(OMNI_PASSWORD);
    const res = await install(r);
    expect(res).toEqual({ status: 201, body: { ok: true, omniroute: "connected" } });

    const stored = await storedToken(r);
    expect(stored?.token.startsWith("v1:")).toBe(true);
    expect((await dump(r)).includes("oma_live_")).toBe(false);

    const token = await decrypt(stored!.token);
    expect(token.startsWith("oma_live_")).toBe(true);
    const keys = await createClient({ baseUrl: OMNI_URL, credential: { token } }).listKeys();
    expect(Array.isArray(keys)).toBe(true);
  });
});

describe("TC-S5.T3.b 저장된 토큰의 범위가 V10 최소 범위와 같다", () => {
  it("whoami(저장된 토큰).scope == docs/verify/V10.json answer.minScope, id 도 저장값과 같다", async () => {
    const r = await bootWith(OMNI_PASSWORD);
    expect((await install(r)).body.omniroute).toBe("connected");
    const stored = (await storedToken(r))!;
    const me = await createClient({ baseUrl: OMNI_URL, credential: { token: await decrypt(stored.token) } }).whoami();
    expect(me.scope).toBe(V10.answer.minScope);
    expect({ id: stored.id, scope: stored.scope }).toEqual({ id: me.id, scope: V10.answer.minScope });
  });
});

describe("TC-S5.T3.c INITIAL_PASSWORD 가 틀리면 설치가 그 단계에서 멈추고 붙여 넣기 입력을 연다", () => {
  it('틀린 비밀번호 → 설치 응답 omniroute: "manual_required", 관리자 계정은 생성됨, 토큰 저장 없음', async () => {
    const r = await bootWith("wrong-initial-password");
    const res = await install(r);
    expect(res).toEqual({ status: 201, body: { ok: true, omniroute: "manual_required" } });
    const users = await sql(r.t, "SELECT email, role FROM user");
    expect(users.map((u) => ({ ...u }))).toEqual([{ email: "admin@example.com", role: "admin" }]);
    expect(await storedToken(r)).toBeNull();
    // 이유는 남기되 비밀번호는 출력하지 않는다
    expect(r.logs.join("\n")).toContain("OmniRoute 401");
    expect(r.logs.join("\n")).not.toContain("wrong-initial-password");
    // 맞는 비밀번호로 한 번 성공해 OmniRoute 의 로그인 실패 횟수를 비운다 (5번 쌓이면 15분 잠김)
    await createAccessToken({ baseUrl: OMNI_URL }, { password: OMNI_PASSWORD, scope: "read", name: "contract-t3c-clear", expiresInDays: 1 });
  });
});

describe("TC-S5.T3.d 붙여 넣기 입력은 관리자 세션만, write 범위 토큰만 받는다", () => {
  it("manual_required 설치 → 세션 없음 401·회원 403·read 토큰 400·write 토큰 200 connected, 저장값은 암호문", async () => {
    const r = await bootWith(null);
    expect((await install(r)).body.omniroute).toBe("manual_required");
    const conn = { baseUrl: OMNI_URL };
    const write = await createAccessToken(conn, { password: OMNI_PASSWORD, scope: "write", name: "contract-t3d-write", expiresInDays: 1 });
    const read = await createAccessToken(conn, { password: OMNI_PASSWORD, scope: "read", name: "contract-t3d-read", expiresInDays: 1 });

    expect((await putToken(r, null, { token: write.token })).status).toBe(401);
    expect((await fetch(`${r.base}/api/setup/omniroute`)).status).toBe(401);

    // 일반 회원 세션은 403 (관리자 화면이 아니다)
    const member = { email: "member@example.com", password: "member-password-123", name: "member" };
    expect((await post(r, "/api/auth/sign-up/email", member)).status).toBe(200);
    await sql(r.t, "UPDATE user SET email_verified = 1 WHERE email = 'member@example.com'");
    const memberCookie = await signIn(r, member.email, member.password);
    expect((await putToken(r, memberCookie, { token: write.token })).status).toBe(403);

    const admin = await signIn(r, ADMIN.email, ADMIN.password);
    expect(await (await fetch(`${r.base}/api/setup/omniroute`, { headers: { cookie: admin } })).json()).toEqual({ omniroute: "manual_required" });
    expect((await putToken(r, admin, { token: write.token }, "text/plain")).status).toBe(415);
    const bad = await putToken(r, admin, { token: "oma_live_not-a-real-token" });
    expect({ status: bad.status, body: await bad.json() }).toEqual({ status: 400, body: { error: "invalid_token" } });
    const low = await putToken(r, admin, { token: read.token });
    expect({ status: low.status, body: await low.json() }).toEqual({ status: 400, body: { error: "scope_not_write" } });
    expect(await storedToken(r)).toBeNull();

    const ok = await putToken(r, admin, { token: write.token });
    expect({ status: ok.status, body: await ok.json() }).toEqual({ status: 200, body: { omniroute: "connected" } });
    const stored = (await storedToken(r))!;
    expect(stored.token.startsWith("v1:")).toBe(true);
    expect(await decrypt(stored.token)).toBe(write.token);
    expect((await dump(r)).includes("oma_live_")).toBe(false);
    expect(await (await fetch(`${r.base}/api/setup/omniroute`, { headers: { cookie: admin } })).json()).toEqual({ omniroute: "connected" });
  });
});
