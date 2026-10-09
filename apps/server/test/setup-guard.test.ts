// 최초 설치 보호 (S6 보안 리뷰 M1). Node 진입점. Workers 쪽은 test/workers.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import { startNodeServer } from "../src/node.ts";
import { SETUP_ATTEMPT_MAX } from "../src/setup/index.ts";
import { ADMIN, boot, closeAll, fakeWebDir, makeTestEnv, post, sql, tokenIn } from "./helpers.ts";

afterEach(closeAll);

describe("TC-S6.T3.e 약한 SETUP_TOKEN 은 시작을 거부한다", () => {
  it("Node: 31자 SETUP_TOKEN → 시작 실패(이유에 SETUP_TOKEN·32자), 32자 → 시작하고 그 값으로 설치 201, 로그에 토큰 출력 없음", async () => {
    const t = await makeTestEnv();
    try {
      for (const weak of ["admin", "x".repeat(31)]) {
        await expect(startNodeServer({ env: { ...t.env, SETUP_TOKEN: weak }, port: 0, hostname: "127.0.0.1", webDir: fakeWebDir(t.dir), log: () => {} })).rejects.toThrow(/SETUP_TOKEN.*32자/);
      }
    } finally {
      t.cleanup();
    }
    const strong = "s".repeat(32);
    const t2 = await makeTestEnv();
    const r = await boot({ ...t2, env: { ...t2.env, SETUP_TOKEN: strong } });
    expect(tokenIn(r.logs)).toBeUndefined();
    expect((await post(r, "/api/setup", { token: strong, ...ADMIN })).status).toBe(201);
  });
});

describe("TC-S6.T3.f 설치 시도 횟수 제한", () => {
  it(`Node: 같은 IP 에서 틀린 토큰으로 ${SETUP_ATTEMPT_MAX}회 → 401, 그다음은 맞는 토큰도 429. 창이 지나면 다시 받는다`, async () => {
    const r = await boot();
    const token = tokenIn(r.logs)!;
    for (let i = 0; i < SETUP_ATTEMPT_MAX; i++) expect((await post(r, "/api/setup", { token: `wrong-${i}`, ...ADMIN })).status).toBe(401);
    const blocked = await post(r, "/api/setup", { token, ...ADMIN });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "too_many_requests" });
    // 창 시작을 11분 전으로 돌리면 다시 받는다 (토큰은 소비되지 않았다)
    await sql(r.t, `UPDATE rate_limit SET last_request = ${Date.now() - 11 * 60_000} WHERE key LIKE 'setup-attempt|%'`);
    expect((await post(r, "/api/setup", { token, ...ADMIN })).status).toBe(201);
  });
});
