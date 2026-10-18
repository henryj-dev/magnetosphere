// TC-M6.T6.c·d: 뒷받침 훅(databaseHooks.user.create.before)을 DB 없이 바로 부른다 (3단계 실행판 M6 백로그 "SSO JIT 권한 칼럼").
// 판정 입력은 cfg.signupInputs 로 넣어 DB 를 읽지 않는다. 실제 경로 전체(createOAuthUser·createUser)는 TC-SEC.1.b·TC-M2.T1.b 가 DB 에서 본다.
// 여기서는 그 시험이 넣지 않는 권한 값(role·status·한도·인증)을 생성 입력에 실어도 결과가 바뀌지 않는지를 본다.
import { describe, expect, test } from "vitest";
import { APIError } from "better-auth/api";
import * as schema from "@magnetosphere/db/src/schema/sqlite.ts";
import { DEFAULT_SETTINGS } from "@magnetosphere/db/src/seed.ts";
import type { SignupInputs } from "@magnetosphere/db/src/signup.ts";
import { authOptions, type AuthConfig } from "../src/index.ts";
import { runAsInvite } from "../src/invite-context.ts";

const OPEN_INPUTS: SignupInputs = {
  adminExists: true,
  settings: { ...DEFAULT_SETTINGS, signup_mode: "open", daily_signup_cap: null, signup_requires_approval: true, allowed_domains: [] },
  mailConfigured: true,
  todaySignups: 0,
};

function guard(inputs: SignupInputs) {
  const cfg: AuthConfig = {
    // 판정 입력은 signupInputs 가 주므로 이 db 는 불리지 않는다. 불리면 시험이 실패한다
    database: { db: new Proxy({}, { get: () => { throw new Error("DB 를 읽으면 안 된다"); } }), provider: "sqlite", schema, kind: "sqlite" },
    baseURL: "https://mg.test",
    secret: "mg-test-secret-mg-test-secret-mg-test-secret",
    mailer: { send: async () => {} },
    clientIp: () => "198.18.0.1",
    waitUntil: () => {},
    onMailError: () => {},
    signupInputs: async () => inputs,
  };
  return authOptions(cfg).databaseHooks.user.create.before as (user: Record<string, unknown>, ctx?: { path?: string } | null) => Promise<{ data: Record<string, unknown> }>;
}

// IdP claim 이나 플러그인이 생성 입력에 실을 수 있는 권한 값
const CLAIMS = { role: "admin", status: "active", emailVerified: true, monthlyLimitUsd: null, maxKeys: 99 };
const user = (email: string) => ({ email, name: "x", ...CLAIMS });

describe("M6.T6 뒷받침 훅의 권한 칼럼", () => {
  test("TC-M6.T6.c 설치 뒤 이메일 가입 밖 생성(SSO·OAuth 콜백·문맥 없는 내부 호출)은 정책이 open 이고 claim 에 권한 값이 있어도 400 SIGNUP_CLOSED", async () => {
    const before = guard(OPEN_INPUTS);
    for (const ctx of [{ path: "/sso/callback/idp" }, { path: "/callback/github" }, { path: "/sign-up/other" }, {}, null, undefined]) {
      const err = await before(user("jit@mg.test"), ctx).then(() => null, (e: unknown) => e);
      expect(err, JSON.stringify(ctx ?? null)).toBeInstanceOf(APIError);
      expect((err as APIError).status, JSON.stringify(ctx ?? null)).toBe("BAD_REQUEST");
      expect((err as APIError).body?.code, JSON.stringify(ctx ?? null)).toBe("SIGNUP_CLOSED");
    }
  });

  test("TC-M6.T6.d 이메일 가입이 통과해도 role·status·emailVerified·monthlyLimitUsd·maxKeys 는 입력이 아니라 판정 값이다 (공개·초대)", async () => {
    const before = guard(OPEN_INPUTS);
    const pub = await before(user("pub@mg.test"), { path: "/sign-up/email" });
    expect(pub.data).toMatchObject({ role: "member", status: "pending", emailVerified: false, monthlyLimitUsd: 5, maxKeys: null, signupOrigin: "public" });
    const inv = await runAsInvite({ inviteId: "inv-1", role: "member", email: null, verified: false }, () => before(user("inv@mg.test"), { path: "/sign-up/email" }));
    expect(inv.data).toMatchObject({ role: "member", status: "active", emailVerified: false, monthlyLimitUsd: 5, maxKeys: null, signupOrigin: "invite" });
  });
});
