// 가입 정책 (M2) — 서버 앱 전체, SQLite 파일 DB (pnpm test). 다섯 DB 에서 도는 단언은 policy.db.test.ts·signup.workers.test.ts.
// 가입 거부는 생긴 행 수와 메일 수로 본다 (실행판 0절).
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAsInvite } from "@magnetosphere/auth/invite-context";
import { attempt, body, mail, PASSWORD, userRows } from "../../../../packages/auth/test/signup-policy/rig.ts";
import { MAIL_API_KEY_AAD } from "../../src/setup/mail.ts";
import { makeTestEnv, type TestEnv } from "../helpers.ts";
import { FAKE_INVITE, installed, login } from "./checks.ts";
import { serverRig, type ServerRig } from "./env.ts";

let t: TestEnv;
let rig: ServerRig;
beforeEach(async () => {
  t = await makeTestEnv();
  rig = await serverRig("SQLite", { url: t.env.DATABASE_URL });
  await installed(rig);
});
afterEach(async () => {
  await rig?.close();
  t?.cleanup();
});

const mode = (m: string) => rig.op("setSetting", "signup_mode", m);
const v32 = () => import("../../../../docs/verify/V32.json", { with: { type: "json" } }).then((m) => (m.default as any).answer);

describe("TC-M2.T1 정책 판정·앞 판정", () => {
  it("TC-M2.T1.c signup_mode open 을 둔 뒤 mail_settings 행을 지우면 공개 가입 403 mail_required·행 0·메일 0 (대조: 메일이 있으면 가입된다)", async () => {
    await mode("open");
    const ok = await attempt(rig, () => rig.signUp(body(mail("t1c-ok"))));
    expect({ status: ok.status, user: ok.user, mail: ok.mail }).toEqual({ status: 200, user: 1, mail: 1 });
    await rig.op("setMail", false);
    for (const m of ["open", "domain_allowlist"]) {
      await mode(m);
      const r = await attempt(rig, () => rig.signUp(body(mail("t1c"))));
      expect({ m, status: r.status, code: r.code, user: r.user, account: r.account, verification: r.verification, mail: r.mail }).toEqual({
        m,
        status: 403,
        code: "mail_required",
        user: 0,
        account: 0,
        verification: 0,
        mail: 0,
      });
    }
  });

  it("TC-M2.T1.d /change-email · /update-user {email} · /delete-user → V32 의 상태(400·400·404), 회원 이메일·행 그대로, V32 mustDisable 비어 있음 (V32·Q14 의존)", async () => {
    const A = await v32();
    expect(A.mustDisable).toEqual([]);
    const m = await login(rig, "member");
    const outside = mail("t1d-outside", "outside.example");
    const want = Object.fromEntries(A.paths.map((p: any) => [p.path, p.status]));
    const calls: [string, string, unknown][] = [
      ["/change-email", "/api/auth/change-email", { newEmail: outside }],
      ["/update-user email", "/api/auth/update-user", { email: outside }],
      ["/delete-user", "/api/auth/delete-user", { password: PASSWORD }],
    ];
    for (const [label, path, b] of calls) {
      const r = await rig.call("POST", path, { cookie: m.cookie, body: b });
      expect({ label, status: r.status }).toEqual({ label, status: want[label] });
      const row = await rig.op("user", m.email);
      expect(row?.id, `${label}: 회원 행`).toBe(m.id);
    }
    expect(await rig.op("user", outside)).toBeNull();
  });

  it("TC-M2.T1.e 정책 거부 응답은 있는 이메일·없는 이메일이 바이트 단위로 같다, open 의 있는 이메일 가짜 200 과 새 가입 200 은 모양이 같다 (Q19 의존)", async () => {
    const existing = mail("t1e-old", "outside.test");
    await rig.op("addPasswordUser", existing, PASSWORD, "member");
    await rig.op("setSetting", "allowed_domains", ["example.test"]);
    const cases: [string, () => Promise<unknown>][] = [
      ["invite_only", () => mode("invite_only")],
      ["closed", () => mode("closed")],
      ["domain_allowlist 바깥 도메인", () => mode("domain_allowlist")],
      ["메일 없음", async () => (await mode("open"), await rig.op("setMail", false))],
    ];
    for (const [label, set] of cases) {
      await set();
      const a = await attempt(rig, () => rig.signUp(body(existing)));
      const b = await attempt(rig, () => rig.signUp(body(mail("t1e-new", "outside.test"))));
      expect({ label, status: a.status, body: a.body, user: a.user }).toEqual({ label, status: b.status, body: b.body, user: 0 });
      expect(a.status, label).toBe(403);
      expect(b.user, label).toBe(0);
    }
    // open + 메일: 있는 이메일은 Better Auth 가짜 200, 없는 이메일은 새 가입 200. 무작위 값(id·시각)과 이메일만 다르다
    await rig.op("setMail", true);
    await mode("open");
    const shape = (s: string) => {
      const j = JSON.parse(s);
      return { ...j, user: { ...j.user, id: "<id>", email: "<email>", createdAt: "<t>", updatedAt: "<t>" } };
    };
    const dup = await attempt(rig, () => rig.signUp(body(existing)));
    const fresh = await attempt(rig, () => rig.signUp(body(mail("t1e-fresh", "outside.test"))));
    expect([dup.status, fresh.status, dup.user, fresh.user]).toEqual([200, 200, 0, 1]);
    expect(shape(dup.body)).toEqual(shape(fresh.body));
  });

  it("TC-M2.T1.f 공개 요청은 본문·헤더로 초대 문맥을 흉내 낼 수 없다, 같은 시각 다른 요청이 runAsInvite 안에 있어도 공개 요청은 행 0", async () => {
    await mode("invite_only");
    const forged = (tag: string) =>
      rig.signUp(body(mail(tag), { inviteId: FAKE_INVITE.inviteId, invite: FAKE_INVITE, __invite: FAKE_INVITE.inviteId, role: "admin" }), {
        headers: { "x-invite": FAKE_INVITE.inviteId, "x-invite-id": FAKE_INVITE.inviteId, "x-magnetosphere-invite": "1" },
      });
    const lone = await attempt(rig, () => forged("t1f-lone"));
    expect({ status: lone.status, user: lone.user }).toEqual({ status: 403, user: 0 });

    // 초대 문맥이 열려 있는 동안 공개 요청 셋을 바깥 흐름에서 보낸다
    const api = (rig.services.auth as any).api;
    const u0 = await userRows(rig);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const invited = mail("t1f-invited");
    const inv = runAsInvite(FAKE_INVITE, async () => {
      await gate;
      return api.signUpEmail({ body: body(invited) });
    });
    const pubs = Promise.all([forged("t1f-a"), forged("t1f-b"), rig.signUp(body(mail("t1f-c")))]);
    release();
    const [pubRes] = await Promise.all([pubs, inv]);
    expect(pubRes.map((r) => r.status)).toEqual([403, 403, 403]);
    expect((await userRows(rig)) - u0).toBe(1);
    expect((await rig.op("user", invited))?.role).toBe("member");
  });
});

