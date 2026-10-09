// 계약 환경 검사 (S5.T1). 어댑터를 거치지 않고 OmniRoute 를 바로 불러, 환경이 0단계 실측값을 재현하는지 본다.
// 어댑터가 틀려도 환경 문제와 섞이지 않게 한다.
import { afterAll, describe, expect, it } from "vitest";
import { infer, OMNI_PASSWORD, OMNI_URL, revokeTokens } from "./env.ts";

const tokens: string[] = [];
let token = "";
let keyId = "";

afterAll(async () => {
  if (keyId) await fetch(`${OMNI_URL}/api/keys/${keyId}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  await revokeTokens(tokens);
});

describe("TC-S5.T1.a 계약 환경이 0단계 실측값을 재현한다", () => {
  it("비스트리밍 OpenAI 요청 → Tokens-In 111, Tokens-Out 22, Response-Cost 0.0022100000", async () => {
    const t = await fetch(`${OMNI_URL}/api/cli/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: OMNI_PASSWORD, name: "contract-t1a", scope: "write", expiresInDays: 1 }),
    });
    expect(t.status).toBe(200);
    const tj = await t.json();
    token = tj.token;
    tokens.push(tj.id);
    const k = await fetch(`${OMNI_URL}/api/keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "contract-t1a" }),
    });
    expect(k.status).toBe(201);
    const kj = await k.json();
    keyId = kj.id;

    const r = await infer(kj.key, "openai");
    expect(r.status).toBe(200);
    expect(r.headers.get("x-omniroute-tokens-in")).toBe("111");
    expect(r.headers.get("x-omniroute-tokens-out")).toBe("22");
    expect(r.headers.get("x-omniroute-response-cost")).toBe("0.0022100000");
  });
});
