// 초대 수락 (M3.T2) — 서버 앱 전체, SQLite 파일 DB (pnpm test). 운영과 같은 createApp + buildServices(진짜 Better Auth, test/signup/env.ts)다.
// 단언은 실행판 TC-M3.T2.b~f 그대로다. 동시 수락(TC-M3.T2.a)은 accept.db.test.ts(네 DB)·accept.workers.test.ts(D1).
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mail, PASSWORD } from "../../../../packages/auth/test/signup-policy/rig.ts";
import { makeTestEnv, type TestEnv } from "../helpers.ts";
import { fakeOmni } from "../routes/env.ts";
import { serverRig, type ServerRig } from "../signup/env.ts";
import { ACCEPT, acceptBody, INVALID, makeInvite, prepareAccept, unknownToken } from "./accept-checks.ts";

let t: TestEnv;
let rig: ServerRig;
let printed: string[];
beforeEach(async () => {
  t = await makeTestEnv();
  rig = await serverRig("SQLite", { url: t.env.DATABASE_URL });
  printed = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void printed.push(a.map((x) => (x instanceof Error ? `${x.message} ${JSON.stringify((x as any).body ?? null)}` : typeof x === "string" ? x : JSON.stringify(x))).join(" ")));
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rig?.close();
  t?.cleanup();
});

const inviteRow = async (id: string) => (await rig.h.db.select().from(rig.h.schema.invites).where(eq(rig.h.schema.invites.id, id)))[0];
const accept = (b: unknown, ip?: string) => rig.call("POST", ACCEPT, { body: b, ip });
const timed = async <T>(fn: () => Promise<T>) => {
  const s = performance.now();
  const v = await fn();
  return { v, ms: performance.now() - s };
};
const users = () => rig.op("userCount");

