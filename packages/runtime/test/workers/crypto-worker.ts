// TC-S4.T2.a 의 Workers 쪽. src/crypto.ts 를 그대로 묶어 workerd 에서 돈다 (test/cross-runtime.test.ts 가 띄운다).
//   POST /decrypt {key, items: [{token, aad}]} → {plains}
//   POST /encrypt {key, items: [{plain, aad}]} → {tokens}
import { createCipher } from "../../src/crypto.ts";

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const body = (await req.json()) as { key: string; items: { token?: string; plain?: string; aad: string }[] };
    const cipher = await createCipher(body.key);
    try {
      if (url.pathname === "/decrypt") return Response.json({ plains: await Promise.all(body.items.map((i) => cipher.decrypt(i.token ?? "", i.aad))) });
      if (url.pathname === "/encrypt") return Response.json({ tokens: await Promise.all(body.items.map((i) => cipher.encrypt(i.plain ?? "", i.aad))) });
    } catch (e) {
      // 복호화 실패는 400 과 메시지로 돌려준다 (wrangler 개발 미들웨어가 예외를 호출자에게 다시 던지지 않게)
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
    return new Response("not found", { status: 404 });
  },
};
