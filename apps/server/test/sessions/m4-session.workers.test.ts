// TC-M4.T3.d1 세션 상태·버전의 실제 D1 판. Node 판은 packages/auth/test/m4-session-version.test.ts 다. 실행 승인은 별도다.
// members.workers.test.ts 처럼 임시 디렉터리의 빈 로컬 D1 에 마이그레이션을 적용하고 m4-session-wrangler.jsonc 의 시험 Worker 를 띄운다.
// 포트는 startWranglerDev 가 빈 포트를 고르고, 임시 디렉터리 접두어는 이 파일 전용이다. afterAll 이 내리고 지운다.
// 회원 fixture 는 시험마다 새 메일로 만들고 afterEach 가 지운 뒤 남은 행·barrier 가 0 인지 확인한다.
// 일반 인증 요청은 운영 서버 앱(createApp → createAuth 의 감싼 handler)으로, 로그인 경계 정지만 같은 authOptions 의 원본 handler 로 보낸다.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TEST_ENCRYPTION_KEY, TEST_SECRET } from "../helpers.ts";
import { startWranglerDev, wrangler, type WranglerDev } from "../wrangler-dev.mjs";

const CONFIG = "test/sessions/m4-session-wrangler.jsonc";
const PASSWORD = "correct-horse-battery-staple";
const NEW_PASSWORD = "m4-d1-changed-password-123";
const BARRIER_MS = 15_000;
const BOUNDARIES = ["verify", "before-insert", "after-insert", "final-response"] as const;
type Boundary = (typeof BOUNDARIES)[number];
interface State { status: string | null; role: string | null; authVersion: number | null; sessions: number; password: boolean | null }

let base = "";
let persistTo: string | undefined;
let worker: WranglerDev | undefined;
let ids: string[] = [];

