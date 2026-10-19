// TC-M4.T1.db 회원 관리 뮤텍스·CAS, TC-M4.T1.c 승인·거절 경쟁, TC-M4.T1.d 서로 강등·정지 경쟁. 이 파일은 작성만 승인됐고 실행하지 않는다.
// exact DB 이름·생성/삭제 가드·RUN/HEAD/SHA/EXIT 승인은 실행 전에 별도로 받아야 한다.
// MySQL/MariaDB 는 mutex + PK 잠금 count, PG 는 mutex + READ COMMITTED count,
// SQLite 는 직렬 transaction 으로 마지막 관리자 판정을 CAS 까지 보호한다. D1 은 members.workers.test.ts 의 단일 CAS count guard 로 검증한다.
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../../../../packages/runtime/test/dbs.ts";
import { addActiveFactor } from "../../../../packages/auth/test/mfa-fixture.ts";
import { MEMBER_MUTEX, MemberConflictError, mutateMember, type MemberMutation } from "../../src/admin/guard-sql.ts";
import { TEST_ENCRYPTION_KEY } from "../helpers.ts";

const NOW = new Date("2026-10-13T00:00:00.000Z");
// 실패 출력에 세션 token·비밀번호 해시·재설정 identifier 원문이 찍히지 않게, 그 칸은 같음 비교만 되는 해시로 바꿔 둔다.
const SECRET_FIELDS = ["token", "password", "accessToken", "refreshToken", "idToken", "identifier"];
const masked = (list: any[]) => list.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, SECRET_FIELDS.includes(key) && value != null ? createHash("sha256").update(String(value)).digest("hex") : value])));

