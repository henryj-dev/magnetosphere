// TC-S4.T2.a Node ↔ Workers 교차 복호화 (pnpm test:cross-runtime).
// Workers 쪽은 wrangler 4.115.0 의 unstable_startWorker 로 test/workers/crypto-worker.ts 를 로컬 workerd 에서 띄운다
// (wrangler dev 와 같은 엔진). @cloudflare/vitest-pool-workers 는 vitest 5 를 아직 받지 않아 쓰지 않는다.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCipher } from "../src/crypto.ts";

const VECTORS = JSON.parse(readFileSync(new URL("./fixtures/crypto-vectors.json", import.meta.url), "utf8")) as {
  key: string;
  cases: { plain: string; aad: string; token: string }[];
};
const plains = VECTORS.cases.map((c) => c.plain);

describe("TC-S4.T2.a Node 에서 암호화한 값을 Workers 에서 복호화한다 (반대도)", () => {
  let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
  const call = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await worker.fetch(`http://worker${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    if (!res.ok) throw new Error(`Worker ${path} ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  };

  beforeAll(async () => {
    worker = await unstable_startWorker({
      config: fileURLToPath(new URL("./workers/wrangler.jsonc", import.meta.url)),
      dev: { server: { port: 0 }, inspector: false, logLevel: "error" },
    });
    await worker.ready;
  });
  afterAll(async () => {
    await worker?.dispose();
  });

  it("고정 벡터 → Node 복호화가 같은 평문", async () => {
    const cipher = await createCipher(VECTORS.key);
    expect(await Promise.all(VECTORS.cases.map((c) => cipher.decrypt(c.token, c.aad)))).toEqual(plains);
  });

  it("고정 벡터 → Workers(workerd) 복호화가 같은 평문", async () => {
    const { plains: got } = await call<{ plains: string[] }>("/decrypt", { key: VECTORS.key, items: VECTORS.cases });
    expect(got).toEqual(plains);
  });

  it("Node 에서 새로 암호화 → Workers 복호화", async () => {
    const cipher = await createCipher(VECTORS.key);
    const tokens = await Promise.all(VECTORS.cases.map((c) => cipher.encrypt(c.plain, c.aad)));
    const items = tokens.map((token, i) => ({ token, aad: VECTORS.cases[i].aad }));
    const { plains: got } = await call<{ plains: string[] }>("/decrypt", { key: VECTORS.key, items });
    expect(got).toEqual(plains);
  });

  it("Workers 에서도 다른 AAD 로는 복호화하지 못한다", async () => {
    const [c] = VECTORS.cases.slice(1);
    const res = await worker.fetch("http://worker/decrypt", { method: "POST", body: JSON.stringify({ key: VECTORS.key, items: [{ token: c.token, aad: "other.field" }] }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/복호화 실패/);
  });

  it("Workers 에서 새로 암호화 → Node 복호화", async () => {
    const { tokens } = await call<{ tokens: string[] }>("/encrypt", { key: VECTORS.key, items: VECTORS.cases.map(({ plain, aad }) => ({ plain, aad })) });
    expect(tokens.every((t) => t.startsWith("v1:"))).toBe(true);
    const cipher = await createCipher(VECTORS.key);
    expect(await Promise.all(tokens.map((t, i) => cipher.decrypt(t, VECTORS.cases[i].aad)))).toEqual(plains);
  });
});
