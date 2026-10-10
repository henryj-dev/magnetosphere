// 키 반영·정합성 점검 시험 공용: 키 상태를 기억하는 가짜 OmniRoute 어댑터 (호출 기록).
// OmniRoute 호출은 경로가 아니라 어댑터 함수 이름으로 적는다 (G-S5.9).
import type { Analytics, KeyInfo, OmniRouteClient } from "@magnetosphere/omniroute";

export interface KeyCall {
  fn: "listKeys" | "getAnalytics" | "setBudget" | "clearBudget" | "setKeyActive" | "deleteKey";
  id?: string;
  value?: number | boolean;
}

export interface FakeKeys {
  /** OmniRoute 쪽 키 (id → 이름·켜짐·범위) */
  keys: Map<string, KeyInfo>;
  calls: KeyCall[];
  /** 함수 이름 → 다음 호출들이 던질 오류 (앞에서부터 하나씩 꺼낸다) */
  fail: Partial<Record<KeyCall["fn"], unknown[]>>;
  /** 키 id → 이번 달 비용 (getAnalytics) */
  costs: Record<string, number>;
  /** 호출을 기록하기 전에 부른다 (던지면 그 호출이 실패한다) */
  before?: (call: KeyCall) => void | Promise<void>;
  client: () => OmniRouteClient;
  of: (fn: KeyCall["fn"]) => KeyCall[];
  /** 함수 이름·값 순서 (예: ["getAnalytics", "setBudget", "setKeyActive(true)"]) */
  seq: () => string[];
  add: (id: string, opts?: { name?: string; isActive?: boolean; scopes?: string[] }) => void;
}

export function fakeKeys(): FakeKeys {
  const f: FakeKeys = {
    keys: new Map(),
    calls: [],
    fail: {},
    costs: {},
    client: () => client,
    of: (fn) => f.calls.filter((c) => c.fn === fn),
    seq: () => f.calls.map((c) => (c.fn === "setKeyActive" ? `setKeyActive(${c.value})` : c.fn)),
    add: (id, o = {}) => void f.keys.set(id, { id, name: o.name ?? `m_member00_${id.slice(0, 8)}`, isActive: o.isActive ?? true, scopes: o.scopes ?? [] }),
  };
  const record = async (call: KeyCall) => {
    await f.before?.(call);
    const e = f.fail[call.fn]?.shift();
    f.calls.push(call);
    if (e !== undefined) throw e;
  };
  const client = {
    async listKeys() {
      await record({ fn: "listKeys" });
      return [...f.keys.values()].map((k) => ({ ...k, scopes: [...k.scopes] }));
    },
    async getAnalytics(q: { apiKeyIds?: string[] }): Promise<Analytics> {
      await record({ fn: "getAnalytics" });
      const byApiKey = Object.entries(f.costs)
        .filter(([id]) => !q.apiKeyIds || q.apiKeyIds.includes(id))
        .map(([apiKeyId, cost]) => ({ apiKeyId, requests: 1, cost }));
      return { totalCost: byApiKey.reduce((s, x) => s + x.cost, 0), totalRequests: byApiKey.length, promptTokens: 0, completionTokens: 0, byApiKey };
    },
    async setBudget(id: string, b: { monthlyUsd: number }) {
      await record({ fn: "setBudget", id, value: b.monthlyUsd });
    },
    async clearBudget(id: string) {
      await record({ fn: "clearBudget", id });
    },
    async setKeyActive(id: string, active: boolean) {
      await record({ fn: "setKeyActive", id, value: active });
      const k = f.keys.get(id);
      if (k) k.isActive = active;
    },
    async deleteKey(id: string) {
      await record({ fn: "deleteKey", id });
      f.keys.delete(id);
    },
  } as unknown as OmniRouteClient;
  return f;
}
