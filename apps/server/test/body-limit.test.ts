// TC-S4.T3.e /api/* 본문 상한 (S4 보안 리뷰 M1). Node 진입점을 띄워 HTTP 로 보낸다. Workers 는 test/both-runtimes.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import { API_BODY_LIMIT } from "../src/app.ts";
import { ADMIN, ORIGIN, boot, closeAll, post, sql, tokenIn, type Running } from "./helpers.ts";

afterEach(closeAll);

/** JSON 직렬화 크기가 대략 bytes 가 되도록 pad 를 붙인다 */
const padded = (body: Record<string, unknown>, bytes: number) => ({ ...body, pad: "x".repeat(Math.max(0, bytes - JSON.stringify(body).length - 10)) });

/** Content-Length 없이(chunked) 보낸다 */
function postChunked(r: Running, path: string, body: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 8192) controller.enqueue(bytes.subarray(i, i + 8192));
      controller.close();
    },
  });
  return fetch(`${r.base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: stream, duplex: "half" } as RequestInit);
}

describe("TC-S4.T3.e 64KB 를 넘는 /api 본문은 413 이고 핸들러가 실행되지 않는다", () => {
  it("/api/setup: 큰 본문(Content-Length·chunked) → 413, 토큰 미소비·user 0. 대조: 64KB 이하는 201", async () => {
    const r = await boot();
    const token = tokenIn(r.logs)!;
    for (const send of [post, postChunked]) {
      const res = await send(r, "/api/setup", padded({ token, ...ADMIN }, API_BODY_LIMIT + 1024));
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "payload_too_large" });
    }
    expect(await sql(r.t, "SELECT id FROM user")).toHaveLength(0);
    expect(await sql(r.t, "SELECT 1 FROM app_settings WHERE key = 'setup_token_hash'")).toHaveLength(1);
    // 대조: 상한 바로 아래 본문은 처리된다
    const ok = await post(r, "/api/setup", padded({ token, ...ADMIN }, API_BODY_LIMIT - 1024));
    expect(ok.status).toBe(201);
  });

  it("/api/auth/sign-in/email: 큰 본문 → 413, 요청 수 제한 기록도 없음. 대조: chunked 작은 본문은 로그인되고 세션 IP 가 소켓 주소", async () => {
    // IPv6 루프백으로 연다. Better Auth 는 테스트·개발 환경에서 IP 를 못 정하면 127.0.0.1 로 채우므로, 그것과 구별되는 주소를 쓴다
    const r = await boot(undefined, "::1");
    const token = tokenIn(r.logs)!;
    expect((await post(r, "/api/setup", { token, ...ADMIN })).status).toBe(201);
    for (const send of [post, postChunked]) {
      const res = await send(r, "/api/auth/sign-in/email", padded({ email: ADMIN.email, password: ADMIN.password }, API_BODY_LIMIT + 1024));
      expect(res.status).toBe(413);
    }
    expect(await sql(r.t, "SELECT key FROM rate_limit")).toHaveLength(0);
    expect(await sql(r.t, "SELECT id FROM session")).toHaveLength(0);
    // 대조: chunked 본문을 다시 담은 요청에서도 clientIp 가 소켓 주소로 정해진다
    const login = await postChunked(r, "/api/auth/sign-in/email", { email: ADMIN.email, password: ADMIN.password });
    expect(login.status).toBe(200);
    const sessions = await sql(r.t, "SELECT ip_address FROM session");
    // Better Auth 는 IPv6 를 /64 로 묶어 펼쳐 쓴다 (::1 → 0000:…:0000). IP 를 못 정했으면 127.0.0.1 이 된다
    expect(sessions.map((s) => s.ip_address)).toEqual(["0000:0000:0000:0000:0000:0000:0000:0000"]);
  });
});
