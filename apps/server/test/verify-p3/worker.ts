// 3단계 확인 항목 V29~V32 의 D1 시험 Worker (M0). Node 네 DB 시험과 같은 시험 구성(packages/auth/test/verify-p3/probe.ts)을
// 요청마다 로컬 D1 위에 올린다 (운영 Worker 처럼 요청마다 연결·인증을 새로 만든다). 진입 모듈이라 default 말고는 내보내지 않는다.
// D1 은 대화형 트랜잭션이 없어 #15 전 운영 구성(transaction: true)의 가입이 500 이었다 (V29 d1Transaction). 그래서 기본은 transaction: false 로
// 올리고, 머리글 x-probe-tx: on 일 때만 운영 구성 그대로 올린다 (#15 뒤 D1 은 운영 구성도 transaction: false).
//   /api/auth/*                     머리글 x-probe 의 시험 구성(없으면 plain)으로 Better Auth handler
//   POST /__test/concurrent         { scenario, invited, publicBody } → concurrentSignUps (초대 문맥 서버 호출 + 같은 시각 공개 가입)
//   POST /__test/db                 { op, args } → ops.ts OPS[op]
//   GET  /__test/state              { outbox, log }  보낸 메일·훅 기록 (isolate 메모리)
//   GET  /__test/cookie-cache?s=…   그 시험 구성의 session.cookieCache
//   GET  /__test/paths              auth.api 경로 목록
import type { AuthConfig, MailMessage } from "@magnetosphere/auth";
import { connectWorkers, type WorkersEnv } from "@magnetosphere/runtime/workers";
// M0 봉인 재검이 packages/auth/test/verify-p3/ 에 의존한다 (측정·단언·시험 구성을 상대 경로로 가져온다). 그 폴더를 옮기거나 지우면 M0 봉인 커밋 재검이 깨진다.
import { OPS, type OpName } from "../../../../packages/auth/test/verify-p3/ops.ts";
import { concurrentSignUps, probeAuth, SCENARIOS, type HookLog, type Scenario } from "../../../../packages/auth/test/verify-p3/probe.ts";

/** Node 시험(packages/auth/test/client.ts BASE)과 같은 기준 주소. 시험은 이 주소의 요청을 wrangler dev 포트로 옮겨 보낸다 */
const BASE = "http://localhost:3000";
const SECRET = "mg-test-secret-mg-test-secret-mg-test-secret";
const outbox: MailMessage[] = [];
const log: HookLog[] = [];
const randomIp = () => `198.18.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 254) + 1}`;

function scenarioOf(v: string | null): Scenario {
  const s = (v ?? "plain") as Scenario;
  if (!SCENARIOS.includes(s)) throw new Error(`모르는 시험 구성: ${v}`);
  return s;
}

export default {
  async fetch(req: Request, env: WorkersEnv): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    const h = await connectWorkers(env);
    // 메일 전송(응답과 떼어 보낸 것)이 끝난 뒤 응답한다. 시험이 응답 직후 메일 상자를 읽는다
    const pending: Promise<unknown>[] = [];
    const cfg: AuthConfig = {
      database: h,
      baseURL: BASE,
      secret: SECRET,
      trustedOrigins: [BASE],
      mailer: { send: async (m) => void outbox.push(m) },
      clientIp: randomIp,
      waitUntil: (p) => void pending.push(p),
      onMailError: () => {},
    };
    const settled = async (res: Response) => {
      while (pending.length) await Promise.all(pending.splice(0));
      return res;
    };
    const tx = { transaction: req.headers.get("x-probe-tx") === "on" };
    const auth = (s: Scenario) => probeAuth(cfg, s, log, tx);
    if (url.pathname.startsWith("/api/auth/")) return settled(await auth(scenarioOf(req.headers.get("x-probe"))).handler(req));
    if (url.pathname === "/__test/concurrent" && req.method === "POST") {
      const b = (await req.json()) as { scenario: string; invited: Record<string, unknown>; publicBody: Record<string, unknown> };
      return settled(Response.json(await concurrentSignUps(auth(scenarioOf(b.scenario)), BASE, b.invited, b.publicBody)));
    }
    if (url.pathname === "/__test/db" && req.method === "POST") {
      const b = (await req.json()) as { op: OpName; args: unknown[] };
      return Response.json({ result: (await (OPS[b.op] as any)(h.db, h.schema, ...b.args)) ?? null });
    }
    if (url.pathname === "/__test/state") return Response.json({ outbox, log });
    if (url.pathname === "/__test/cookie-cache") return Response.json({ cookieCache: auth(scenarioOf(url.searchParams.get("s"))).options.session?.cookieCache ?? null });
    if (url.pathname === "/__test/paths") {
      const api = auth("plain").api as Record<string, { path?: string }>;
      return Response.json({ paths: Object.entries(api).map(([k, ep]) => ep.path ?? `(server) ${k}`) });
    }
    return new Response("not found", { status: 404 });
  },
};