describe("TC-M3.T2 초대 수락", () => {
  it("TC-M3.T2.b 실패한 수락은 이유를 가르지 않는다: 없는·만료·취소·사용됨·이메일 불일치·이미 있는 이메일·재초대로 대체·형식 틀린 토큰·입력 형식 오류·정책을 닫은 뒤 → 상태·본문 모두 같은 400 invalid_invite, 응답 ≥ 400ms", async () => {
    const admin = await prepareAccept(rig);
    const existing = mail("t2b-existing");
    await rig.op("addPasswordUser", existing, PASSWORD, "member");
    const free = await makeInvite(rig, admin, { role: "member" });
    const expired = await makeInvite(rig, admin, { role: "member" });
    await rig.h.db.update(rig.h.schema.invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(rig.h.schema.invites.id, expired.id));
    const revoked = await makeInvite(rig, admin, { role: "member" });
    expect((await rig.call("DELETE", `/api/admin/invites/${revoked.id}`, { cookie: admin.cookie })).status).toBe(200);
    const used = await makeInvite(rig, admin, { role: "member" });
    expect((await accept(acceptBody(used.token, mail("t2b-used-first")))).status).toBe(201);
    const bound = await makeInvite(rig, admin, { role: "member", email: "t2b-bound@example.test" });
    const replacedEmail = "t2b-replaced@example.test";
    const replaced = await makeInvite(rig, admin, { role: "member", email: replacedEmail });
    await makeInvite(rig, admin, { role: "member", email: replacedEmail });
    const closed = await makeInvite(rig, admin, { role: "member" });

    const cases: [string, () => Promise<{ status: number; body: string }>][] = [
      ["없는 토큰", () => accept(acceptBody(unknownToken(), mail("t2b")))],
      ["만료", () => accept(acceptBody(expired.token, mail("t2b")))],
      ["취소", () => accept(acceptBody(revoked.token, mail("t2b")))],
      ["사용됨", () => accept(acceptBody(used.token, mail("t2b")))],
      ["이메일 불일치", () => accept(acceptBody(bound.token, "t2b-other@example.test"))],
      ["이메일 불일치(도메인 꼬리가 다름)", () => accept(acceptBody(bound.token, "t2b-bound@example.test.evil"))],
      ["이미 있는 이메일", () => accept(acceptBody(free.token, existing))],
      ["이미 있는 이메일(대소문자·공백)", () => accept(acceptBody(free.token, `  ${existing.toUpperCase()} `))],
      ["재초대로 대체된 링크", () => accept(acceptBody(replaced.token, replacedEmail))],
      ["형식 틀린 토큰(짧음)", () => accept(acceptBody("abc", mail("t2b")))],
      ["형식 틀린 토큰(44자)", () => accept(acceptBody(`${free.token}A`, mail("t2b")))],
      ["형식 틀린 토큰(= 덧붙임)", () => accept(acceptBody(`${free.token.slice(0, 42)}=`, mail("t2b")))],
      ["토큰이 문자열이 아님", () => accept(acceptBody(123 as any, mail("t2b")))],
      ["이름 없음", () => accept({ token: free.token, email: mail("t2b"), password: PASSWORD })],
      ["비밀번호 짧음", () => accept(acceptBody(free.token, mail("t2b"), { password: "short" }))],
      ["이메일 형식 틀림", () => accept(acceptBody(free.token, "not-an-email"))],
      ["JSON 아님", () => rig.call("POST", ACCEPT, { headers: { "content-type": "application/json" }, body: undefined })],
      ["배열 본문", () => accept([1, 2])],
    ];
    const before = await users();
    const out: Record<string, unknown> = {};
    for (const [label, run] of cases) {
      const { v, ms } = await timed(run);
      out[label] = { status: v.status, body: v.body, slow: ms >= 400 };
    }
    // 정책을 닫은 뒤의 기존 링크
    await rig.op("setSetting", "signup_mode", "closed");
    {
      const { v, ms } = await timed(() => accept(acceptBody(closed.token, mail("t2b-closed"))));
      out["정책을 닫은 뒤"] = { status: v.status, body: v.body, slow: ms >= 400 };
    }
    const want = Object.fromEntries(Object.keys(out).map((k) => [k, { status: 400, body: INVALID, slow: true }]));
    expect(out).toEqual(want);
    expect(await users()).toBe(before);
    // 소진되지 않은 초대: 이미 있는 이메일로 시도한 free, 정책을 닫은 뒤 시도한 closed
    for (const id of [free.id, closed.id]) expect({ id, usedAt: (await inviteRow(id)).usedAt, usedBy: (await inviteRow(id)).usedBy }).toEqual({ id, usedAt: null, usedBy: null });
    // 기록에 비밀번호·토큰·본문 이메일이 없다
    const log = printed.join("\n");
    for (const s of [PASSWORD, free.token, closed.token, existing, "t2b-other@example.test"]) expect(log, s).not.toContain(s);
  });

  it("TC-M3.T2.c 이메일 지정 초대는 인증된 회원을 만들고 인증 메일을 보내지 않는다 → 곧바로 POST /api/me/keys 201. 이메일 없는 링크 → emailVerified false·인증 메일 1통·키 발급 거부", async () => {
    const admin = await prepareAccept(rig);
    const om = fakeOmni();
    rig.services.keysClient = async () => () => om.client();
    // 이메일 지정 초대
    const bound = mail("t2c-bound");
    const inv = await makeInvite(rig, admin, { role: "member", email: bound });
    const m0 = (await rig.outbox()).length;
    const r = await accept(acceptBody(inv.token, bound));
    expect(r.status, r.body).toBe(201);
    expect((await rig.outbox()).length - m0, "인증 메일 0통").toBe(0);
    expect((await rig.op("user", bound))?.emailVerified).toBe(true);
    const signIn = await rig.call("POST", "/api/auth/sign-in/email", { body: { email: bound, password: PASSWORD } });
    expect(signIn.status, signIn.body).toBe(200);
    const cookie = signIn.setCookie.map((c) => c.split(";")[0]).join("; ");
    const key = await rig.call("POST", "/api/me/keys", { cookie, body: {} });
    expect(key.status, key.body).toBe(201);
    // 이메일 없는 링크
    const open = mail("t2c-open");
    const inv2 = await makeInvite(rig, admin, { role: "member" });
    const m1 = (await rig.outbox()).length;
    const r2 = await accept(acceptBody(inv2.token, open));
    expect(r2.status, r2.body).toBe(201);
    const sent = (await rig.outbox()).slice(m1);
    expect(sent.map((m) => m.to), "인증 메일 1통").toEqual([open]);
    expect((await rig.op("user", open))?.emailVerified).toBe(false);
    // 키 발급 거부: 미인증 회원은 로그인되지 않고(403), 세션이 있어도 미인증이면 그 세션은 무효다(H1) → 키 발급 401
    const signIn2 = await rig.call("POST", "/api/auth/sign-in/email", { body: { email: open, password: PASSWORD } });
    expect(signIn2.status, signIn2.body).toBe(403);
    await rig.op("verify", open);
    const signIn3 = await rig.call("POST", "/api/auth/sign-in/email", { body: { email: open, password: PASSWORD } });
    expect(signIn3.status, signIn3.body).toBe(200);
    await rig.h.db.update(rig.h.schema.user).set({ emailVerified: false }).where(eq(rig.h.schema.user.email, open));
    const key2 = await rig.call("POST", "/api/me/keys", { cookie: signIn3.setCookie.map((c) => c.split(";")[0]).join("; "), body: {} });
    expect(key2.status, key2.body).toBe(401);
    expect(om.of("createKey")).toHaveLength(1);
  });

  it("TC-M3.T2.d 초대 회원의 역할·상태·한도는 초대 문맥에서만 온다: admin 초대 → admin·active·한도 5·max_keys NULL, 본문의 권한 필드는 무시, member 초대 본문 role admin → member", async () => {
    const admin = await prepareAccept(rig);
    const extra = { role: "admin", status: "pending", monthlyLimitUsd: 999, emailVerified: true, maxKeys: 50 };
    const a = mail("t2d-admin");
    const ai = await makeInvite(rig, admin, { role: "admin", email: a });
    expect((await accept(acceptBody(ai.token, a))).status).toBe(201);
    const b = mail("t2d-admin-extra");
    const bi = await makeInvite(rig, admin, { role: "admin", email: b });
    expect((await accept(acceptBody(bi.token, b, { ...extra, role: "member" }))).status).toBe(201);
    const m = mail("t2d-member");
    const mi = await makeInvite(rig, admin, { role: "member" });
    const mr = await accept(acceptBody(mi.token, m, extra));
    expect(mr.status, mr.body).toBe(201);
    expect(await rig.op("user", a)).toMatchObject({ role: "admin", status: "active", monthlyLimitUsd: 5, maxKeys: null });
    expect(await rig.op("user", b)).toMatchObject({ role: "admin", status: "active", monthlyLimitUsd: 5, maxKeys: null });
    expect(await rig.op("user", m)).toMatchObject({ role: "member", status: "active", emailVerified: false, monthlyLimitUsd: 5, maxKeys: null });
    // 마무리: used_by = 새 회원, 감사 invite.accept (토큰·이메일 없음)
    const row = await inviteRow(mi.id);
    expect(row.usedBy).toBe((await rig.op("user", m))?.id);
    expect(row.usedAt).not.toBeNull();
    const audits = await rig.h.db.select().from(rig.h.schema.auditLog).where(eq(rig.h.schema.auditLog.action, "invite.accept"));
    expect(audits.map((x: any) => x.target).sort()).toEqual([ai.id, bi.id, mi.id].sort());
    expect(JSON.stringify(audits)).not.toContain(mi.token);
    expect(JSON.stringify(audits)).not.toContain(m);
  });

  it("TC-M3.T2.e 이미 있는 이메일로 수락하면 초대가 소진되지 않는다, 다른 이메일로 다시 수락 → 201. 두 수락이 겹치면 되돌리기는 자기 차지만 지운다", async () => {
    const admin = await prepareAccept(rig);
    const existing = mail("t2e-existing");
    await rig.op("addPasswordUser", existing, PASSWORD, "member");
    const inv = await makeInvite(rig, admin, { role: "member" });
    const before = await users();
    const r = await accept(acceptBody(inv.token, existing));
    expect({ status: r.status, body: r.body }).toEqual({ status: 400, body: INVALID });
    expect({ usedAt: (await inviteRow(inv.id)).usedAt, usedBy: (await inviteRow(inv.id)).usedBy, users: await users() }).toEqual({ usedAt: null, usedBy: null, users: before });
    const other = mail("t2e-other");
    expect((await accept(acceptBody(inv.token, other))).status).toBe(201);
    expect(await users()).toBe(before + 1);

    // 겹침: A 가 차지한 뒤 가입하는 동안, A 의 차지가 풀리고 B 가 같은 초대를 차지한 상황(used_at 이 B 의 값)을 만든다.
    // A 는 이미 있는 이메일이라 실패하고 되돌린다 — 되돌리기는 자기 used_at 일 때만 지우므로 B 의 차지는 남는다
    const inv2 = await makeInvite(rig, admin, { role: "member" });
    const bAt = new Date(Date.now() + 5_000);
    const auth = rig.services.auth as any;
    const orig = auth.api;
    rig.services.auth = {
      ...auth,
      api: {
        ...orig,
        signUpEmail: async (o: any) => {
          await rig.h.db.update(rig.h.schema.invites).set({ usedAt: bAt }).where(eq(rig.h.schema.invites.id, inv2.id));
          return orig.signUpEmail(o);
        },
      },
    } as any;
    const ra = await accept(acceptBody(inv2.token, existing));
    rig.services.auth = auth;
    expect({ status: ra.status, body: ra.body }).toEqual({ status: 400, body: INVALID });
    expect(new Date((await inviteRow(inv2.id)).usedAt).getTime(), "B 의 차지가 남는다").toBe(bAt.getTime());
    // B 의 차지가 남아 있으므로 같은 초대로 다시 가입되지 않는다
    expect((await accept(acceptBody(inv2.token, mail("t2e-third")))).status).toBe(400);
    expect(await users()).toBe(before + 1);
  });

  it("TC-M3.T2.f 수락 요청 수 제한: 같은 IP 에서 10분 안에 11번째 → 429, 다른 IP 는 400 invalid_invite", async () => {
    await prepareAccept(rig);
    const ip = "203.0.113.77";
    const first = await Promise.all(Array.from({ length: 10 }, () => accept(acceptBody(unknownToken(), mail("t2f")), ip)));
    expect(first.map((r) => r.status)).toEqual(Array(10).fill(400));
    const eleventh = await accept(acceptBody(unknownToken(), mail("t2f")), ip);
    expect({ status: eleventh.status, body: eleventh.json }).toEqual({ status: 429, body: { error: "rate_limited" } });
    const other = await accept(acceptBody(unknownToken(), mail("t2f")), "203.0.113.78");
    expect({ status: other.status, body: other.body }).toEqual({ status: 400, body: INVALID });
    // 토큰 해시는 기록되지 않는다 (요청 수 제한 칸 이름에도)
    const keys = (await rig.h.db.select({ key: rig.h.schema.rateLimit.key }).from(rig.h.schema.rateLimit)).map((r: { key: string }) => r.key);
    expect(keys.filter((k: string) => k.startsWith("invite-accept|"))).toEqual(["invite-accept|203.0.113.77", "invite-accept|203.0.113.78"]);
  });
});