describe("TC-M2.T2 허용 도메인·승인 대기·기본값", () => {
  it("TC-M2.T2.a 승인 켬: open·domain_allowlist 자기 가입 → pending·키 발급 403, 승인 끔 → active, 초대 → active (Q6 의존)", async () => {
    const signed = async (tag: string) => {
      const e = mail(tag);
      expect((await rig.signUp(body(e))).status).toBe(200);
      return e;
    };
    await rig.op("setSetting", "signup_requires_approval", true);
    await mode("open");
    const p1 = await signed("t2a-open");
    await mode("domain_allowlist");
    const p2 = await signed("t2a-allow");
    expect([(await rig.op("user", p1))?.status, (await rig.op("user", p2))?.status]).toEqual(["pending", "pending"]);
    // 승인 대기 회원은 인증·로그인을 해도 키를 받지 못한다
    await rig.op("verify", p1);
    const s = await rig.call("POST", "/api/auth/sign-in/email", { body: { email: p1, password: PASSWORD } });
    expect(s.status, s.body).toBe(200);
    const cookie = s.setCookie.map((c) => c.split(";")[0]).join("; ");
    const key = await rig.call("POST", "/api/me/keys", { cookie, body: {} });
    expect({ status: key.status, error: key.json?.error }).toEqual({ status: 403, error: "member_inactive" });
    // 초대 문맥 → active
    const inv = mail("t2a-inv");
    expect((await rig.apiSignUp(body(inv), FAKE_INVITE)).status).toBe(200);
    expect((await rig.op("user", inv))?.status).toBe("active");
    // 승인 끔 → active
    await rig.op("setSetting", "signup_requires_approval", false);
    await mode("open");
    expect((await rig.op("user", await signed("t2a-off")))?.status).toBe("active");
  });

  it("TC-M2.T2.b 허용 도메인은 정확히 일치한다: 소문자·punycode 로 비교, 하위 도메인·비슷한 이름·끝 점·전각·동형 문자·따옴표·@ 둘은 403 domain_not_allowed·행 0 (Q14·Q19 의존)", async () => {
    await rig.op("setSetting", "allowed_domains", ["example.com", "bücher.example"]);
    await mode("domain_allowlist");
    const n = () => Math.random().toString(36).slice(2, 8);
    const allowed = [`a${n()}@example.com`, `A${n()}@EXAMPLE.com`, `a${n()}+tag@example.com`, `b${n()}@xn--bcher-kva.example`];
    for (const e of allowed) {
      const r = await attempt(rig, () => rig.signUp(body(e)));
      expect({ e, status: r.status, user: r.user }, r.body).toEqual({ e, status: 200, user: 1 });
    }
    // 국제 도메인 원래 꼴: 판정은 punycode 로 허용 목록과 맞는다 (Better Auth 의 이메일 형식 검사가 받지 않으면 400 이지만 domain_not_allowed 는 아니다)
    const idn = await attempt(rig, () => rig.signUp(body(`c${n()}@bücher.example`)));
    expect(idn.code, idn.body).not.toBe("domain_not_allowed");
    const denied = [
      `a${n()}@sub.example.com`,
      `a${n()}@notexample.com`,
      `a${n()}@example.com.evil.io`,
      `a${n()}@example.com.`,
      `a${n()}@ｅｘａｍｐｌｅ.com`,
      `a${n()}@exаmple.com`, // 키릴 а
      `"a${n()}@evil.io"@example.com`,
      `a${n()}@evil.io@example.com`,
      `a${n()}@example.co`,
      `a${n()}`,
    ];
    for (const e of denied) {
      const r = await attempt(rig, () => rig.signUp(body(e)));
      expect({ e, status: r.status, code: r.code, user: r.user, account: r.account, mail: r.mail }).toEqual({ e, status: 403, code: "domain_not_allowed", user: 0, account: 0, mail: 0 });
    }
  });

  it("TC-M2.T2.c 새 회원 monthly_limit_usd = default_limit_usd (공개·초대), max_keys NULL, 바꾸면 새 회원만, 설정 API 의 null 은 400, 행 없음은 시드 5 (Q16 의존)", async () => {
    await mode("open");
    await rig.op("setSetting", "default_limit_usd", 5);
    const pub = mail("t2c-pub");
    const inv = mail("t2c-inv");
    await rig.signUp(body(pub));
    await rig.apiSignUp(body(inv), FAKE_INVITE);
    for (const e of [pub, inv]) expect(await rig.op("user", e)).toMatchObject({ monthlyLimitUsd: 5, maxKeys: null });
    // 설정 API 로 7 로 바꾼다
    const admin = await login(rig, "admin");
    const at = (await rig.call("GET", "/api/admin/settings/signup", { cookie: admin.cookie })).json.updatedAt;
    const nul = await rig.call("PATCH", "/api/admin/settings/signup", { cookie: admin.cookie, body: { defaultLimitUsd: null, updatedAt: { defaultLimitUsd: at.defaultLimitUsd } } });
    expect({ status: nul.status, error: nul.json?.error }).toEqual({ status: 400, error: "invalid_value" });
    const seven = await rig.call("PATCH", "/api/admin/settings/signup", { cookie: admin.cookie, body: { defaultLimitUsd: 7, updatedAt: { defaultLimitUsd: at.defaultLimitUsd } } });
    expect(seven.status, seven.body).toBe(200);
    const pub7 = mail("t2c-pub7");
    const inv7 = mail("t2c-inv7");
    await rig.signUp(body(pub7));
    await rig.apiSignUp(body(inv7), FAKE_INVITE);
    for (const e of [pub, inv]) expect((await rig.op("user", e))?.monthlyLimitUsd).toBe(5);
    for (const e of [pub7, inv7]) expect(await rig.op("user", e)).toMatchObject({ monthlyLimitUsd: 7, maxKeys: null });
    // 행 없음 → 시드 5
    await rig.op("setSetting", "default_limit_usd", undefined);
    const none = mail("t2c-none");
    await rig.signUp(body(none));
    expect((await rig.op("user", none))?.monthlyLimitUsd).toBe(5);
  });
});

