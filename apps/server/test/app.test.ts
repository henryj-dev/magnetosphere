// Hono 앱 TC (pnpm test). Node 진입점을 실제로 띄워 HTTP 로 부른다.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startNodeServer } from "../src/node.ts";
import { fakeWebDir, makeTestEnv, type TestEnv } from "./helpers.ts";

describe("TC-S4.T3.a 깊은 주소는 SPA 로, /api 는 JSON 으로 간다", () => {
  let t: TestEnv;
  let server: Awaited<ReturnType<typeof startNodeServer>>;
  let base: string;

  beforeAll(async () => {
    t = await makeTestEnv();
    server = await startNodeServer({ env: t.env, port: 0, hostname: "127.0.0.1", webDir: fakeWebDir(t.dir) });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(async () => {
    await server?.close();
    t?.cleanup();
  });

  it("GET /keys → 200 text/html (index.html)", async () => {
    const res = await fetch(`${base}/keys`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await res.text()).toContain("<title>spa</title>");
  });

  it("GET /api/nope → 404 application/json (index.html 아님)", async () => {
    for (const p of ["/api/nope", "/api/nope2", "/api"]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status, p).toBe(404);
      expect(res.headers.get("content-type"), p).toMatch(/^application\/json/);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });

  it("정적 파일은 그대로, /healthz 와 /api/auth/* 는 서버가 받는다", async () => {
    const robots = await fetch(`${base}/robots.txt`);
    expect(robots.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true });
    const ok = await fetch(`${base}/api/auth/ok`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
  });
});
