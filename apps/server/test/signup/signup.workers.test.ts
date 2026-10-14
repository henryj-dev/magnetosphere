// 가입 정책 (M2) — Workers + D1 (pnpm -C apps/server test:workers). 시험 Worker(test/signup/wrangler.jsonc)를 wrangler dev 로 띄워
// Node 네 DB 시험(policy.db.test.ts·packages/auth/test/signup-policy/policy.test.ts)과 같은 단언을 로컬 D1 에서 돈다.
// D1 은 Better Auth 를 transaction: false 로 올린다 (#15). 가입의 user·account 삽입은 한 트랜잭션이 아니다 (TC-M2.T3.a (3)).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tcM2T1b, tcM2T1g, tcM2T2d } from "../../../../packages/auth/test/signup-policy/checks.ts";
import { attempt, body, mail, PASSWORD } from "../../../../packages/auth/test/signup-policy/rig.ts";
import { answerOf } from "../verify-p3/rig.ts";
import { tcM2T1a, tcM2T3a, tcM2T5d, tcM2T5e, tcM2T8a, tcM2T8b, tcM2T8c } from "./checks.ts";
import { startSignupWorker } from "./d1-rig.ts";
import { tcM2T8e, tcM2T8f, tcM2T8g, verificationLink } from "./confirmation-checks.ts";

let w: Awaited<ReturnType<typeof startSignupWorker>>;
beforeAll(async () => {
  w = await startSignupWorker();
});
afterAll(async () => {
  await w?.close();
});