describe("TC-M2.T3 하루 가입 상한", () => {
  it("TC-M2.T3.b 상한 3, 이미 있는 이메일로 공개 가입 20번 → 오늘 수 0, 그 뒤 새 이메일 3건 +3 (Q13 의존)", async () => {
    await mode("open");
    await rig.op("setSetting", "daily_signup_cap", 3);
    const existing = mail("t3b-old");
    await rig.op("addPasswordUser", existing, PASSWORD, "member");
    for (let i = 0; i < 20; i++) expect((await rig.signUp(body(existing))).status).toBe(200);
    expect(await rig.op("signupCount")).toBe(0);
    for (let i = 0; i < 3; i++) {
      const r = await attempt(rig, () => rig.signUp(body(mail(`t3b-${i}`))));
      expect({ i, status: r.status, user: r.user }).toEqual({ i, status: 200, user: 1 });
    }
    expect(await rig.op("signupCount")).toBe(3);
  });

  it("TC-M2.T3.c 상한 null → 100건 모두 +1, 0 → 첫 공개 가입부터 403 signup_cap·행 0 (Q13 의존)", async () => {
    await mode("open");
    await rig.op("setSetting", "daily_signup_cap", null);
    const u0 = await userRows(rig);
    for (let i = 0; i < 100; i++) expect((await rig.signUp(body(mail(`t3c-${i}`)))).status).toBe(200);
    expect((await userRows(rig)) - u0).toBe(100);
    await rig.op("setSetting", "daily_signup_cap", 0);
    await rig.op("newDay");
    const r = await attempt(rig, () => rig.signUp(body(mail("t3c-zero"))));
    expect({ status: r.status, code: r.code, user: r.user, mail: r.mail }).toEqual({ status: 403, code: "signup_cap", user: 0, mail: 0 });
  });
});

