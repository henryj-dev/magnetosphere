// TC-M4.T1.db 회원 관리 뮤텍스·CAS. 이 파일은 작성만 승인됐고 실행하지 않는다.
// exact DB 이름·생성/삭제 가드·RUN/HEAD/SHA/EXIT 승인은 실행 전에 별도로 받아야 한다.
// MySQL/MariaDB 는 mutex + PK 잠금 count, PG 는 mutex + READ COMMITTED count,
// SQLite 는 직렬 transaction 으로 마지막 관리자 판정을 CAS 까지 보호한다. D1 은 members.workers.test.ts 의 단일 CAS count guard 로 검증한다.
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../../../../packages/runtime/test/dbs.ts";
import { MEMBER_MUTEX, MemberConflictError, mutateMember, type MemberMutation } from "../../src/admin/guard-sql.ts";

const NOW = new Date("2026-10-13T00:00:00.000Z");

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
    sessions: await h.db.select().from(h.schema.session).where(inArray(h.schema.session.userId, ids)).orderBy(asc(h.schema.session.id)),
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
