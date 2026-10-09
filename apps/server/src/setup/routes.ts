// 최초 설치 API.
//   GET  /api/setup  → { needed } 관리자가 없으면 true. issueTokenOnStatus 면 토큰이 없을 때 만든다 (Workers 는 시작 시점이 없다)
//   POST /api/setup  → 201 { ok } | 400 입력 오류 | 401 토큰 틀림 | 409 이미 설치됨
import { Hono } from "hono";
import type { Services } from "../app.ts";
import { adminExists, ensureSetupToken, runSetup } from "./index.ts";

export function setupRoutes(services: () => Promise<Services>, opts: { issueTokenOnStatus: boolean; log: (line: string) => void }) {
  const r = new Hono();
  r.get("/", async (c) => {
    const s = await services();
    if (opts.issueTokenOnStatus) await ensureSetupToken(s.db, { rotate: false, log: opts.log });
    return c.json({ needed: !(await adminExists(s.db)) });
  });
  r.post("/", async (c) => {
    const s = await services();
    const body = await c.req.json().catch(() => ({}));
    const result = await runSetup(s.db, body && typeof body === "object" ? body : {}, async () => s.cipher);
    return result.ok ? c.json({ ok: true }, 201) : c.json({ error: result.error }, result.status);
  });
  return r;
}