describe("가입 정책 — Workers + D1", () => {
  // 관리자가 없는 D1 이어야 하므로 맨 앞에 둔다 (뒤의 TC 는 관리자를 넣는다)
  it("TC-M2.T7.a Workers + D1: 관리자 없는 로컬 D1, 운영 createAuth → /sign-up/email 200·user·account 각 +1·인증 메일 1통 (V29 의존, PR #15 뒤 단언)", async () => {
    expect((await w.rig.op("rows")).user).toBe(0);
    const r = await attempt(w.rig, async () => {
      const res = await w.rig.call("POST", "/__test/bare/sign-up/email", { body: body(mail("t7a")) });
      return { status: res.status, code: null, body: res.body };
    });
    expect({ status: r.status, user: r.user, account: r.account, mail: r.mail }, r.body).toEqual({ status: 200, user: 1, account: 1, mail: 1 });
  });
  it("TC-M2.T1.a Workers + D1: 정책 다섯 × 경로 둘 표 — open·domain_allowlist 만 공개 가입이 회원을 만든다, 행 수로 판정 (Q3·Q19 의존)", () => tcM2T1a(w.rig));
  it("TC-M2.T1.b Workers + D1: user 를 만드는 다른 경로는 뒷받침 훅이 막는다, 경로 목록은 V32 와 같다 (V29·V32 의존)", () => tcM2T1b(w.rig, answerOf("V32")));
  it("TC-M2.T1.g Workers + D1: 초대 문맥의 서버 호출은 signUpGate 를 지난다, 문맥 없는 호출·closed 는 403·행 0 (V29 의존)", () => tcM2T1g(w.rig));
  it("TC-M2.T2.d Workers + D1: domain_allowlist 인데 허용 도메인이 비면 공개 가입은 모두 403 domain_not_allowed·행 0 (M1 리뷰)", () => tcM2T2d(w.rig));
  it("TC-M2.T3.a Workers + D1: 상한 3 — 차례 4건 +3·4번째 403 signup_cap·알림 1행, 동시 10건은 센 값 == 생긴 공개 가입 수, 실패한 가입은 세지 않음, 초대는 상한 뒤에도 +1 (Q13 의존)", () =>
    tcM2T3a(w.rig, w.rig, { atomicSignup: false }));
  it("TC-M2.T5.d Workers + D1: 감사 기록 문장이 실패한 PATCH → 500·설정 그대로·감사 0 (batch 하나), 정상 PATCH → 설정과 감사 1행 (M1 리뷰)", () => tcM2T5d(w.rig));
  it("TC-M2.T8.a Workers + D1: 선점 → GET 무변경·피해자 비밀번호 확인 401·공격자 미인증 로그인 403·세션 0, 재설정 뒤 피해자 로그인 200 (보안 리뷰 H1)", () => tcM2T8a(w.rig));
  it("TC-M2.T8.b Workers + D1: 정상 가입 → GET 무변경·비밀번호 확인 POST → 원래 비밀번호 로그인 200·재설정 메일 없음 (보안 리뷰 H1 대조)", () => tcM2T8b(w.rig));
  it("TC-M2.T8.c Workers + D1: 재설정은 다른 세션을 모두 끊고 emailVerified 를 true 로 한다 (보안 리뷰 H1)", () => tcM2T8c(w.rig));
  it("TC-M2.T8.e Workers + D1: 최초·재발송 GET은 읽기 전용, 비밀번호 확인 POST만 인증한다", () => tcM2T8e(w.rig));
  it("TC-M2.T8.f Workers + D1: Origin·위조·core GET 차단, 동시 인증은 하나만 성공", () => tcM2T8f(w.rig));
  it("TC-M2.T8.g Workers + D1: 이메일 재생성·재설정 뒤 옛 링크 거부", () => tcM2T8g(w.rig));
  it("H1.D1.API: core 직접 호출은 거부하고 전용 비밀번호 확인 API는 인증한다", async () => {
    await w.rig.op("setSetting", "signup_mode", "open");
    const email = mail("d1-api");
    await w.rig.signUp(body(email));
    const { token } = await verificationLink(w.rig, email);
    const invoke = (method: string, input: any) => w.rig.call("POST", "/__test/api", { body: { method, input } });
    expect((await invoke("verifyEmail", { query: { token } })).json.status).toBe(401);
    expect((await invoke("confirmSignupEmail", { body: { token, password: PASSWORD } })).json.status).toBe(200);
    expect(await w.rig.op("sessionsOf", email)).toBe(0);
  });
  it("H1.D1.SESSION: NULL 호환 경계와 change keep·revoke 계약을 유지한다", async () => {
    for (const state of ["legacy", "oauth", "unverified", "deleted"] as const) {
      const email = mail(`d1-null-${state}`);
      const userId = await w.rig.op("addPasswordUser", email, PASSWORD, "member");
      const login = await w.rig.call("POST", "/api/auth/sign-in/email", { body: { email, password: PASSWORD } });
      expect(login.status).toBe(200);
      const cookie = login.setCookie.map((v) => v.split(";")[0]).join("; ");
      await w.rig.call("POST", "/__test/session-state", { body: { userId, state } });
      const result = await w.rig.call("POST", "/__test/api", { body: { method: "listUserAccounts", input: { headers: { cookie } } } });
      if (state === "legacy" || state === "oauth") {
        expect(result.json.status).toBe(200);
        expect((await w.rig.call("GET", "/api/auth/get-session", { cookie })).json).not.toBeNull();
      } else {
        expect(result.json.status).toBe(401);
        expect((await w.rig.call("GET", "/api/auth/get-session", { cookie })).json).toBeNull();
        expect(await w.rig.op("sessionsOf", email)).toBe(0);
      }
    }
    const email = mail("d1-change-contract");
    await w.rig.op("addPasswordUser", email, PASSWORD, "member");
    const cookies: string[] = [];
    for (let i = 0; i < 2; i++) {
      const login = await w.rig.call("POST", "/api/auth/sign-in/email", { body: { email, password: PASSWORD } });
      cookies.push(login.setCookie.map((v) => v.split(";")[0]).join("; "));
    }
    const change = (currentPassword: string, newPassword: string, revokeOtherSessions: boolean) => w.rig.call("POST", "/api/auth/change-password", { cookie: cookies[0], body: { currentPassword, newPassword, revokeOtherSessions } });
    const kept = await change(PASSWORD, "d1-kept-password-123", false);
    expect(kept.status).toBe(200);
    expect(kept.json.token).toBeNull();
    expect(kept.setCookie).toEqual([]);
    expect(await w.rig.op("sessionsOf", email)).toBe(1);
    expect((await w.rig.call("GET", "/api/auth/get-session", { cookie: cookies[0] })).json).not.toBeNull();
    expect((await w.rig.call("GET", "/api/auth/get-session", { cookie: cookies[1] })).json).toBeNull();
    const other = await w.rig.call("POST", "/api/auth/sign-in/email", { body: { email, password: "d1-kept-password-123" } });
    expect(other.status).toBe(200);
    const otherCookie = other.setCookie.map((v) => v.split(";")[0]).join("; ");
    expect(otherCookie).not.toBe("");
    expect(otherCookie).not.toBe(cookies[0]);
    cookies.push(otherCookie);
    expect(await w.rig.op("sessionsOf", email)).toBe(2);
    expect((await w.rig.call("GET", "/api/auth/get-session", { cookie: cookies[0] })).json).not.toBeNull();
    expect((await w.rig.call("GET", "/api/auth/get-session", { cookie: otherCookie })).json).not.toBeNull();
    const revoked = await change("d1-kept-password-123", "d1-revoked-password-123", true);
    expect(revoked.status).toBe(200);
    expect(typeof revoked.json.token).toBe("string");
    expect(revoked.setCookie).toHaveLength(1);
    expect(await w.rig.op("sessionsOf", email)).toBe(1);
    const rotatedCookie = revoked.setCookie.map((v) => v.split(";")[0]).join("; ");
    expect(rotatedCookie).not.toBe("");
    expect((await w.rig.call("GET", "/api/auth/get-session", { cookie: rotatedCookie })).json).not.toBeNull();
    for (const cookie of cookies) expect((await w.rig.call("GET", "/api/auth/get-session", { cookie })).json).toBeNull();
  });
  it("H1.D1.RACE: verify-reset·login-reset·늦은 insert·change-reset의 barrier와 stale cookie", async () => {
    for (const scenario of ["verify", "login", "insert", "change-password", "change-insert"] as const) {
      const email = mail(`d1-${scenario}`);
      await w.rig.signUp(body(email));
      const { token } = await verificationLink(w.rig, email);
      if (scenario !== "verify") expect((await w.rig.call("POST", "/api/auth/signup-confirmation", { body: { token, password: PASSWORD } })).status).toBe(200);
      let cookie: string | undefined;
      if (scenario.startsWith("change")) {
        const login = await w.rig.call("POST", "/api/auth/sign-in/email", { body: { email, password: PASSWORD } });
        cookie = login.setCookie.map((v) => v.split(";")[0]).join("; ");
      }
      const id = crypto.randomUUID();
      const changing = scenario.startsWith("change");
      const path = scenario === "verify" ? "/signup-confirmation" : changing ? "/change-password" : "/sign-in/email";
      const input = scenario === "verify" ? { token, password: PASSWORD } : changing ? { currentPassword: PASSWORD, newPassword: "d1-change-password-123", revokeOtherSessions: true } : { email, password: PASSWORD };
      const pending = w.rig.call("POST", "/__test/race", { body: { id, path, body: input, cookie, stage: scenario === "insert" || scenario === "change-insert" ? "insert" : "password" } });
      const deadline = Date.now() + 15_000;
      while (!(await w.rig.call("GET", `/__test/barrier?id=${id}`)).json.reached) {
        if (Date.now() > deadline) throw new Error("D1 barrier에 도달하지 못했다");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      try {
        expect((await w.rig.call("POST", "/api/auth/request-password-reset", { body: { email, redirectTo: "/" } })).status).toBe(200);
        const message = (await w.rig.outbox()).filter((m) => m.to === email && m.text.includes("/reset-password/")).at(-1)!;
        const resetToken = new URL(message.text.match(/https?:\/\/\S+/)![0]).pathname.split("/").at(-1);
        expect((await w.rig.call("POST", "/api/auth/reset-password", { body: { token: resetToken, newPassword: "d1-owner-password-123" } })).status).toBe(200);
      } finally { await w.rig.call("DELETE", `/__test/barrier?id=${id}`); }
      const response = await pending;
      expect(response.status).toBe(401);
      expect(response.setCookie).toEqual([]);
      expect(await w.rig.op("sessionsOf", email)).toBe(0);
      if (cookie) {
        expect((await w.rig.call("GET", "/api/auth/get-session", { cookie })).json).toBeNull();
        expect((await w.rig.call("GET", "/api/auth/list-accounts", { cookie })).status).toBe(401);
      }
    }
  });
  it("TC-M2.T5.e Workers + D1: 같은 updatedAt 으로 두 관리자가 같은 키 PATCH → 200 하나·409 stale_setting 하나, 다른 키는 둘 다 200 (M1 리뷰)", () => tcM2T5e(w.rig));
});