const randomIp = () => `198.18.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 254) + 1}`;
const cookieOf = (res: Response) => res.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(p: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<any> {
  const r = await fetch(`${base}${p}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  // 실패 메시지에는 응답 원문을 싣지 않는다. 상태 코드만 남긴다
  if (r.status !== 200) { await r.body?.cancel(); throw new Error(`시험 관리 요청 실패: ${r.status}`); }
  return r.json();
}
/** 운영 서버 앱으로 보내는 요청. 정확한 Origin 과 요청마다 다른 IP 를 싣는다 */
function call(method: string, p: string, opts: { cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { origin: base, "x-test-ip": randomIp() };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${base}${p}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
}
async function member(tag: string, status: "pending" | "active" | "suspended" = "active") {
  const email = `m4-d1-${tag}-${crypto.randomUUID()}@example.com`;
  const { id } = await json("/__test/user", { email, password: PASSWORD, status });
  ids.push(id);
  return { id: id as string, email };
}
const state = (id: string, password?: string): Promise<State> => json("/__test/state", { id, ...(password === undefined ? {} : { password }) });
const transition = (id: string, set: Record<string, unknown>) => json("/__test/transition", { id, set });
const userSet = (id: string, set: Record<string, unknown>) => json("/__test/user-set", { id, set });
const signIn = (email: string, password = PASSWORD) => call("POST", "/api/auth/sign-in/email", { body: { email, password } });
async function signedIn(email: string) {
  const res = await signIn(email);
  expect(res.status).toBe(200);
  // 쿠키 값이 vitest diff 에 찍히지 않게 개수만 비교한다
  expect(res.headers.getSetCookie().length).toBe(1);
  return cookieOf(res);
}
/** authoritative getSession 의 user.id. 200 본문이 null 이면 null, user.id 가 없는 본문은 고정 문구. 세션 본문은 단언에 싣지 않는다 */
async function session(cookie: string): Promise<string | null> {
  const res = await call("GET", "/api/auth/get-session", { cookie });
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  return body === null ? null : typeof body?.user?.id === "string" ? body.user.id : "세션 본문에 user.id 없음";
}

/**
 * 원본 handler 로그인을 boundary 에서 멈추고 during 을 실행한 뒤 푼다.
 * barrier 는 요청 전에 만들어 두고, 요청이 경계 전에 끝나거나 15초 안에 경계에 오지 않으면 바로 실패한다. 해제는 finally 에서 한다.
 */
async function race(boundary: Boundary, email: string, during: () => Promise<void>) {
  const id = crypto.randomUUID();
  await json(`/__test/barrier?id=${id}`, {});
  let settled = false;
  const pending = fetch(`${base}/__test/race`, { method: "POST", body: JSON.stringify({ id, email, password: PASSWORD, boundary }), signal: AbortSignal.timeout(BARRIER_MS * 4) });
  pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    const deadline = Date.now() + BARRIER_MS;
    for (;;) {
      if (settled) throw new Error(`${boundary} 경계에 닿기 전에 로그인 요청이 끝났다`);
      if ((await json(`/__test/barrier?id=${id}`)).reached > 0) break;
      if (Date.now() > deadline) throw new Error(`${boundary} 경계 도달 대기 ${BARRIER_MS}ms 초과`);
      await sleep(20);
    }
    await during();
  } finally {
    await fetch(`${base}/__test/barrier?id=${id}`, { method: "DELETE" });
    // 도달 실패·시간 초과로 던질 때도 진행 중 요청이 끝난 뒤 afterEach cleanup 이 돈다
    await pending.catch(() => {});
  }
  const res = await pending;
  // 설치된 SDK 가 이 경계를 정확히 한 번 불렀다. verify 경계는 올바른 비밀번호를 확인한 뒤 멈췄다
  expect(res.headers.get("x-test-barrier-reached")).toBe("1");
  expect(res.headers.get("x-test-barrier-verified")).toBe(boundary === "verify" ? "true" : null);
  return res;
}

describe("TC-M4.T3.d1 실제 D1 세션 상태·버전", () => {
  beforeAll(async () => {
    persistTo = mkdtempSync(path.join(tmpdir(), "mg-m4-session-d1-"));
    try {
      const mig = wrangler(["d1", "migrations", "apply", "DB", "--local", "--config", CONFIG, "--persist-to", persistTo]);
      if (mig.code !== 0) throw new Error(`D1 fixture 준비 실패: 마이그레이션\n${mig.out}${mig.err}`);
      worker = await startWranglerDev({ config: CONFIG, persistTo, vars: { BETTER_AUTH_SECRET: TEST_SECRET, APP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY } });
      base = worker.baseUrl;
    } catch (e) {
      await worker?.close().catch(() => {});
      worker = undefined;
      rmSync(persistTo, { recursive: true, force: true });
      persistTo = undefined;
      throw e;
    }
  });
  afterEach(async () => {
    const owned = ids;
    ids = [];
    if (!base) return;
    expect(await json("/__test/cleanup", { ids: owned })).toEqual({ users: 0, accounts: 0, sessions: 0, barriers: 0 });
  });
  afterAll(async () => {
    try { await worker?.close(); }
    finally { if (persistTo) rmSync(persistTo, { recursive: true, force: true }); }
  });

  it("TC-M4.T3.d1.a 정지·버전 변경 뒤 옛 쿠키는 보호 API 첫 요청부터 401 이고 getSession 은 null, 세션 행은 지운다", async () => {
    for (const change of [{ status: "suspended" }, { authVersion: 1 }] as const) {
      const x = await member(`stale-${Object.keys(change)[0]}`);
      const core = await signedIn(x.email), server = await signedIn(x.email);
      expect(await session(core)).toBe(x.id);
      expect((await call("GET", "/api/auth/list-accounts", { cookie: core })).status).toBe(200);
      expect((await call("GET", "/api/me/keys", { cookie: server })).status).toBe(200);
      // 세션은 지우지 않고 user 칸만 바꾼다. 거부는 행 삭제가 아니라 guard 판정에서 나와야 한다
      await userSet(x.id, change);
      expect((await state(x.id)).sessions).toBe(2);
      expect((await call("GET", "/api/auth/list-accounts", { cookie: core })).status).toBe(401);
      const denied = await call("GET", "/api/me/keys", { cookie: server });
      expect([denied.status, await denied.json()]).toEqual([401, { error: "unauthorized" }]);
      expect(await session(core)).toBeNull();
      expect(await session(server)).toBeNull();
      expect((await state(x.id)).sessions).toBe(0);
    }
  });

  it("TC-M4.T3.d1.pending 인증된 pending 은 로그인·세션만 되고 키 목록·PATCH·발급·비밀번호 변경·자기 탈퇴는 거부한다", async () => {
    const x = await member("pending", "pending");
    const cookie = await signedIn(x.email);
    expect(await session(cookie)).toBe(x.id);
    for (const [method, p, body] of [["GET", "/api/me/keys", undefined], ["PATCH", `/api/me/keys/${crypto.randomUUID()}`, { label: "바꾸기" }], ["POST", "/api/me/keys", {}]] as const) {
      const res = await call(method, p, { cookie, body });
      expect([res.status, await res.json()]).toEqual([403, { error: "member_inactive" }]);
    }
    for (const revokeOtherSessions of [undefined, false, true]) {
      const res = await call("POST", "/api/auth/change-password", { cookie, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, ...(revokeOtherSessions === undefined ? {} : { revokeOtherSessions }) } });
      expect(res.status).toBe(401);
      expect(((await res.json()) as any).code).toBe("INVALID_EMAIL_OR_PASSWORD");
      expect(res.headers.getSetCookie().length).toBe(0);
    }
    const removed = await call("DELETE", "/api/me", { cookie, body: { password: PASSWORD } });
    expect([removed.status, await removed.json()]).toEqual([403, { error: "member_inactive" }]);
    // 거부는 회원·credential·현재 pending 세션을 바꾸지 않는다
    expect(await state(x.id, PASSWORD)).toEqual({ status: "pending", role: "member", authVersion: 0, sessions: 1, password: true });
    expect(await session(cookie)).toBe(x.id);
  });

  for (const revokeOtherSessions of [undefined, false, true]) {
    it(`TC-M4.T3.d1.d revokeOtherSessions=${revokeOtherSessions} 비밀번호 변경은 타 세션을 지우고 현재 쿠키 계약을 지킨다`, async () => {
      const x = await member(`change-${revokeOtherSessions}`);
      const current = await signedIn(x.email), other = await signedIn(x.email);
      const res = await call("POST", "/api/auth/change-password", { cookie: current, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, ...(revokeOtherSessions === undefined ? {} : { revokeOtherSessions }) } });
      expect(res.status).toBe(200);
      const setCookies = res.headers.getSetCookie();
      const body = (await res.json()) as any;
      expect(body.user.id).toBe(x.id);
      expect(JSON.stringify(body).includes("authVersion")).toBe(false);
      // 다른 옛 세션은 옵션과 상관없이 첫 보호 요청부터 무효다
      expect((await call("GET", "/api/auth/list-accounts", { cookie: other })).status).toBe(401);
      expect(await session(other)).toBeNull();
      if (revokeOtherSessions) {
        expect(typeof body.token).toBe("string");
        expect(setCookies.length).toBe(1);
        const rotated = cookieOf(res);
        expect(rotated === current).toBe(false);
        expect((await call("GET", "/api/auth/list-accounts", { cookie: current })).status).toBe(401);
        expect(await session(current)).toBeNull();
        expect(await session(rotated)).toBe(x.id);
      } else {
        expect(body.token === null).toBe(true);
        expect(setCookies.length).toBe(0);
        expect(await session(current)).toBe(x.id);
        expect((await call("GET", "/api/auth/list-accounts", { cookie: current })).status).toBe(200);
      }
      expect(await state(x.id, NEW_PASSWORD)).toEqual({ status: "active", role: "member", authVersion: 1, sessions: 1, password: true });
      expect((await state(x.id, PASSWORD)).password).toBe(false);
    });
  }

  for (const boundary of BOUNDARIES) {
    it(`TC-M4.T3.d1.race ${boundary} 경계 중 정지가 유지되면 쿠키·세션 없이 401 이고 다시 로그인해도 정지 응답이다`, async () => {
      const x = await member(`${boundary}-held`);
      const res = await race(boundary, x.email, async () => { await transition(x.id, { status: "suspended" }); });
      expect(res.status).toBe(401);
      expect(((await res.json()) as any).code).toBe("INVALID_EMAIL_OR_PASSWORD");
      expect(res.headers.getSetCookie().length).toBe(0);
      expect(await state(x.id)).toMatchObject({ status: "suspended", authVersion: 1, sessions: 0 });
      const again = await signIn(x.email);
      expect(again.status).toBe(403);
      expect(((await again.json()) as any).code).toBe("ACCOUNT_SUSPENDED");
      expect(again.headers.getSetCookie().length).toBe(0);
      expect((await state(x.id)).sessions).toBe(0);
    });

    for (const aba of ["status", "role"] as const) {
      it(`TC-M4.T3.d1.race ${boundary} 경계 ${aba} ABA도 옛 관찰의 로그인은 쿠키·세션 없이 401 이다`, async () => {
        const x = await member(`${boundary}-${aba}`);
        const res = await race(boundary, x.email, async () => {
          await transition(x.id, aba === "status" ? { status: "suspended" } : { role: "admin" });
          await transition(x.id, aba === "status" ? { status: "active" } : { role: "member" });
        });
        expect(res.status).toBe(401);
        expect(((await res.json()) as any).code).toBe("INVALID_EMAIL_OR_PASSWORD");
        expect(res.headers.getSetCookie().length).toBe(0);
        expect(await state(x.id)).toMatchObject({ status: "active", role: "member", authVersion: 2, sessions: 0 });
        // 되돌아온 회원의 새 로그인은 막지 않는다 (오탐 없음)
        expect(await session(await signedIn(x.email))).toBe(x.id);
      });
    }
  }
});
