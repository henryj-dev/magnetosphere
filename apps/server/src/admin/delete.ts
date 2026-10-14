// M4 Red 뼈대: 형태만 둔다. 구현은 다음 커밋이다.
import type { Services } from "../app.ts";
import { MemberConflictError, type MemberSelfProof } from "./guard-sql.ts";

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

export async function deleteMember(_s: Services, _input: DeleteMemberInput): Promise<DeleteMemberResult> {
  throw new Error("M4 미구현");
}

export { MemberConflictError };
