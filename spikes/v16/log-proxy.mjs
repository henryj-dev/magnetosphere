// V16 경로 수집용 로깅 프록시. 의존성 없음.
// 127.0.0.1:18090 → 127.0.0.1:20140 으로 요청·응답 본문을 그대로 흘려보낸다 (SSE 포함).
// 요청마다 {method, path, status} 한 줄을 paths.log 에 덧붙인다.
// 헤더와 본문은 키가 들어 있으므로 절대 기록하지 않는다. 경로의 쿼리 문자열도 뺀다.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const LISTEN_PORT = Number(process.env.V16_PROXY_PORT ?? 18090);
const UPSTREAM = { host: "127.0.0.1", port: Number(process.env.V16_UPSTREAM_PORT ?? 20140) };
const LOG = process.env.V16_LOG ?? path.join(here, "paths.log");
const TAG = process.env.V16_TAG ?? ""; // 어떤 클라이언트가 보낸 요청인지 (claude/codex/curl)

function record(method, rawUrl, status) {
  const p = (rawUrl ?? "/").split("?")[0];
  const line = { method, path: p, status };
  if (TAG) line.client = TAG;
  fs.appendFileSync(LOG, JSON.stringify(line) + "\n");
}

const server = http.createServer((req, res) => {
  let logged = false;
  const log = (status) => {
    if (!logged) { logged = true; record(req.method, req.url, status); }
  };
  const headers = { ...req.headers, host: `${UPSTREAM.host}:${UPSTREAM.port}` };
  const up = http.request({ ...UPSTREAM, method: req.method, path: req.url, headers }, (upRes) => {
    log(upRes.statusCode);
    res.writeHead(upRes.statusCode, upRes.rawHeaders);
    res.flushHeaders?.();
    upRes.pipe(res);
  });
  up.on("error", () => {
    log(502);
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("upstream error");
  });
  req.pipe(up);
});

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.log(`v16 log-proxy 127.0.0.1:${LISTEN_PORT} → ${UPSTREAM.host}:${UPSTREAM.port}, log=${LOG}`);
});
