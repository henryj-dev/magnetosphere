// K4.T1 동시 발급 (D1, pnpm test:workers). 시험 Worker(test/routes/wrangler.jsonc)를 wrangler dev 로 띄워 같은 회원의 발급 10건을 동시에 보낸다.
// D1 은 대화형 트랜잭션이 없어 최대 개수를 조건부 INSERT 한 문장으로 지킨다 (routes/issue.ts reserveSlot). Node 네 DB 는 issue.db.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startWranglerDev, wrangler } from "../wrangler-dev.mjs";

const CONFIG = "test/routes/wrangler.jsonc";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe("TC-K4.T1.f Workers + D1 동시 발급", () => {
  it("최대 2, 동시 POST 10건 → 201 정확히 2, 나머지 409 max_keys, OmniRoute 의 그 회원 m_ 키 == 2", async () => {
    const persistTo = mkdtempSync(path.join(tmpdir(), "mg-keys-d1-"));
    cleanups.push(() => rmSync(persistTo, { recursive: true, force: true }));
    const mig = wrangler(["d1", "migrations", "apply", "DB", "--local", "--config", CONFIG, "--persist-to", persistTo]);
    expect(mig.code, `${mig.out}${mig.err}`).toBe(0);
    const d = await startWranglerDev({ config: CONFIG, persistTo, vars: {} });
    cleanups.push(() => d.close());

    const member = await fetch(`${d.baseUrl}/__test/member`, { method: "POST", body: JSON.stringify({ maxKeys: 2, limitUsd: 5 }) });
    const { id } = (await member.json()) as { id: string };
    const headers = { cookie: `mg_test_session=${id}`, origin: d.baseUrl, "content-type": "application/json" };
    const results = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const r = await fetch(`${d.baseUrl}/api/me/keys`, { method: "POST", headers, body: "{}" });
        return { status: r.status, json: (await r.json().catch(() => null)) as { error?: string } | null };
      }),
    );
    expect(results.map((r) => r.status).sort(), JSON.stringify(results)).toEqual([201, 201, 409, 409, 409, 409, 409, 409, 409, 409]);
    expect(results.filter((r) => r.status === 409).every((r) => r.json?.error === "max_keys")).toBe(true);
    const om = (await (await fetch(`${d.baseUrl}/__test/omniroute`)).json()) as { keys: { name: string; isActive: boolean }[]; creates: number };
    const mine = om.keys.filter((k) => k.name.startsWith(`m_${id.slice(0, 8)}_`));
    expect(mine).toHaveLength(2);
    expect(mine.every((k) => k.isActive)).toBe(true);
    // 목록도 2개, 남은 자리 0
    const list = (await (await fetch(`${d.baseUrl}/api/me/keys`, { headers })).json()) as { keys: unknown[]; remainingSlots: number };
    expect([list.keys.length, list.remainingSlots]).toEqual([2, 0]);
  });
});
