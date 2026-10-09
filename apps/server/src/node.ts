// Node 진입점 (Docker 조합). `node src/node.ts` 로 바로 띄운다 (Node 24 타입 지우기).
//   환경 변수: DATABASE_URL, BETTER_AUTH_URL, BETTER_AUTH_SECRET, PORT(기본 3000), HOST(기본 0.0.0.0),
//             APP_ENCRYPTION_KEY(32바이트 base64), TRUSTED_PROXIES(쉼표로 구분한 IP·CIDR, 예: Caddy), WEB_DIR(기본 apps/web/build)
// 관리자가 없으면 시작할 때마다 새 설치 토큰을 만들어 한 번 출력한다 (setup/).
// 시작할 때 clientIp 가 실제 요청에서 IP 를 정하는지 확인하고, 못 정하면 시작하지 않는다 (TC-S4.T1.e).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import type { MiddlewareHandler } from "hono";
import { createNodeRuntime, listen, type NodeRuntime } from "@magnetosphere/runtime/node";
import { createApp } from "./app.ts";
import { buildServices } from "./config.ts";
import { ensureSetupToken } from "./setup/index.ts";

export const DEFAULT_WEB_DIR = fileURLToPath(new URL("../../web/build", import.meta.url));

/** apps/web 빌드를 그대로 내준다. 없는 경로는 index.html (SPA fallback, adapter-static 의 fallback 과 같은 파일) */
export function staticAssets(dir: string): MiddlewareHandler {
  const root = path.resolve(dir);
  const index = readFileSync(path.join(root, "index.html"), "utf8");
  const serve = serveStatic({ root });
  return async (c) => (await serve(c, async () => {})) ?? c.html(index);
}

export interface NodeServerOptions {
  env?: Record<string, string | undefined>;
  port?: number;
  hostname?: string;
  webDir?: string;
  /** 설치 토큰 등 운영자에게 보이는 출력 (기본 console.log) */
  log?: (line: string) => void;
}

export async function startNodeServer(opts: NodeServerOptions = {}) {
  const env = opts.env ?? process.env;
  const trustedProxies = (env.TRUSTED_PROXIES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const log = opts.log ?? ((line: string) => console.log(line));
  const runtime: NodeRuntime = createNodeRuntime({ env, trustedProxies });
  try {
    // Node 는 응답 뒤 작업을 따로 붙잡을 필요가 없다. 실패만 기록한다
    const services = await buildServices(runtime, { waitUntil: (p) => void p.catch((e) => console.error("[server] 백그라운드 작업 실패", e)) });
    const app = createApp({
      services: async () => services,
      assets: staticAssets(opts.webDir ?? env.WEB_DIR ?? DEFAULT_WEB_DIR),
      issueSetupTokenOnStatus: false,
      log,
      carryRequest: (from, to) => runtime.carryPeer(from, to),
    });
    const port = opts.port ?? Number(env.PORT ?? 3000);
    await ensureSetupToken(services.db, { rotate: true, log });
    const listening = await listen(runtime, app.fetch, { port, hostname: opts.hostname ?? env.HOST ?? "0.0.0.0" });
    return {
      port: listening.port,
      runtime,
      async close() {
        await listening.close();
        await runtime.close();
      },
    };
  } catch (e) {
    await runtime.close();
    throw e;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startNodeServer();
  console.log(`[server] http://localhost:${s.port} 에서 듣는 중`);
}
