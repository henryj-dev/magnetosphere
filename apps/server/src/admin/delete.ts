// 관리자 회원 삭제·자기 탈퇴 공용 서비스 (3단계 실행판 M4.T2·T4).
// user id·비용 매핑은 남기고 개인정보를 익명화한다. account·session·소유 verification 정리는 guard-sql 의 같은 원자 단위다.
// 키 disable·120초 삭제 큐는 DB 커밋 뒤에만 기존 K3 applyKey 로 맡긴다. 외부 실패는 pending 이며 익명화를 되돌리지 않는다.
import type { Services } from "../app.ts";
import { MemberConflictError, mutateMember, type MemberSelfProof } from "./guard-sql.ts";
import { syncTargetKeys } from "./members.ts";

export interface DeleteMemberInput {
  actorId: string;
  actorSessionId: string;
  targetId: string;
  selfProof?: MemberSelfProof;
  ip: string | null;
  now: Date;
}

export interface DeleteMemberResult {
  deleted: true;
  sync: "synced" | "pending" | "none";
}

/** active·suspended 회원을 익명화한다. 알려진 충돌은 MemberConflictError, 그 외 저장 오류는 호출자가 고정 오류로 가린다 */
export async function deleteMember(s: Services, input: DeleteMemberInput): Promise<DeleteMemberResult> {
  await mutateMember(s.db, {
    action: "delete",
    actorId: input.actorId,
    actorSessionId: input.actorSessionId,
    targetId: input.targetId,
    selfProof: input.selfProof,
    now: input.now,
    audit: { actorId: input.actorId, action: "member.delete", target: input.targetId, detail: { anonymized: true }, ip: input.ip, now: input.now },
  });
  return { deleted: true, sync: await syncTargetKeys(s, input.targetId, input.now) };
}

export { MemberConflictError };
