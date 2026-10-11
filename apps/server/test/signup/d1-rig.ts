// 가입 정책 시험(M2)의 D1 Rig. 시험 Worker(worker.ts)를 wrangler dev 로 띄우고 같은 단언(checks.ts)의 요청을 그리로 보낸다.
// Node 네 DB 의 서버 Rig 는 env.ts 다. 두 Rig 는 같은 단언에 같은 관찰을 내야 한다.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Invite } from "../../../../packages/auth/test/signup-policy/rig.ts";
import { TEST_ENCRYPTION_KEY, TEST_SECRET } from "../helpers.ts";
import { startWranglerDev, wrangler, type WranglerDev } from "../wrangler-dev.mjs";
import { callRes, type CallOpts, type HttpRig } from "./checks.ts";
import { randomIp } from "./env.ts";

const CONFIG = "test/signup/wrangler.jsonc";

/** 빈 로컬 D1 에 마이그레이션을 적용하고 시험 Worker 를 띄운다. close() 가 내리고 지운다 */
export async function startSignupWorker(): Promise<{ rig: HttpRig; baseUrl: string; close(): Promise<void> }> {
  const persistTo = mkdtempSync(path.join(tmpdir(), "mg-signup-d1-"));
  const mig = wrangler(["d1", "migrations", "apply", "DB", "--local", "--config", CONFIG, "--persist-to", persistTo]);
  if (mig.code !== 0) throw new Error(`D1 마이그레이션 실패\n${mig.out}${mig.err}`);
  let d: WranglerDev | undefined;
  try {
    d = await startWranglerDev({ config: CONFIG, persistTo, vars: { BETTER_AUTH_SECRET: TEST_SECRET, APP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY } });
  } catch (e) {
    rmSync(persistTo, { recursive: true, force: true });
    throw e;
  }
  const base = d.baseUrl;
  const json = async (p: string, b?: unknown) => {
    const r = await fetch(`${base}${p}`, b === undefined ? undefined : { method: "POST", body: JSON.stringify(b) });
    if (r.status !== 200) throw new Error(`${p} ${r.status} ${await r.text()}`);
    return (await r.json()) as any;
  };
  const call = async (method: string, p: string, c: CallOpts = {}) => {
    const headers: Record<string, string> = { "x-test-ip": c.ip ?? randomIp(), ...(c.headers ?? {}) };
    // 시험 Worker 의 BETTER_AUTH_URL 은 wrangler dev 주소다 (같은 출처)
    if (c.origin !== null) headers.origin = c.origin ?? base;
    if (c.cookie) headers.cookie = c.cookie;
    if (c.body !== undefined) headers["content-type"] = "application/json";
    return callRes(await fetch(`${base}${p}`, { method, headers, body: c.body === undefined ? undefined : JSON.stringify(c.body), redirect: "manual" }));
  };
  const asReply = (r: { status: number; json: any; body: string }) => {
    const code = typeof r.json?.error === "string" ? r.json.error : typeof r.json?.code === "string" ? r.json.code : null;
    return { status: r.status, code: code?.toLowerCase() ?? null, body: r.body };
  };
  const rig: HttpRig = {
    label: "Workers + D1",
    call,
    signUp: async (b, o = {}) => asReply(await call("POST", "/api/auth/sign-up/email", { body: b, ip: o.ip, headers: o.headers })),
    apiSignUp: (b, invite?: Invite) => json("/__test/api-signup", { body: b, invite }),
    internalCreate: (fn, email) => json("/__test/internal", { fn, email }),
    request: async (method, p, b, headers) => asReply(await call(method, `/api/auth${p}`, { body: b, headers })),
    op: async (op, ...args) => (await json("/__test/db", { op, args })).result,
    outbox: async () => (await json("/__test/outbox")).outbox,
    apiPaths: async () => (await json("/__test/paths")).paths,
  };
  return {
    rig,
    baseUrl: base,
    async close() {
      await d?.close();
      rmSync(persistTo, { recursive: true, force: true });
    },
  };
}
