// 확인 항목 계약 시험 공용 (2단계 실행판 K0.T5~T10). 관찰이 docs/verify/V<n>.json 의 answer 와 같은지 본다.
// 계약 환경(tests/contract, 127.0.0.1:20170)에 붙는다. 관리 호출은 어댑터로 하고, 어댑터에 없는 경로
// (regenerate·예산 조회·쿼터 풀·call-logs 거르기 파라미터)는 이 확인 시험에서만 직접 부른다.
import fs from "node:fs";
import { createAccessToken, createClient, type OmniRouteClient } from "../../../src/index.ts";
import { infer, OMNI_PASSWORD, OMNI_URL, revokeTokens } from "../env.ts";

/** docs/verify/V<n>.json 의 answer */
export function answerOf(item: string): any {
  const file = new URL(`../../../../../docs/verify/${item}.json`, import.meta.url);
  return JSON.parse(fs.readFileSync(file, "utf8")).answer;
}

export interface Session {
  client: OmniRouteClient;
  token: string;
  /** 시험이 만든 키 (끝나면 지운다) */
  keys: string[];
  close(): Promise<void>;
}

/** write 접근 토큰 하나와 어댑터. close() 가 만든 키를 지우고 토큰을 회수한다 */
export async function open(name: string): Promise<Session> {
  const t = await createAccessToken({ baseUrl: OMNI_URL }, { password: OMNI_PASSWORD, scope: "write", name, expiresInDays: 1 });
  const client = createClient({ baseUrl: OMNI_URL, credential: { token: t.token } });
  const s: Session = {
    client,
    token: t.token,
    keys: [],
    async close() {
      for (const id of s.keys) await client.deleteKey(id).catch(() => {});
      await revokeTokens([t.id]);
    },
  };
  return s;
}

export async function newKey(s: Session, label: string) {
  const k = await s.client.createKey(`contract-${label}-${Date.now().toString(36)}`);
  s.keys.push(k.id);
  return k;
}

/** 어댑터에 없는 관리 경로를 접근 토큰으로 직접 부른다 */
export async function raw(s: Session, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { authorization: `Bearer ${s.token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(OMNI_URL + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = text === "" ? null : JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

/** 0단계 회원 B 와 같은 요청 3건 (합계 0.014633, TC-S5.T2.e) */
export async function threeRequests(key: string): Promise<number[]> {
  return [(await infer(key, "openai")).status, (await infer(key, "anthropic")).status, (await infer(key, "anthropic", { stream: true })).status];
}
export const THREE_COST = 0.00221 + 0.0062115 * 2;
export const ONE_OPENAI_COST = 0.00221;

/** OmniRoute 가 기록을 마칠 때까지 조건을 다시 본다 */
export async function eventually<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (done(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const around = () => ({ startDate: new Date(Date.now() - 10 * 60_000), endDate: new Date(Date.now() + 60_000) });
