// D1 의 Rig (M0). 시험 Worker(worker.ts)를 wrangler dev 로 띄우고 측정(packages/auth/test/verify-p3/measure.ts)의 요청을 그리로 옮긴다.
// Node 네 DB 의 Rig 는 packages/auth/test/verify-p3/rig.ts 다. 두 Rig 는 같은 측정에 같은 관찰을 내야 한다.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// M0 봉인 재검이 packages/auth/test/verify-p3/ 에 의존한다 (측정·단언·시험 구성을 상대 경로로 가져온다). 그 폴더를 옮기거나 지우면 M0 봉인 커밋 재검이 깨진다.
import type { Rig } from "../../../../packages/auth/test/verify-p3/measure.ts";
import { startWranglerDev, wrangler, type WranglerDev } from "../wrangler-dev.mjs";

const CONFIG = "test/verify-p3/wrangler.jsonc";

/** 빈 로컬 D1 에 마이그레이션을 적용하고 시험 Worker 를 띄운다. close() 가 내리고 지운다 */
export async function startVerifyWorker(): Promise<{ rig: Rig; currentConfig: Rig; close(): Promise<void> }> {
  const persistTo = mkdtempSync(path.join(tmpdir(), "mg-verify-p3-d1-"));
  const mig = wrangler(["d1", "migrations", "apply", "DB", "--local", "--config", CONFIG, "--persist-to", persistTo]);
  if (mig.code !== 0) throw new Error(`D1 마이그레이션 실패\n${mig.out}${mig.err}`);
  let d: WranglerDev | undefined;
  try {
    d = await startWranglerDev({ config: CONFIG, persistTo, vars: {} });
  } catch (e) {
    rmSync(persistTo, { recursive: true, force: true });
    throw e;
  }
  return {
    rig: workersRig(d.baseUrl, "off"),
    // 지금 구성 그대로 (transaction: true). V29 d1Transaction 만 이것으로 잰다
    currentConfig: workersRig(d.baseUrl, "on"),
    async close() {
      await d?.close();
      rmSync(persistTo, { recursive: true, force: true });
    },
  };
}

function workersRig(baseUrl: string, tx: "on" | "off"): Rig {
  const json = async (p: string, body?: unknown) => {
    const r = await fetch(`${baseUrl}${p}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
    if (r.status !== 200) throw new Error(`${p} ${r.status} ${await r.text()}`);
    return (await r.json()) as any;
  };
  return {
    runtime: "workers",
    // 측정은 http://localhost:3000 (Worker 의 baseURL) 로 요청을 만든다. 주소만 wrangler dev 로 옮긴다
    handler: (scenario) => async (req) => {
      const u = new URL(req.url);
      const headers = new Headers(req.headers);
      headers.set("x-probe", scenario);
      headers.set("x-probe-tx", tx);
      return fetch(`${baseUrl}${u.pathname}${u.search}`, { method: req.method, headers, body: req.method === "GET" ? undefined : await req.text(), redirect: "manual" });
    },
    concurrentSignUps: (scenario, invited, publicBody) => json("/__test/concurrent", { scenario, invited, publicBody }),
    op: async (op, ...args) => (await json("/__test/db", { op, args })).result,
    outbox: async () => (await json("/__test/state")).outbox,
    log: async () => (await json("/__test/state")).log,
    cookieCache: async (s) => (await json(`/__test/cookie-cache?s=${s}`)).cookieCache,
    apiPaths: async () => (await json("/__test/paths")).paths,
  };
}

/** docs/verify/V<n>.json 의 answer */
export function answerOf(item: "V29" | "V30" | "V31" | "V32"): any {
  return JSON.parse(readFileSync(new URL(`../../../../docs/verify/${item}.json`, import.meta.url), "utf8")).answer;
}
