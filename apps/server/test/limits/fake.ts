// 한도 분배 시험 공용: 회원·키 행을 넣는 도구와 가짜 OmniRoute 어댑터(호출 기록).
// OmniRoute 호출은 경로가 아니라 어댑터 함수 이름(getAnalytics, setBudget, setKeyActive)으로 적는다 (G-S5.9).
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Analytics } from "@magnetosphere/omniroute";
import type { DbHandle } from "@magnetosphere/runtime/types";
import type { LimitsClient } from "../../src/limits/rebalance.ts";

export interface KeySpec {
  ork: string;
  state?: "active" | "disabled" | "deleted";
  reason?: string | null;
  budgetUsd?: number | null;
}

/** 회원 하나와 키들. 돌려주는 keyIds 는 ork → api_keys.id */
export async function addMember(h: DbHandle, limitUsd: number | null, keys: KeySpec[], status = "active"): Promise<{ userId: string; keyIds: Record<string, string> }> {
  const userId = randomUUID();
  await h.db.insert(h.schema.user).values({ id: userId, name: "m", email: `m-${userId}@example.com`, monthlyLimitUsd: limitUsd, status });
  const keyIds: Record<string, string> = {};
  for (const k of keys) {
    const id = randomUUID();
    keyIds[k.ork] = id;
    await h.db.insert(h.schema.apiKeys).values({
      id,
      userId,
      omnirouteKeyId: k.ork,
      keyPreview: "abcd",
      state: k.state ?? "active",
      disabledReason: k.reason ?? null,
      budgetUsd: k.budgetUsd ?? null,
      createdAt: new Date("2026-04-01T00:00:00Z"),
    });
  }
  return { userId, keyIds };
}

export async function keyRow(h: DbHandle, ork: string) {
  const k = h.schema.apiKeys;
  const [r] = await h.db.select().from(k).where(eq(k.omnirouteKeyId, ork));
  return { state: r.state as string, reason: r.disabledReason as string | null, budgetUsd: r.budgetUsd == null ? null : Number(r.budgetUsd), budgetAt: r.budgetAt as Date | null };
}

export interface OmniCall {
  fn: "getAnalytics" | "setBudget" | "setKeyActive";
  id?: string;
  value?: number | boolean;
  apiKeyIds?: string[];
  start?: string;
  end?: string;
}

/** 가짜 어댑터. analytics(창) 가 byApiKey 비용(키 id → 비용) 또는 던질 오류를 돌려준다 */
export function fakeOmni(analytics: (q: { apiKeyIds?: string[]; start: string; end: string }) => { [id: string]: number | undefined } | Error) {
  const calls: OmniCall[] = [];
  const client = (): LimitsClient => ({
    async getAnalytics(q) {
      const start = new Date(q.startDate).toISOString();
      const end = new Date(q.endDate).toISOString();
      calls.push({ fn: "getAnalytics", apiKeyIds: q.apiKeyIds, start, end });
      const r = analytics({ apiKeyIds: q.apiKeyIds, start, end });
      if (r instanceof Error) throw r;
      const byApiKey = Object.entries(r)
        .filter(([id]) => !q.apiKeyIds || q.apiKeyIds.includes(id))
        .map(([apiKeyId, cost]) => ({ apiKeyId, requests: 1, cost: cost ?? 0 }));
      const a: Analytics = { totalCost: byApiKey.reduce((s, x) => s + x.cost, 0), totalRequests: byApiKey.length, promptTokens: 0, completionTokens: 0, byApiKey };
      return a;
    },
    async setBudget(id, b) {
      calls.push({ fn: "setBudget", id, value: b.monthlyUsd });
    },
    async setKeyActive(id, active) {
      calls.push({ fn: "setKeyActive", id, value: active });
    },
  });
  return { client, calls, of: (fn: OmniCall["fn"]) => calls.filter((c) => c.fn === fn) };
}
