// TC-M6.T5.a 실제 D1 batch 판 시험 Worker (invite-anon-wrangler.jsonc). 운영 앱에 연결하지 않는다. 진입 모듈이라 default 말고는 내보내지 않는다.
//   POST /__test/invite-anon?case=delete → 삭제 한 번 뒤 초대·회원 상태 (기대값도 같이 돌려준다)
//   POST /__test/invite-anon?case=fault  → 수락 초대 익명화 UPDATE 를 trigger 로 실패시킨 삭제 뒤 상태 (batch 전체 롤백을 본다)
// 응답에는 token_hash·세션 token 을 넣지 않는다.
import { connectWorkers, type WorkersEnv } from "@magnetosphere/runtime/workers";
import { MemberConflictError, mutateMember } from "../../src/admin/guard-sql.ts";
import { inviteAnonDelete, inviteAnonExpected, inviteAnonMember, inviteAnonMemberAfter, inviteAnonMemberBefore, inviteAnonRows, seedInviteAnon } from "./invite-anon-checks.ts";

const FAULT = "invite_cleanup_fault";

export default {
  async fetch(req: Request, env: WorkersEnv): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz" && req.method === "GET") return new Response("ok");
    if (url.pathname !== "/__test/invite-anon" || req.method !== "POST") return new Response("not found", { status: 404 });
    const kind = url.searchParams.get("case");
    if (kind !== "delete" && kind !== "fault") return Response.json({ error: "case 는 delete 또는 fault 다" }, { status: 400 });
    if (!env.DB) return Response.json({ error: "D1 fixture 바인딩이 없다" }, { status: 503 });
    const binding = env.DB as any;
    let nativeError = "";
    // batch 원인 메시지만 모은다. 결과를 바꾸지 않는다
    const observed = new Proxy(binding, {
      get(db, key) {
        if (key === "batch") return async (statements: any[]) => {
          try {
            return await db.batch(statements);
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
    const h = await connectWorkers({ ...env, DB: observed });
    if (h.kind !== "d1") return Response.json({ error: "D1 연결이 아니다" }, { status: 503 });
    if (!h.schema.user.authVersion || !h.schema.session.authVersion) return Response.json({ error: "authVersion 생성 스키마가 아직 준비되지 않았다" }, { status: 503 });
    const f = await seedInviteAnon(h);
    const seededRows = await inviteAnonRows(h, f);
    const seededMember = await inviteAnonMember(h, f);
    const trigger = `invite_anon_fault_${f.target.replaceAll("-", "")}`;
    if (kind === "fault") {
      // 철회 UPDATE·CAS·감사 guard·account/verification 정리가 batch 안에서 먼저 실행된 뒤, 수락 초대 익명화 UPDATE 만 실패시킨다
      await binding.prepare(`CREATE TRIGGER "${trigger}" BEFORE UPDATE OF email ON invites WHEN NEW.email = 'deleted-${f.target}@invalid' BEGIN SELECT RAISE(ABORT, '${FAULT}'); END`).run();
    }
    let error: string | null = null;
    try {
      await mutateMember(h, inviteAnonDelete(f));
    } catch (e) {
      error = e instanceof MemberConflictError ? e.code : "unexpected_error";
    } finally {
      if (kind === "fault") await binding.prepare(`DROP TRIGGER "${trigger}"`).run();
    }
    return Response.json({
      error,
      faultSeen: nativeError.includes(FAULT),
      seeded: { invites: f.seeded, member: inviteAnonMemberBefore(f) },
      before: { invites: seededRows, member: seededMember },
      after: { invites: await inviteAnonRows(h, f), member: await inviteAnonMember(h, f) },
      expected: { invites: inviteAnonExpected(f), member: inviteAnonMemberAfter(f) },
    });
  },
};
