// TC-S4.T3.b Node 와 Workers 가 같은 빌드 결과를 제공한다 (pnpm test:both-runtimes).
// apps/web 을 한 번 빌드하고, 같은 build 디렉터리를 Node 진입점(정적 파일)과 로컬 workerd 의 Workers 진입점(정적 자산)이
// 내주는지 본다. Workers 는 wrangler 4.115.0 unstable_startWorker 로 test/wrangler.jsonc 를 띄운다.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_BODY_LIMIT } from "../src/app.ts";
import { DEFAULT_WEB_DIR, startNodeServer } from "../src/node.ts";
import { makeTestEnv, type TestEnv } from "./helpers.ts";

const WEB = fileURLToPath(new URL("../../web", import.meta.url));
const CONFIG = fileURLToPath(new URL("./wrangler.jsonc", import.meta.url));
const sha256 = async (res: Response) => createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex");

describe("TC-S4.T3.b Node 와 Workers 가 같은 빌드 결과를 제공한다", () => {
  let t: TestEnv;
  let node: Awaited<ReturnType<typeof startNodeServer>>;
  let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
  const fromNode = (p: string) => fetch(`http://127.0.0.1:${node.port}${p}`);
  const fromWorker = (p: string) => worker.fetch(`http://localhost${p}`) as unknown as Promise<Response>;

  beforeAll(async () => {
    const build = spawnSync("pnpm", ["build"], { cwd: WEB, encoding: "utf8" });
    if (build.status !== 0) throw new Error(`apps/web 빌드 실패\n${build.stdout}${build.stderr}`);
    t = await makeTestEnv();
    // Workers 쪽 D1 에도 같은 마이그레이션을 적용한다 (운영 경로와 같게 wrangler 로)
    const persist = path.join(t.dir, "wrangler");
    const d1 = spawnSync("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--config", CONFIG, "--persist-to", persist], {
      encoding: "utf8",
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    });
    if (d1.status !== 0) throw new Error(`D1 마이그레이션 실패\n${d1.stdout}${d1.stderr}`);
    node = await startNodeServer({ env: t.env, port: 0, hostname: "127.0.0.1", webDir: DEFAULT_WEB_DIR });
    worker = await unstable_startWorker({
      config: CONFIG,
      dev: { server: { port: 0 }, inspector: false, logLevel: "error", persist },
    });
    await worker.ready;
  });
  afterAll(async () => {
    await worker?.dispose();
    await node?.close();
    t?.cleanup();
  });

  it("GET / 본문 해시가 같다 (그리고 빌드한 index.html 과 같다)", async () => {
    const [a, b] = [await fromNode("/"), await fromWorker("/")];
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const [ha, hb] = [await sha256(a), await sha256(b)];
    expect(ha).toBe(hb);
    const { readFileSync } = await import("node:fs");
    expect(createHash("sha256").update(readFileSync(path.join(DEFAULT_WEB_DIR, "index.html"))).digest("hex")).toBe(ha);
  });

  it("깊은 주소·/api 404·/healthz·/api/auth 도 두 런타임이 같게 답한다", async () => {
    for (const fetchFrom of [fromNode, fromWorker]) {
      const deep = await fetchFrom("/keys");
      expect(deep.status).toBe(200);
      expect(deep.headers.get("content-type")).toMatch(/^text\/html/);
      const api = await fetchFrom("/api/nope");
      expect(api.status).toBe(404);
      expect(await api.json()).toEqual({ error: "not_found" });
      expect(await (await fetchFrom("/healthz")).json()).toEqual({ ok: true });
      // Better Auth(+sso 플러그인)가 그 런타임에서 실제로 올라온다
      expect(await (await fetchFrom("/api/auth/ok")).json()).toEqual({ ok: true });
    }
  });

  it("TC-S4.T3.e Workers 도 /api 본문 64KB 초과는 413, 대조로 작은 본문은 처리한다", async () => {
    const big = JSON.stringify({ email: "a@example.com", password: "x".repeat(API_BODY_LIMIT + 1024) });
    for (const p of ["/api/setup", "/api/auth/sign-in/email"]) {
      const res = (await worker.fetch(`http://localhost${p}`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" }, body: big })) as unknown as Response;
      expect(res.status, p).toBe(413);
      expect(await res.json()).toEqual({ error: "payload_too_large" });
    }
    const small = (await worker.fetch("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ email: "nobody@example.com", password: "wrong-password" }),
    })) as unknown as Response;
    expect(small.status).toBe(401);
  });
});
