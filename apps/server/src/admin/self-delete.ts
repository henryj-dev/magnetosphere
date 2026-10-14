// M4 Red 뼈대: 형태만 둔다. 구현은 다음 커밋이다.
import { Hono } from "hono";
import type { Services } from "../app.ts";

export const SELF_DELETE_LIMIT = { max: 5, windowMs: 60_000 } as const;

export function selfDeleteRoutes(_services: () => Promise<Services>) {
  const r = new Hono();
  r.all("*", () => {
    throw new Error("M4 미구현");
  });
  return r;
}
