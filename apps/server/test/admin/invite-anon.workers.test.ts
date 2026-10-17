// TC-M6.T5.a 회원 삭제의 초대 정리, 실제 D1 batch 판 (M6 후속 U1).
//   pnpm -C apps/server test:workers test/admin/invite-anon.workers.test.ts -t "TC-M6.T5.a D1"
// 빈 로컬 D1 에 마이그레이션(0006 포함)을 적용하고 invite-anon-wrangler.jsonc 의 시험 Worker 를 띄운다. afterAll 이 내리고 지운다.
// 같은 단언의 Node DB 넷 판은 invite-anon.db.test.ts 다.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWranglerDev, wrangler, type WranglerDev } from "../wrangler-dev.mjs";

const CONFIG = "test/admin/invite-anon-wrangler.jsonc";
let base = "";
let persistTo: string | undefined;
let worker: WranglerDev | undefined;

interface Side { invites: Record<string, unknown>; member: Record<string, unknown> }
interface Report { error: string | null; faultSeen: boolean; seeded: Side; before: Side; after: Side; expected: Side }

async function probe(kind: "delete" | "fault"): Promise<Report> {
  const response = await fetch(`${base}/__test/invite-anon?case=${kind}`, { method: "POST" });
  const body = (await response.json()) as Report & { error?: string };
  if (response.status !== 200) throw new Error(`D1 fixture 준비 실패 (${response.status}): ${body.error ?? "시험 Worker 응답이 아니다"}`);
  return body;
}

describe("TC-M6.T5.a 실제 D1 초대 정리", () => {
  beforeAll(async () => {
    persistTo = mkdtempSync(path.join(tmpdir(), "mg-invite-anon-d1-"));
    try {
      const mig = wrangler(["d1", "migrations", "apply", "DB", "--local", "--config", CONFIG, "--persist-to", persistTo]);
      if (mig.code !== 0) throw new Error(`D1 fixture 준비 실패: 마이그레이션\n${mig.out}${mig.err}`);
      worker = await startWranglerDev({ config: CONFIG, persistTo, vars: {} });
      base = worker.baseUrl;
    } catch (e) {
      try {
        await worker?.close();
      } catch {
        // 준비 실패 e 를 가리지 않는다
      } finally {
        worker = undefined;
        rmSync(persistTo, { recursive: true, force: true });
        persistTo = undefined;
      }
      throw e;
    }
  });
  afterAll(async () => {
    await worker?.close();
    if (persistTo) rmSync(persistTo, { recursive: true, force: true });
  });

  it("TC-M6.T5.a D1: 삭제 batch 는 수락한 초대 email 을 익명화하고 삭제 전 이메일의 미사용 초대만 철회한다", async () => {
    const r = await probe("delete");
    expect(r.before).toEqual(r.seeded);
    expect(r.error).toBeNull();
    expect(r.faultSeen).toBe(false);
    expect(r.after).toEqual(r.expected);
  });

  it("TC-M6.T5.a D1: 초대 익명화 UPDATE 가 실패하면 batch 전체가 되돌려진다", async () => {
    const r = await probe("fault");
    expect(r.before).toEqual(r.seeded);
    expect(r.faultSeen).toBe(true); // trigger 가 실제로 batch 안에서 실패했다
    expect(r.error).toBe("stale_member");
    // 철회 UPDATE·user 익명화·세션 폐기·감사가 하나도 남지 않는다
    expect(r.after).toEqual(r.seeded);
  });
});
