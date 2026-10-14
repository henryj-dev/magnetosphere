// M4 Red 뼈대: 형태만 둔다. 구현은 다음 커밋이다.
import { Hono } from "hono";
import type { Services } from "../app.ts";

export const MEMBER_LIST_LIMIT = 50;
export const MEMBER_ADMIN_LIMIT = { max: 30, windowMs: 60_000 } as const;

interface ListedUser {
  id: string;
  name: string | null;
  email: string | null;
  role: string;
  status: string;
  emailVerified: boolean;
  isBootstrapAdmin: boolean;
  createdAt: string;
}

export function memberListView(_row: any): ListedUser {
  throw new Error("M4 미구현");
}

export async function syncTargetKeys(_s: Services, _userId: string, _now: Date): Promise<"synced" | "pending" | "none"> {
  throw new Error("M4 미구현");
}

export function memberAdminRoutes(_services: () => Promise<Services>) {
  const r = new Hono();
  r.all("*", () => {
    throw new Error("M4 미구현");
  });
  return r;
}
