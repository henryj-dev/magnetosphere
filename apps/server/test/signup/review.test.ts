// 가입 정책 (M2) 보안 리뷰 고침 — 서버 앱 전체, SQLite 파일 DB (pnpm test). 준비는 policy.test.ts 와 같다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attempt, body, mail } from "../../../../packages/auth/test/signup-policy/rig.ts";
import { makeTestEnv, type TestEnv } from "../helpers.ts";
import { installed } from "./checks.ts";
import { serverRig, type ServerRig } from "./env.ts";

let t: TestEnv;
let rig: ServerRig;
beforeEach(async () => {
  t = await makeTestEnv();
  rig = await serverRig("SQLite", { url: t.env.DATABASE_URL });
  await installed(rig);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rig?.close();
  t?.cleanup();
});

const mode = (m: string) => rig.op("setSetting", "signup_mode", m);

describe("TC-M2.T3 하루 가입 상한 (리뷰)", () => {
  it("TC-M2.T3.d 상한에 닿은 뒤의 공개 가입 거부는 rate_limit 에 쓰지 않는다 — 그날 첫 거부만 알림 칸 1행을 쓴다 (리뷰 M2)", async () => {
    await mode("open");
    await rig.op("setSetting", "daily_signup_cap", 0);
    await rig.op("newDay");
    // rate_limit 표에 나가는 쓰기 문장(insert·update·delete)을 센다
    const t0 = rig.h.schema.rateLimit;
    const writes: string[] = [];
    for (const m of ["insert", "update", "delete"] as const) {
      const original = (rig.h.db as any)[m].bind(rig.h.db);
      vi.spyOn(rig.h.db as any, m).mockImplementation((table: unknown, ...rest: unknown[]) => {
        if (table === t0) writes.push(m);
        return original(table, ...rest);
      });
    }
    const rows = () => rig.h.db.select().from(t0);

    // 대조: 그날 첫 거부는 알림 칸을 넣고 alert.signup_cap 1행
    const first = await attempt(rig, () => rig.signUp(body(mail("t3d-first"))));
    expect({ status: first.status, code: first.code, user: first.user }).toEqual({ status: 403, code: "signup_cap", user: 0 });
    expect(writes).toContain("insert");
    expect(await rig.op("audits", "alert.signup_cap")).toBe(1);
    const before = await rows();

    // 그 뒤 거부 20건(요청마다 다른 IP)은 rate_limit 에 문장을 하나도 보내지 않는다
    writes.length = 0;
    const denied = await Promise.all(Array.from({ length: 20 }, (_, i) => rig.signUp(body(mail(`t3d-${i}`)))));
    expect(denied.map((r) => [r.status, r.code])).toEqual(Array(20).fill([403, "signup_cap"]));
    expect(writes).toEqual([]);
    expect(await rows()).toEqual(before);
    expect(await rig.op("audits", "alert.signup_cap")).toBe(1);
  });
});
