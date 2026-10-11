// 비밀번호 재설정 (Workers + D1, pnpm test:workers). 시험 Worker(test/auth/wrangler.jsonc)를 wrangler dev 로 띄운다.
// Better Auth 는 재설정 토큰을 runWithTransaction 안에서 소비한다. D1 은 대화형 트랜잭션(BEGIN)을 받지 않으므로
// Drizzle 어댑터의 transaction 이 켜져 있으면 /reset-password 가 늘 500 이다 (보안 고침, TC-SEC.2.a).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startWranglerDev, wrangler, type WranglerDev } from "../wrangler-dev.mjs";

const CONFIG = "test/auth/wrangler.jsonc";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function post(d: WranglerDev, p: string, body: unknown) {
  const r = await fetch(`${d.baseUrl}/api/auth${p}`, { method: "POST", headers: { origin: d.baseUrl, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
}

describe("TC-SEC.2.a Workers + D1 비밀번호 재설정", () => {
  it("로그인 → 재설정 요청 → /reset-password 200, 토큰은 한 번만, 새 비밀번호로만 로그인", async () => {
    const persistTo = mkdtempSync(path.join(tmpdir(), "mg-auth-d1-"));
    cleanups.push(() => rmSync(persistTo, { recursive: true, force: true }));
    const mig = wrangler(["d1", "migrations", "apply", "DB", "--local", "--config", CONFIG, "--persist-to", persistTo]);
    expect(mig.code, `${mig.out}${mig.err}`).toBe(0);
    const d = await startWranglerDev({ config: CONFIG, persistTo, vars: {} });
    cleanups.push(() => d.close());

    const email = "d1-reset@example.com";
    const [oldPassword, newPassword] = ["old-horse-battery-1", "new-horse-battery-9"];
    expect((await fetch(`${d.baseUrl}/__test/user`, { method: "POST", body: JSON.stringify({ email, password: oldPassword }) })).status).toBe(200);
    expect((await post(d, "/sign-in/email", { email, password: oldPassword })).status).toBe(200);
    expect((await post(d, "/request-password-reset", { email, redirectTo: "/reset" })).status).toBe(200);

    // 메일은 응답과 떼어 보낸다 (waitUntil)
    let link: string | undefined;
    for (let i = 0; i < 50 && !link; i++) {
      const { mails } = (await (await fetch(`${d.baseUrl}/__test/outbox`)).json()) as { mails: { to: string; text: string }[] };
      link = mails.filter((m) => m.to === email).at(-1)?.text.match(/https?:\/\/\S+/)?.[0];
      if (!link) await new Promise((r) => setTimeout(r, 100));
    }
    expect(link, "재설정 메일").toBeDefined();
    const token = new URL(link!).pathname.split("/").at(-1);

    const reset = await post(d, "/reset-password", { newPassword, token });
    // 실패하면 Worker 의 오류 줄(응답보다 늦게 올 수 있다)을 메시지에 붙인다
    const log = reset.status === 200 ? "" : (await d.waitOutput(/POST \/api\/auth\/reset-password/)).split("\n").filter((l) => /Failed query|D1_ERROR/.test(l)).join("\n").slice(0, 2000);
    expect(reset.status, `${JSON.stringify(reset.json)}\n${log}`).toBe(200);
    // 토큰은 소비됐다: 행이 없고, 같은 토큰을 다시 쓰면 400 INVALID_TOKEN
    expect(((await (await fetch(`${d.baseUrl}/__test/verifications`)).json()) as { reset: number }).reset).toBe(0);
    const again = await post(d, "/reset-password", { newPassword: "third-horse-battery-3", token });
    expect([again.status, again.json?.code]).toEqual([400, "INVALID_TOKEN"]);
    // 비밀번호가 바뀌었다
    expect((await post(d, "/sign-in/email", { email, password: newPassword })).status).toBe(200);
    expect((await post(d, "/sign-in/email", { email, password: oldPassword })).status).toBe(401);
  });
});
