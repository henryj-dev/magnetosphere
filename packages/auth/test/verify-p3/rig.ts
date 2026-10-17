// Node 네 DB 의 Rig (M0). 같은 프로세스에서 시험 구성마다 Better Auth 를 하나씩 올린다. 메일·훅 기록은 DB 하나에 하나다.
import { readFileSync } from "node:fs";
import type { TestDb } from "../db.ts";
import { makeAuthConfig } from "../helpers.ts";
import type { Rig } from "./measure.ts";
import { OPS } from "./ops.ts";
import { concurrentSignUps, probeAuth, type HookLog, type Scenario } from "./probe.ts";

export function nodeRig(h: TestDb): Rig {
  const { outbox, pending, mailErrors: _errors, ...cfg } = makeAuthConfig(h);
  const log: HookLog[] = [];
  const auths = new Map<Scenario, ReturnType<typeof probeAuth>>();
  const auth = (s: Scenario) => {
    let a = auths.get(s);
    if (!a) auths.set(s, (a = probeAuth(cfg, s, log)));
    return a;
  };
  const settle = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
  return {
    runtime: "node",
    handler: (s) => async (req) => {
      const res = await auth(s).handler(req);
      await settle();
      return res;
    },
    concurrentSignUps: async (s, invited, publicBody) => {
      const r = await concurrentSignUps(auth(s), cfg.baseURL, invited, publicBody);
      await settle();
      return r;
    },
    op: (name, ...args) => (OPS[name] as any)(h.db, h.schema, ...args),
    outbox: async () => (await settle(), outbox),
    log: async () => log,
    cookieCache: async (s) => auth(s).options.session?.cookieCache ?? null,
    apiPaths: async () => Object.entries(auth("sdkRaw").api).map(([k, ep]: [string, any]) => ep.path ?? `(server) ${k}`),
  };
}

/** docs/verify/V<n>.json 의 answer */
export function answerOf(item: "V29" | "V30" | "V31" | "V32"): any {
  return JSON.parse(readFileSync(new URL(`../../../../docs/verify/${item}.json`, import.meta.url), "utf8")).answer;
}