describe.each(enabledDbs())("%s", (kind: DbKind) => {
  let t: TestDb;
  let h: DbHandle;
  let peer: DbHandle;
  beforeEach(async () => {
    t = await createTestDb(kind);
    h = await connectNode(t.url);
    peer = await connectNode(t.url);
    if (!h.schema.user.authVersion || !h.schema.session.authVersion) throw new Error("M4 DB fixture 준비 실패: authVersion 생성 스키마가 없다");
  });
  afterEach(async () => {
    await peer?.close();
    await h?.close();
    await t?.drop();
  });

  const add = async (role: "member" | "admin", status = "active") => {
    const id = randomUUID();
    await h.db.insert(h.schema.user).values({ id, name: "fixture", email: `${id}@example.com`, emailVerified: true, role, status, isBootstrapAdmin: false, authVersion: 0, createdAt: NOW, updatedAt: NOW });
    // 활성 관리자는 관리자 MFA 를 등록한 관리자다 (A1: 마지막 관리자 판정은 active factor 가 있는 활성 관리자 수)
    if (role === "admin" && status === "active") await addActiveFactor(h.db, h.schema, id, TEST_ENCRYPTION_KEY);
    return id;
  };
  const session = async (userId: string) => {
    const id = randomUUID();
    const expiresAt = new Date(NOW.getTime() + 60_000);
    await h.db.insert(h.schema.session).values({ id, expiresAt, token: randomUUID(), createdAt: NOW, updatedAt: NOW, userId, authVersion: 0 });
    const [row] = await h.db.select({ id: h.schema.session.id, userId: h.schema.session.userId, authVersion: h.schema.session.authVersion, expiresAt: h.schema.session.expiresAt }).from(h.schema.session).where(eq(h.schema.session.id, id));
    expect(row).toEqual({ id, userId, authVersion: 0, expiresAt });
    expect(id).not.toBe(userId); // 세션 id 를 회원 id 로 대신하지 않는 실제 DB fixture 다.
    return id;
  };
  const request = (actorId: string, actorSessionId: string, targetId: string, action: MemberMutation["action"], role?: "member" | "admin"): MemberMutation => ({
    actorId, actorSessionId, targetId, action, role, now: NOW,
    audit: { actorId, action: action === "role" ? "member.role" : `member.${action}`, target: targetId, detail: { probe: true }, ip: null, now: NOW },
  });
  const capture = async (ids: string[]) => ({
    users: await h.db.select().from(h.schema.user).where(inArray(h.schema.user.id, ids)).orderBy(asc(h.schema.user.id)),
    sessions: masked(await h.db.select().from(h.schema.session).where(inArray(h.schema.session.userId, ids)).orderBy(asc(h.schema.session.id))),
    audits: await h.db.select().from(h.schema.auditLog).where(inArray(h.schema.auditLog.target, ids)).orderBy(asc(h.schema.auditLog.id)),
  });

  // beforeEach 가 회마다 새 DB 를 만들므로 다른 회차의 회원·세션·감사·관리자 수가 섞이지 않는다.
  it.each(Array.from({ length: 20 }, (_, round) => round))(`TC-M4.T1.db ${LABEL[kind]}: 상호 강등·정지 경쟁 %i 회는 변경·감사가 정확히 하나다`, async (round) => {
      const a = await add("admin");
      const b = await add("admin");
      const sa = await session(a);
      const sb = await session(b);
      const initial = await capture([a, b]);
      expect(initial.users.map((u: any) => ({ role: u.role, status: u.status, bootstrap: u.isBootstrapAdmin, version: u.authVersion }))).toEqual([
        { role: "admin", status: "active", bootstrap: false, version: 0 },
        { role: "admin", status: "active", bootstrap: false, version: 0 },
      ]);
      expect(initial.sessions).toHaveLength(2);
      expect(initial.audits).toHaveLength(0);
      const ab = request(a, sa, b, "role", "member");
      const ba = request(b, sb, a, "suspend");
      // 연결 두 개의 실제 transaction 이 같은 mutex 를 놓고 경쟁한다. 요청 순서도 교대로 바꾼다.
      const inputs = round % 2 ? [ba, ab] : [ab, ba];
      const settled = await Promise.allSettled(inputs.map((input, i) => mutateMember(i ? peer : h, input)));
      const winner = settled.findIndex((result) => result.status === "fulfilled");
      expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
      const lost = settled[1 - winner] as PromiseRejectedResult;
      expect(lost.reason).toBeInstanceOf(MemberConflictError);
      // 먼저 권한을 잃은 actor 는 last_admin409 대신 401/403 계약으로 끝난다.
      expect(["unauthorized", "forbidden"]).toContain(lost.reason.code);
      const winning = inputs[winner];
      const final = await capture([a, b]);
      const admins = final.users.filter((u: any) => u.role === "admin" && u.status === "active");
      expect(admins).toHaveLength(1);
      expect(admins[0].id).toBe(winning.actorId);
      expect(admins[0]).toEqual(initial.users.find((u: any) => u.id === winning.actorId));
      const modified = final.users.filter((u: any) => u.authVersion !== 0);
      expect(modified).toHaveLength(1);
      expect(modified[0].id).toBe(winning.targetId);
      expect(modified[0].authVersion).toBe(1);
      expect(modified[0].role).toBe(winning.action === "role" ? "member" : "admin");
      expect(modified[0].status).toBe(winning.action === "suspend" ? "suspended" : "active");
      expect(final.sessions).toHaveLength(1);
      expect(final.sessions[0].userId).toBe(winning.actorId);
      expect(final.sessions[0].authVersion).toBe(0);
      expect(final.sessions[0]).toEqual(initial.sessions.find((s: any) => s.userId === winning.actorId));
      expect(final.audits).toHaveLength(modified.length);
      expect(final.audits[0].actorId).toBe(winning.actorId);
      expect(final.audits[0].target).toBe(winning.targetId);
      expect(final.audits[0].action).toBe(winning.audit.action);

    if (kind !== "sqlite") {
      const [mutex] = await h.db.select().from(h.schema.jobLeases).where(eq(h.schema.jobLeases.name, MEMBER_MUTEX.name));
      expect(mutex?.holder).toBe(MEMBER_MUTEX.holder);
      expect(new Date(mutex.lockedUntil).toISOString()).toBe(MEMBER_MUTEX.lockedUntil.toISOString());
    }
  }, 120_000);

  // TC-M4.T1.c: 서로 다른 두 관리자가 같은 pending 회원을 동시에 승인·거절한다. 요청 순서는 회마다 바꾼다.
  it.each(Array.from({ length: 10 }, (_, round) => round))(`TC-M4.T1.c ${LABEL[kind]}: pending 회원 승인·거절 동시 경쟁 %i 회는 하나만 성공하고 최종 행·감사가 승자와 맞다`, async (round) => {
    const a = await add("admin");
    const b = await add("admin");
    const sa = await session(a);
    const sb = await session(b);
    const target = await add("member", "pending");
    const targetSid = await session(target);
    const account = randomUUID();
    const verification = randomUUID();
    await h.db.insert(h.schema.account).values({ id: account, accountId: target, providerId: "credential", userId: target, createdAt: NOW, updatedAt: NOW });
    await h.db.insert(h.schema.verification).values({ id: verification, identifier: `reset-password:${verification}`, value: target, expiresAt: new Date(NOW.getTime() + 60_000), createdAt: NOW, updatedAt: NOW });
    const owned = async () => ({
      accounts: masked(await h.db.select().from(h.schema.account).where(eq(h.schema.account.userId, target))),
      verifications: masked(await h.db.select().from(h.schema.verification).where(eq(h.schema.verification.id, verification))),
    });
    const initial = await capture([a, b, target]);
    const initialOwned = await owned();
    expect(initial.users.find((u: any) => u.id === target)).toMatchObject({ role: "member", status: "pending", authVersion: 0 });
    expect(initial.sessions.map((s: any) => s.id).sort()).toEqual([sa, sb, targetSid].sort());
    expect(initialOwned.accounts).toHaveLength(1);
    expect(initialOwned.verifications).toHaveLength(1);
    expect(initial.audits).toHaveLength(0);
    const approve = request(a, sa, target, "approve");
    const reject = request(b, sb, target, "reject");
    const inputs = round % 2 ? [reject, approve] : [approve, reject];
    const settled = await Promise.allSettled(inputs.map((input, i) => mutateMember(i ? peer : h, input)));
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = settled.findIndex((result) => result.status === "fulfilled");
    const winning = inputs[winner];
    const lost = settled[1 - winner] as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(MemberConflictError);
    // Node 네 DB 는 mutex(SQLite 는 쓰기 transaction)로 직렬이라 진 쪽은 승자 커밋 뒤의 행을 읽는다.
    // 승인 뒤 거절은 active 에서 전이 불가(409 invalid_transition), 거절 뒤 승인은 대상 행 없음(not_found, 라우트 404)이다.
    expect(lost.reason.code).toBe(winning.action === "approve" ? "invalid_transition" : "not_found");
    const final = await capture([a, b, target]);
    const finalOwned = await owned();
    // 두 관리자 행·세션은 어느 쪽이 이겨도 그대로다.
    for (const id of [a, b]) expect(final.users.find((u: any) => u.id === id)).toEqual(initial.users.find((u: any) => u.id === id));
    expect(final.sessions).toEqual(initial.sessions.filter((s: any) => s.userId !== target));
    if (winning.action === "approve") {
      expect(final.users.find((u: any) => u.id === target)).toMatchObject({ role: "member", status: "active", authVersion: 1 });
      expect(finalOwned).toEqual(initialOwned);
    } else {
      expect(final.users.find((u: any) => u.id === target)).toBeUndefined();
      expect(finalOwned.accounts).toHaveLength(0);
      expect(finalOwned.verifications).toHaveLength(0);
    }
    // 거절로 지운 행에 승인이 다시 쓰거나(행 0 갱신을 성공으로 봄) 감사가 둘 남지 않는다.
    expect(final.audits.map((e: any) => ({ actorId: e.actorId, action: e.action, target: e.target }))).toEqual([{ actorId: winning.actorId, action: winning.audit.action, target }]);
  }, 120_000);

  // TC-M4.T1.d: 최초 관리자가 아닌 활성 관리자 둘이 서로를 같은 동작으로 동시에 강등·정지한다. 문서 횟수대로 각 20 회다.
  const mutual = async (round: number, action: "role" | "suspend") => {
    const a = await add("admin");
    const b = await add("admin");
    const sa = await session(a);
    const sb = await session(b);
    const initial = await capture([a, b]);
    expect(initial.users.map((u: any) => ({ role: u.role, status: u.status, bootstrap: u.isBootstrapAdmin, version: u.authVersion }))).toEqual([
      { role: "admin", status: "active", bootstrap: false, version: 0 },
      { role: "admin", status: "active", bootstrap: false, version: 0 },
    ]);
    expect(initial.sessions).toHaveLength(2);
    expect(initial.audits).toHaveLength(0);
    const ab = request(a, sa, b, action, action === "role" ? "member" : undefined);
    const ba = request(b, sb, a, action, action === "role" ? "member" : undefined);
    const inputs = round % 2 ? [ba, ab] : [ab, ba];
    const settled = await Promise.allSettled(inputs.map((input, i) => mutateMember(i ? peer : h, input)));
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = settled.findIndex((result) => result.status === "fulfilled");
    const winning = inputs[winner];
    const lost = settled[1 - winner] as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(MemberConflictError);
    // 직렬로 뒤에 선 쪽은 이미 강등·정지된 actor 라 requireActor 가 관리자 수 판정보다 먼저 403 forbidden 으로 막는다.
    expect(lost.reason.code).toBe("forbidden");
    const final = await capture([a, b]);
    const admins = await h.db.select({ id: h.schema.user.id }).from(h.schema.user).where(and(eq(h.schema.user.role, "admin"), eq(h.schema.user.status, "active")));
    expect(admins).toEqual([{ id: winning.actorId }]);
    expect(final.users.find((u: any) => u.id === winning.actorId)).toEqual(initial.users.find((u: any) => u.id === winning.actorId));
    expect(final.users.find((u: any) => u.id === winning.targetId)).toMatchObject({
      role: action === "role" ? "member" : "admin",
      status: action === "suspend" ? "suspended" : "active",
      authVersion: 1,
    });
    expect(final.sessions).toEqual(initial.sessions.filter((s: any) => s.userId === winning.actorId));
    expect(final.audits.map((e: any) => ({ actorId: e.actorId, action: e.action, target: e.target }))).toEqual([{ actorId: winning.actorId, action: winning.audit.action, target: winning.targetId }]);
  };
  it.each(Array.from({ length: 20 }, (_, round) => round))(`TC-M4.T1.d ${LABEL[kind]}: 서로 동시 강등 %i 회는 활성 관리자 하나와 승자 감사 하나만 남긴다`, (round) => mutual(round, "role"), 120_000);
  it.each(Array.from({ length: 20 }, (_, round) => round))(`TC-M4.T1.d ${LABEL[kind]}: 서로 동시 정지 %i 회는 활성 관리자 하나와 승자 감사 하나만 남긴다`, (round) => mutual(round, "suspend"), 120_000);

  it(`TC-M4.T1.db ${LABEL[kind]}: 유효 actor 가 마지막 관리자를 제거하려면 last_admin409로 아무것도 쓰지 않는다`, async () => {
    const actor = await add("admin");
    const sid = await session(actor);
    const before = await capture([actor]);
    expect(before.users[0]).toMatchObject({ role: "admin", status: "active", authVersion: 0, isBootstrapAdmin: false });
    expect(before.sessions).toHaveLength(1);
    expect(before.audits).toHaveLength(0);
    // 자기 정지·강등은 self 로 막히므로 기존 delete primitive 의 보호 조건만 확인한다. T2 라우트/익명화는 구현하지 않는다.
    await expect(mutateMember(h, request(actor, sid, actor, "delete"))).rejects.toMatchObject({ code: "last_admin" });
    expect(await capture([actor])).toEqual(before);
  });

  it.each(["session", "version", "status"] as const)(`TC-M4.T1.db ${LABEL[kind]}: 요청 관찰 뒤 %s 상실은 transaction 안 재검증에서 CAS 전에 막힌다`, async (fault) => {
    const actor = await add("admin");
    const sid = await session(actor);
    const control = await add("member", "pending");
    const controlSid = await session(control);
    // 같은 유효 actor/session 입력의 양성 대조: 실제 primitive 가 version 증가·감사·세션 폐기를 한다.
    await mutateMember(h, request(actor, sid, control, "approve"));
    const controlAfter = await capture([control]);
    expect(controlAfter.users[0].status).toBe("active");
    expect(controlAfter.users[0].authVersion).toBe(1);
    expect(controlAfter.sessions).toHaveLength(0);
    expect(controlAfter.audits).toHaveLength(1);
    expect(controlAfter.audits[0].action).toBe("member.approve");
    expect(controlSid).not.toBe(sid);

    const target = await add("member", "pending");
    await session(target);
    const input = request(actor, sid, target, "approve");
    const observed = await capture([actor, target]);
    expect(observed.users.find((u: any) => u.id === actor)).toMatchObject({ role: "admin", status: "active", authVersion: 0, isBootstrapAdmin: false });
    expect(observed.sessions.find((s: any) => s.id === sid)).toMatchObject({ userId: actor, authVersion: 0 });
    let expected = observed;
    let transactionReached = false;
    let casReached = false;
    // 시험 연결만 감싼다. 운영 primitive 에 hook 을 넣거나 actor 값을 가짜로 반환하지 않는다.
    const db = new Proxy(h.db, {
      get(real, key) {
        if (key === "transaction") return async (body: (tx: any) => Promise<unknown>, config?: unknown) => {
          transactionReached = true;
          if (fault === "session") await peer.db.delete(peer.schema.session).where(eq(peer.schema.session.id, sid));
          if (fault === "version") await peer.db.update(peer.schema.user).set({ authVersion: 1 }).where(eq(peer.schema.user.id, actor));
          if (fault === "status") await peer.db.update(peer.schema.user).set({ status: "suspended" }).where(eq(peer.schema.user.id, actor));
          expected = await capture([actor, target]);
          return real.transaction((tx: any) => body(new Proxy(tx, {
            get(transaction, operation) {
              if (operation === "update") return (...args: any[]) => { casReached = true; return transaction.update(...args); };
              const value = Reflect.get(transaction, operation, transaction);
              return typeof value === "function" ? value.bind(transaction) : value;
            },
          })), config);
        };
        const value = Reflect.get(real, key, real);
        return typeof value === "function" ? value.bind(real) : value;
      },
    });
    await expect(mutateMember({ ...h, db }, input)).rejects.toMatchObject({ code: fault === "session" ? "unauthorized" : "forbidden" });
    expect(transactionReached).toBe(true);
    expect(casReached).toBe(false); // actor 재검증을 지우고 CAS 로 미루면 이 단언이 실패한다.
    expect(await capture([actor, target])).toEqual(expected);
    expect(expected.users.find((u: any) => u.id === target)).toMatchObject({ status: "pending", authVersion: 0 });
    expect(expected.sessions.filter((s: any) => s.userId === target)).toHaveLength(1);
    expect(expected.audits).toHaveLength(0);
    const targetAudits = await h.db.select().from(h.schema.auditLog).where(and(eq(h.schema.auditLog.target, target), eq(h.schema.auditLog.action, "member.approve")));
    expect(targetAudits).toHaveLength(0);
  });
});
