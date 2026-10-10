// 설치 뒤 공개 가입 차단 (보안 고침, TC-SEC.1.a). Node 진입점(SQLite 파일 DB).
// 3단계(가입 정책·초대) 전까지는 signup_mode 가 무엇이든 공개 자가 가입을 받지 않는다.
// Better Auth 안의 차단(다른 사용자 생성 경로·네 DB)은 packages/auth/test/signup-closed.test.ts (TC-SEC.1.b·c).
import { afterEach, describe, expect, it } from "vitest";
import { ADMIN, boot, closeAll, post, sql, tokenIn } from "./helpers.ts";

afterEach(closeAll);

const SIGNUP = { email: "stranger@example.com", password: "stranger-password-123", name: "stranger" };
const VARIANTS = ["/api/auth/sign-up/email", "/api/auth/sign-up/email/", "/api/auth//sign-up/email", "/api/auth/Sign-Up/email", "/api/auth/sign%2Dup/email"];

describe("TC-SEC.1.a 설치 뒤 공개 가입은 403", () => {
  it("관리자가 생긴 뒤 /api/auth/sign-up/email 과 경로 변형 → 403 signup_closed, user 는 관리자 하나. signup_mode 값과 무관", async () => {
    const r = await boot();
    expect((await post(r, "/api/setup", { token: tokenIn(r.logs), ...ADMIN })).status).toBe(201);

    // 시드 전(설정 행 없음), 시드 기본값 invite_only, 3단계에 생길 값들. 지금은 어느 값도 공개 가입을 열지 않는다
    for (const mode of [undefined, "invite_only", "open", "domain_allowlist", "closed", "sso_only"]) {
      await sql(r.t, "DELETE FROM app_settings WHERE key = 'signup_mode'");
      if (mode) await sql(r.t, `INSERT INTO app_settings (key, value, updated_at) VALUES ('signup_mode', '${JSON.stringify(mode)}', ${Date.now()})`);
      for (const p of VARIANTS) {
        const res = await post(r, p, SIGNUP);
        expect([403, 404], `${mode} ${p}`).toContain(res.status);
        if (p === "/api/auth/sign-up/email") expect(await res.json(), `${mode}`).toEqual({ error: "signup_closed" });
      }
    }
    const users = await sql(r.t, "SELECT email, role FROM user");
    expect(users.map((u) => ({ ...u }))).toEqual([{ email: "admin@example.com", role: "admin" }]);
  });
});
