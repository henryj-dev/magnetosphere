// TC-K4.T1.f 의 D1 시험 Worker. 진입점 workers.ts 와 같은 createApp 을 로컬 D1 에 붙인다. 진입 모듈이라 default 말고는 내보내지 않는다.
//   - 세션: 쿠키 mg_test_session=<회원 id> (가짜 인증). 라우터는 회원 id 만 세션에서 얻고 나머지는 D1 에서 읽는다.
//   - OmniRoute: isolate 하나에 하나 있는 가짜 어댑터 (키 이름·켜짐만 기억한다). 호출은 어댑터 함수 이름으로 적는다 (G-S5.9).
//   POST /__test/member {maxKeys, limitUsd} → { id }   시험 회원
//   GET  /__test/omniroute                    → { keys: [{ name, isActive }], creates }
import { connectWorkers, type WorkersEnv } from "@magnetosphere/runtime/workers";
import type { Analytics } from "@magnetosphere/omniroute";
import { createApp, type Services } from "../../src/app.ts";
import type { KeysClient } from "../../src/routes/issue.ts";

const keys = new Map<string, { name: string; isActive: boolean }>();
let creates = 0;
const client: KeysClient = {
  async createKey(name) {
    creates++;
    const id = crypto.randomUUID();
    keys.set(id, { name, isActive: true });
    return { id, key: `sk-${crypto.randomUUID().replaceAll("-", "")}`, name };
  },
  async getAnalytics(): Promise<Analytics> {
    return { totalCost: 0, totalRequests: 0, promptTokens: 0, completionTokens: 0, byApiKey: [] };
  },
  async setBudget() {},
  async clearBudget() {},
  async setKeyActive(id, active) {
    const k = keys.get(id);
    if (k) k.isActive = active;
  },
  async deleteKey(id) {
    keys.delete(id);
  },
};

const auth: Services["auth"] = {
  async handler(req) {
    const m = /(?:^|;\s*)mg_test_session=([^;]+)/.exec(req.headers.get("cookie") ?? "");
    return Response.json(m ? { user: { id: decodeURIComponent(m[1]) } } : null);
  },
};

export default {
  async fetch(req: Request, env: WorkersEnv): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    const db = await connectWorkers(env);
    if (url.pathname === "/__test/member" && req.method === "POST") {
      const b = (await req.json()) as { maxKeys: number; limitUsd: number | null };
      const id = crypto.randomUUID();
      await db.db.insert(db.schema.user).values({ id, name: "d1", email: `d1-${id}@example.com`, emailVerified: true, maxKeys: b.maxKeys, monthlyLimitUsd: b.limitUsd });
      return Response.json({ id });
    }
    if (url.pathname === "/__test/omniroute") return Response.json({ keys: [...keys.values()], creates });
    const services: Services = {
      db,
      auth,
      cipher: {} as Services["cipher"],
      omniroute: { baseUrl: null, initialPassword: null },
      clientIp: () => "203.0.113.9",
      appOrigin: url.origin,
      keysClient: async () => () => client,
    };
    const app = createApp({ services: async () => services, assets: async (c) => c.text("spa"), setupTokenFromSecret: true, log: (l) => console.log(l) });
    return app.fetch(req);
  },
};
