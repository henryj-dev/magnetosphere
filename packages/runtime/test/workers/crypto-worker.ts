// TC-S4.T2.a 의 Workers 쪽. src/crypto.ts 를 그대로 묶어 workerd 에서 돈다 (test/cross-runtime.test.ts 가 띄운다).
//   POST /decrypt {key, tokens} → {plains}
//   POST /encrypt {key, plains} → {tokens}
import { createCipher } from "../../src/crypto.ts";

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const body = (await req.json()) as { key: string; tokens?: string[]; plains?: string[] };
    const cipher = await createCipher(body.key);
    if (url.pathname === "/decrypt") return Response.json({ plains: await Promise.all((body.tokens ?? []).map((t) => cipher.decrypt(t))) });
    if (url.pathname === "/encrypt") return Response.json({ tokens: await Promise.all((body.plains ?? []).map((p) => cipher.encrypt(p))) });
    return new Response("not found", { status: 404 });
  },
};
