// M4 Red 뼈대: 형태만 둔다. 구현은 다음 커밋이다.
import type { DbHandle } from "@magnetosphere/runtime/types";

export function revokeSessionsStatement(_h: DbHandle, _db: any, _userId: string): any {
  throw new Error("M4 미구현");
}

export async function revokeSessions(_h: DbHandle, _userId: string): Promise<void> {
  throw new Error("M4 미구현");
}