describe("TC-M2.T5 정책·메일 설정 API", () => {
  const get = (cookie: string) => rig.call("GET", "/api/admin/settings/signup", { cookie });
  const patch = (cookie: string, b: Record<string, unknown>, at: Record<string, string | null>, origin?: string | null) =>
    rig.call("PATCH", "/api/admin/settings/signup", { cookie, origin, body: { ...b, updatedAt: Object.fromEntries(Object.keys(b).map((k) => [k, at[k]])) } });

  it("TC-M2.T5.a 회원·정지된 관리자 403, 다른 출처 403, 활성 관리자 PATCH closed → 200·감사 1행 → 다른 인스턴스의 바로 다음 공개 가입 행 0", async () => {
    const other = await serverRig("SQLite 두 번째 인스턴스", { url: t.env.DATABASE_URL });
    try {
      await mode("open");
      // 대조: 열려 있을 때 다른 인스턴스에서 가입된다
      expect((await attempt(other, () => other.signUp(body(mail("t5a-before"))))).user).toBe(1);
      const member = await login(rig, "member");
      const suspended = await login(rig, "admin", "suspended");
      const admin = await login(rig, "admin");
      const at = (await get(admin.cookie)).json.updatedAt;
      expect((await get(member.cookie)).status).toBe(403);
      expect((await get(suspended.cookie)).status).toBe(403);
      expect((await rig.call("GET", "/api/admin/settings/signup")).status).toBe(401);
      expect((await patch(member.cookie, { signupMode: "closed" }, at)).status).toBe(403);
      expect((await patch(suspended.cookie, { signupMode: "closed" }, at)).status).toBe(403);
      const cross = await patch(admin.cookie, { signupMode: "closed" }, at, "https://evil.example");
      expect({ status: cross.status, error: cross.json?.error }).toEqual({ status: 403, error: "forbidden_origin" });
      expect(await rig.op("audits", "settings.update")).toBe(0);
      const ok = await patch(admin.cookie, { signupMode: "closed" }, at);
      expect(ok.status, ok.body).toBe(200);
      expect(ok.json.settings.signupMode).toBe("closed");
      expect(await rig.op("audits", "settings.update")).toBe(1);
      const after = await attempt(other, () => other.signUp(body(mail("t5a-after"))));
      expect({ status: after.status, code: after.code, user: after.user }).toEqual({ status: 403, code: "signup_closed", user: 0 });
    } finally {
      await other.close();
    }
  });

  it("TC-M2.T5.b 메일 없음 → PATCH open 409 mail_required → PUT mail → PATCH open 200 (Q15·Q20 의존)", async () => {
    await rig.op("setMail", false);
    await mode("invite_only");
    const admin = await login(rig, "admin");
    let at = (await get(admin.cookie)).json.updatedAt;
    expect((await get(admin.cookie)).json.mailConfigured).toBe(false);
    const no = await patch(admin.cookie, { signupMode: "open" }, at);
    expect({ status: no.status, error: no.json?.error }).toEqual({ status: 409, error: "mail_required" });
    const put = await rig.call("PUT", "/api/admin/settings/mail", { cookie: admin.cookie, body: { provider: "resend", from: "noreply@example.com", apiKey: "re_test_key_t5b" } });
    expect(put.status, put.body).toBe(200);
    expect((await get(admin.cookie)).json.mailConfigured).toBe(true);
    at = (await get(admin.cookie)).json.updatedAt;
    const yes = await patch(admin.cookie, { signupMode: "open" }, at);
    expect(yes.status, yes.body).toBe(200);
    expect(yes.json.settings.signupMode).toBe("open");
  });

  it("TC-M2.T5.c 메일 API 키는 설치와 같은 AAD 로 암호화되어 저장되고 응답·감사 기록에 없다, 테스트 메일은 관리자 자신에게 1시간 5회 (Q20 의존)", async () => {
    await rig.op("setMail", false);
    const admin = await login(rig, "admin");
    const secret = "re_x_t5c_super_secret_key";
    const bad = await rig.call("PUT", "/api/admin/settings/mail", { cookie: admin.cookie, body: { provider: "smtp", from: "a@example.com", apiKey: secret } });
    expect(bad.status).toBe(400);
    const put = await rig.call("PUT", "/api/admin/settings/mail", { cookie: admin.cookie, body: { provider: "resend", from: "noreply@example.com", apiKey: secret } });
    expect(put.status, put.body).toBe(200);
    expect(put.body).not.toContain("re_x");
    const t0 = rig.h.schema.appSettings;
    const [row] = await rig.h.db.select({ value: t0.value }).from(t0).where(eq(t0.key, "mail_settings"));
    const stored = JSON.parse(row.value);
    expect(stored.apiKey).not.toBe(secret);
    expect(row.value).not.toContain("re_x");
    expect(await rig.services.cipher.decrypt(stored.apiKey, MAIL_API_KEY_AAD)).toBe(secret);
    expect((await get(admin.cookie)).body).not.toContain("re_x");
    const audit = await rig.h.db.select().from(rig.h.schema.auditLog);
    expect(JSON.stringify(audit)).not.toContain("re_x");
    expect(JSON.stringify(audit)).not.toContain("noreply@example.com");
    // 테스트 메일: 관리자 자신에게, 1시간 5회
    const before = (await rig.outbox()).length;
    for (let i = 0; i < 5; i++) expect((await rig.call("POST", "/api/admin/settings/mail/test", { cookie: admin.cookie })).status).toBe(200);
    const sent = (await rig.outbox()).slice(before);
    expect(sent.map((m) => m.to)).toEqual(Array(5).fill(admin.email.toLowerCase()));
    expect((await rig.call("POST", "/api/admin/settings/mail/test", { cookie: admin.cookie })).status).toBe(429);
    expect((await rig.call("POST", "/api/admin/settings/mail/test", { cookie: admin.cookie, origin: "https://evil.example" })).status).toBe(403);
  });
});
