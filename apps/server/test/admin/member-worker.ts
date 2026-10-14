// TC-M4.T1.d1 전용 Worker. 운영 앱에 연결하지 않는다.
// DB·생성 스키마·로컬 wrangler 실행 승인은 별도다. 시험 장치는 이 파일 안의 Proxy·trigger 에만 둔다.
import { eq } from "drizzle-orm";
import { connectWorkers, type WorkersEnv } from "@magnetosphere/runtime/workers";
import { AUTH_VERSION_MAX, MemberConflictError, mutateMember, type MemberMutation } from "../../src/admin/guard-sql.ts";

export default {
  async fetch(req: Request, env: WorkersEnv): Promise<Response> {
    if (new URL(req.url).pathname !== "/__test/member-rollback" || req.method !== "POST") return new Response("not found", { status: 404 });
    if (!env.DB) return Response.json({ error: "D1 fixture 바인딩이 없다" }, { status: 503 });
    const binding = env.DB as any;
    let nativeError = "";
    let directChanges: number | null = null;
    const observedBinding = new Proxy(binding, {
      get(db, key) {
        if (key === "batch") return async (statements: any[]) => {
          try {
            const results = await db.batch(statements);
            directChanges = results[0]?.meta?.changes ?? null;
            return results;
          } catch (e) {
            const messages: string[] = [];
            for (let cause: any = e, depth = 0; cause && depth < 8; cause = cause.cause, depth++) messages.push(String(cause.message ?? ""));
            nativeError = messages.join(" ");
            throw e;
          }
        };
        const value = Reflect.get(db, key, db);
        return typeof value === "function" ? value.bind(db) : value;
      },
    });
    const h = await connectWorkers({ ...env, DB: observedBinding });
    // 미생성 스키마로 version set 이 무시되는 상태를 시험 성공으로 가장하지 않는다.
    if (!h.schema.user.authVersion || !h.schema.session.authVersion) return Response.json({ error: "authVersion 생성 스키마가 아직 준비되지 않았다" }, { status: 503 });
    const now = new Date("2026-10-13T00:00:00.000Z");
    const reports: Record<string, unknown> = {};

    for (const scenario of ["zeroCas", "cleanupFault", "rejectCascade", "actorRole", "actorVersion", "actorSession", "lastAdmin", "lastAdminRace", "versionMax", "versionRace"] as const) {
      const actor = crypto.randomUUID();
      const target = scenario === "lastAdmin" || scenario === "lastAdminRace" ? actor : crypto.randomUUID();
      const extraAdmin = crypto.randomUUID();
      const session = crypto.randomUUID();
      const targetSession = crypto.randomUUID();
      const account = crypto.randomUUID();
      const verification = crypto.randomUUID();
      const reject = scenario === "zeroCas" || scenario === "cleanupFault" || scenario === "rejectCascade";
      // 자기 정지·강등은 전이 검사에서 막힌다. 삭제의 보호 조건만 primitive 에서 확인하고 T2 라우트는 만들지 않는다.
      const removesAdmin = scenario === "lastAdmin" || scenario === "lastAdminRace";
      await h.db.insert(h.schema.user).values([
        { id: actor, name: "actor", email: `${actor}@example.com`, emailVerified: true, role: "admin", status: "active", authVersion: 0, createdAt: now, updatedAt: now },
        ...(removesAdmin ? [] : [{ id: target, name: "target", email: `${target}@example.com`, emailVerified: false, role: "member", status: "pending", authVersion: scenario === "versionMax" ? AUTH_VERSION_MAX : 0, createdAt: now, updatedAt: now }]),
      ]);
      if (scenario === "lastAdminRace") await h.db.insert(h.schema.user).values({ id: extraAdmin, name: "extra", email: `${extraAdmin}@example.com`, emailVerified: true, role: "admin", status: "active", authVersion: 0, createdAt: now, updatedAt: now });
      await h.db.insert(h.schema.session).values([
        { id: session, expiresAt: new Date(now.getTime() + 60_000), token: crypto.randomUUID(), createdAt: now, updatedAt: now, userId: actor, authVersion: 0 },
        { id: targetSession, expiresAt: new Date(now.getTime() + 60_000), token: crypto.randomUUID(), createdAt: now, updatedAt: now, userId: target, authVersion: scenario === "versionMax" ? AUTH_VERSION_MAX : 0 },
      ]);
      await h.db.insert(h.schema.account).values({ id: account, accountId: target, providerId: "credential", userId: target, createdAt: now, updatedAt: now });
      await h.db.insert(h.schema.verification).values({ id: verification, identifier: `reset-password:${verification}`, value: target, expiresAt: now, createdAt: now, updatedAt: now });
      const capture = async () => ({
        user: await h.db.select().from(h.schema.user).where(eq(h.schema.user.id, target)),
        actor: await h.db.select().from(h.schema.user).where(eq(h.schema.user.id, actor)),
        account: await h.db.select().from(h.schema.account).where(eq(h.schema.account.id, account)),
        session: await h.db.select().from(h.schema.session).where(eq(h.schema.session.userId, target)),
        actorSession: await h.db.select().from(h.schema.session).where(eq(h.schema.session.id, session)),
        verification: await h.db.select().from(h.schema.verification).where(eq(h.schema.verification.id, verification)),
        audit: await h.db.select().from(h.schema.auditLog).where(eq(h.schema.auditLog.target, target)),
      });
      type Captured = Awaited<ReturnType<typeof capture>>;
      // 전체 행은 Worker 안에서 비교한다. 세션 token 등은 응답으로 내보내지 않는다.
      const safe = (rows: Captured) => ({
        user: rows.user.map((r: any) => ({ id: r.id, status: r.status, role: r.role, authVersion: r.authVersion })),
        actor: rows.actor.map((r: any) => ({ id: r.id, status: r.status, role: r.role, authVersion: r.authVersion })),
        account: rows.account.map((r: any) => ({ id: r.id, userId: r.userId })),
        session: rows.session.map((r: any) => ({ id: r.id, userId: r.userId, authVersion: r.authVersion })),
        actorSession: rows.actorSession.map((r: any) => ({ id: r.id, userId: r.userId, authVersion: r.authVersion })),
        verification: rows.verification.map((r: any) => ({ id: r.id })),
        audit: rows.audit.map((r: any) => ({ id: r.id, action: r.action, target: r.target })),
      });
      const input: MemberMutation = { action: reject ? "reject" : removesAdmin ? "delete" : "approve", actorId: actor, actorSessionId: session, targetId: target, now, audit: { actorId: actor, action: reject ? "member.reject" : removesAdmin ? "member.delete" : "member.approve", target, detail: { probe: true }, ip: null, now } };
      let expected = await capture();
      let batchReached = false;
      nativeError = "";
      directChanges = null;
      const wrapped = new Proxy(h.db, {
        get(db, key) {
          if (key === "batch") return async (statements: any[]) => {
            batchReached = true;
            // 운영 primitive 의 snapshot·권한 읽기 뒤, 실제 CAS batch 직전에 경쟁 요청을 커밋한다.
            if (scenario === "zeroCas" || scenario === "versionRace") await db.update(h.schema.user).set({ authVersion: scenario === "versionRace" ? AUTH_VERSION_MAX : 1 }).where(eq(h.schema.user.id, target));
            if (scenario === "actorRole") await db.update(h.schema.user).set({ role: "member", authVersion: 1 }).where(eq(h.schema.user.id, actor));
            if (scenario === "actorVersion") await db.update(h.schema.user).set({ authVersion: 1 }).where(eq(h.schema.user.id, actor));
            if (scenario === "actorSession") await db.delete(h.schema.session).where(eq(h.schema.session.id, session));
            if (scenario === "lastAdminRace") await db.delete(h.schema.user).where(eq(h.schema.user.id, extraAdmin));
            expected = await capture();
            return db.batch(statements);
          };
          const value = Reflect.get(db, key, db);
          return typeof value === "function" ? value.bind(db) : value;
        },
      });
      const triggerName = `member_cleanup_${verification.replaceAll("-", "")}`;
      if (scenario === "cleanupFault") {
        // CAS 가 DELETE 1행이고 cascade·감사가 이미 실행된 뒤 verification 정리만 실패시킨다.
        await binding.prepare(`CREATE TRIGGER "${triggerName}" BEFORE DELETE ON verification WHEN OLD.id = '${verification}' BEGIN
          SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM user WHERE id = '${target}')
            AND NOT EXISTS (SELECT 1 FROM account WHERE user_id = '${target}')
            AND NOT EXISTS (SELECT 1 FROM session WHERE user_id = '${target}')
            AND EXISTS (SELECT 1 FROM audit_log WHERE target = '${target}' AND action = 'member.reject')
            THEN RAISE(ABORT, 'member_cleanup_after_cas_and_audit') ELSE RAISE(ABORT, 'member_cleanup_wrong_boundary') END;
          END`).run();
      }
      let error: string | null = null;
      try {
        await mutateMember({ ...h, db: wrapped }, input);
      } catch (e) {
        error = e instanceof MemberConflictError ? e.code : "unexpected_error";
      } finally {
        if (scenario === "cleanupFault") await binding.prepare(`DROP TRIGGER "${triggerName}"`).run();
      }
      const after = await capture();
      reports[scenario] = {
        error, batchReached, directChanges,
        guardFailed: /NOT NULL constraint failed: audit_log\.action/.test(nativeError),
        cleanupBoundary: nativeError.includes("member_cleanup_after_cas_and_audit"),
        wholeRowsUnchanged: JSON.stringify(expected) === JSON.stringify(after),
        before: safe(expected), after: safe(after),
      };
      // 이후 사례의 활성 관리자 수에 이 fixture 가 섞이지 않게 정리한다.
      await h.db.delete(h.schema.user).where(eq(h.schema.user.id, target));
      await h.db.delete(h.schema.user).where(eq(h.schema.user.id, actor));
      if (scenario === "lastAdminRace") await h.db.delete(h.schema.user).where(eq(h.schema.user.id, extraAdmin));
      await h.db.delete(h.schema.verification).where(eq(h.schema.verification.id, verification));
      await h.db.delete(h.schema.auditLog).where(eq(h.schema.auditLog.target, target));
    }
    return Response.json(reports);
  },
};
