// 초대 수락 (M3.T2) — Workers + D1 (pnpm -C apps/server test:workers). 가입 정책 시험 Worker(test/signup/wrangler.jsonc, worker.ts)를
// 그대로 쓴다 — 운영과 같은 createApp + buildServices 라 수락 경로가 함께 올라간다. D1 은 대화형 트랜잭션이 없어
// 차지(한 문장 UPDATE … RETURNING)와 되돌리기·마무리(batch)가 Node 와 다른 경로를 탄다 (G-M3.8).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSignupWorker } from "../signup/d1-rig.ts";
import { mail, PASSWORD } from "../../../../packages/auth/test/signup-policy/rig.ts";
import { signJWT } from "better-auth/crypto";
import { TEST_SECRET } from "../helpers.ts";
import { ACCEPT, acceptBody, INVALID, makeInvite, prepareAccept, tcM3T2a, tcM3T2g } from "./accept-checks.ts";

let w: Awaited<ReturnType<typeof startSignupWorker>>;
beforeAll(async () => {
  w = await startSignupWorker();
});
afterAll(async () => {
  await w?.close();
});

describe("초대 수락 — Workers + D1", () => {
  // 실제 D1 batch 에 감사 INSERT … SELECT 가 들어가는지 (libsql batch 흉내로는 드러나지 않던 경로): 재초대 취소·관리자 취소
  it("TC-M3.T1.g Workers + D1: 재초대는 앞 초대를 취소하고 invite.revoke 1행, DELETE → 200·invite.revoke 1행, 다시 DELETE → 404·감사 그대로", async () => {
    const admin = await prepareAccept(w.rig);
    const email = "t1g-d1@example.test";
    const first = await makeInvite(w.rig, admin, { role: "member", email });
    const r0 = await w.rig.op("audits", "invite.revoke");
    const second = await makeInvite(w.rig, admin, { role: "member", email });
    expect(await w.rig.op("audits", "invite.revoke")).toBe(r0 + 1);
    expect((await w.rig.call("DELETE", `/api/admin/invites/${first.id}`, { cookie: admin.cookie })).status).toBe(404);
    const del = await w.rig.call("DELETE", `/api/admin/invites/${second.id}`, { cookie: admin.cookie });
    expect(del.status, del.body).toBe(200);
    expect(await w.rig.op("audits", "invite.revoke")).toBe(r0 + 2);
    expect((await w.rig.call("DELETE", `/api/admin/invites/${second.id}`, { cookie: admin.cookie })).status).toBe(404);
    expect(await w.rig.op("audits", "invite.revoke")).toBe(r0 + 2);
  });

  it("TC-M3.T2.a Workers + D1: 같은 토큰 동시 수락 10건(이메일 지정 없음, 이메일 10개) → 201 정확히 1·나머지 400 invalid_invite·user 증가 1", async () => {
    const o = await tcM3T2a(w.rig);
    console.info(`[TC-M3.T2.a d1] ${JSON.stringify(o)}`);
  });

  it("TC-M3.T2.e Workers + D1: 이미 있는 이메일로 수락 → 400 invalid_invite·user 증가 0·초대 소진 안 됨(다른 이메일로 다시 수락 201)·invite.accept 1행", async () => {
    const admin = await prepareAccept(w.rig);
    const existing = mail("t2e-d1-existing");
    await w.rig.op("addPasswordUser", existing, PASSWORD, "member");
    const inv = await makeInvite(w.rig, admin, { role: "member" });
    const before = await w.rig.op("userCount");
    const accepts = await w.rig.op("audits", "invite.accept");
    const r = await w.rig.call("POST", ACCEPT, { body: acceptBody(inv.token, existing) });
    expect({ status: r.status, body: r.body }).toEqual({ status: 400, body: INVALID });
    expect(await w.rig.op("userCount")).toBe(before);
    const ok = await w.rig.call("POST", ACCEPT, { body: acceptBody(inv.token, mail("t2e-d1-other")) });
    expect(ok.status, ok.body).toBe(201);
    expect(await w.rig.op("userCount")).toBe(before + 1);
    expect(await w.rig.op("audits", "invite.accept")).toBe(accepts + 1);
  });

  it("TC-M3.T2.g Workers + D1: 이메일 없는 초대를 남의 이메일로 수락해도 가로채지 못한다 — 메일 링크·core /verify-email 401·모르는 비밀번호 401·공격자 로그인 403·피해자 재설정으로 회복 (보안 리뷰 H-1)", () =>
    tcM3T2g(w.rig, (email) => signJWT({ email }, TEST_SECRET, 3600)));
});
