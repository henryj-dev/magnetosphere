// TC-M4.T1.d1 실제 D1 batch 롤백. 실행 승인은 별도다.
// d1-rig.ts 처럼 빈 로컬 D1 에 마이그레이션을 적용하고 member-wrangler.jsonc 의 시험 Worker 를 직접 띄운다. afterAll 이 내리고 지운다.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWranglerDev, wrangler, type WranglerDev } from "../wrangler-dev.mjs";

const CONFIG = "test/admin/member-wrangler.jsonc";
let base = "";
let persistTo: string | undefined;
let worker: WranglerDev | undefined;
interface Snapshot {
  user: { id: string; status: string; role: string; authVersion: number }[];
  actor: { id: string; status: string; role: string; authVersion: number }[];
  account: { id: string; userId: string }[];
  session: { id: string; userId: string; authVersion: number }[];
  actorSession: { id: string; userId: string; authVersion: number }[];
  verification: { id: string }[];
  audit: { id: string; action: string; target: string }[];
}
interface Probe {
  error: string | null;
  batchReached: boolean;
  directChanges: number | null;
  guardFailed: boolean;
  cleanupBoundary: boolean;
  wholeRowsUnchanged: boolean;
  before: Snapshot;
  after: Snapshot;
}

describe("TC-M4.T1.d1 실제 D1 guard", () => {
  beforeAll(async () => {
    persistTo = mkdtempSync(path.join(tmpdir(), "mg-members-d1-"));
    try {
      const mig = wrangler(["d1", "migrations", "apply", "DB", "--local", "--config", CONFIG, "--persist-to", persistTo]);
      if (mig.code !== 0) throw new Error(`D1 fixture 준비 실패: 마이그레이션\n${mig.out}${mig.err}`);
      worker = await startWranglerDev({ config: CONFIG, persistTo, vars: {} });
      base = worker.baseUrl;
    } catch (e) {
      // d1-rig.ts 처럼 준비 실패는 여기서 정리한다 (afterAll 에만 기대지 않는다)
      // close 가 실패해도 임시 폴더는 지우고, 원래 준비 실패 e 를 던진다
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

  it("TC-M4.T1.d1 CAS 0행과 성공한 DELETE 뒤 정리 실패는 전체 행을 롤백하고 오류를 구분한다", async () => {
    const response = await fetch(`${base}/__test/member-rollback`, { method: "POST" });
    const body = await response.json() as Record<string, Probe> & { error?: string };
    if (response.status !== 200) throw new Error(`D1 fixture 준비 실패 (${response.status}): ${body.error ?? "시험 Worker 응답이 아니다"}`);
    const failures = {
      zeroCas: "stale_member",
      cleanupFault: "stale_member",
      actorRole: "forbidden",
      actorVersion: "forbidden",
      actorSession: "unauthorized",
      lastAdmin: "last_admin",
      lastAdminRace: "last_admin",
      versionMax: "version_exhausted",
      versionRace: "version_exhausted",
    };
    for (const [scenario, error] of Object.entries(failures)) {
      const probe = body[scenario];
      expect(probe.error, scenario).toBe(error);
      expect(probe.wholeRowsUnchanged, scenario).toBe(true);
      expect(probe.after, scenario).toEqual(probe.before);
      expect(probe.after.user, scenario).toHaveLength(1);
      expect(probe.after.account, scenario).toHaveLength(1);
      expect(probe.after.verification, scenario).toHaveLength(1);
      expect(probe.after.audit, scenario).toHaveLength(0);
      expect(probe.batchReached, scenario).toBe(!["lastAdmin", "versionMax"].includes(scenario));
    }
    for (const scenario of ["zeroCas", "actorRole", "actorVersion", "actorSession", "lastAdminRace", "versionRace"]) {
      expect(body[scenario].guardFailed, scenario).toBe(true);
      expect(body[scenario].cleanupBoundary, scenario).toBe(false);
    }
    expect(body.zeroCas.after.user[0].authVersion).toBe(1); // 경쟁 요청만 남고 실패한 CAS 는 늘리지 않는다.
    expect(body.zeroCas.after.session).toHaveLength(1);
    expect(body.actorSession.after.actorSession).toHaveLength(0);
    expect(body.actorRole.after.actor[0].role).toBe("member");
    expect(body.actorVersion.after.actor[0].authVersion).toBe(1);
    expect(body.lastAdminRace.after.actor[0].role).toBe("admin");
    expect(body.lastAdminRace.after.actorSession).toHaveLength(1);
    expect(body.versionMax.after.user[0].authVersion).toBe(2_147_483_647);
    expect(body.versionRace.after.user[0].authVersion).toBe(2_147_483_647);
    expect(body.cleanupFault.guardFailed).toBe(false);
    expect(body.cleanupFault.cleanupBoundary).toBe(true); // trigger 가 CAS·cascade·감사 뒤임을 확인하고 실패했다.
    expect(body.cleanupFault.after.user[0].status).toBe("pending");
    expect(body.cleanupFault.after.user[0].authVersion).toBe(0);
    expect(body.cleanupFault.after.session).toHaveLength(1);

    // DELETE 는 account/session cascade 를 동반하지만 바로 다음 audit 의 changes()=1 guard 를 통과해야 한다.
    const deleted = body.rejectCascade;
    expect(deleted.error).toBeNull();
    expect(deleted.batchReached).toBe(true);
    expect(deleted.guardFailed).toBe(false);
    expect(deleted.before.user).toHaveLength(1);
    expect(deleted.before.account).toHaveLength(1);
    expect(deleted.before.session).toHaveLength(1);
    expect(deleted.before.verification).toHaveLength(1);
    expect(deleted.after.user).toHaveLength(0);
    expect(deleted.after.account).toHaveLength(0);
    expect(deleted.after.session).toHaveLength(0);
    expect(deleted.after.verification).toHaveLength(0);
    expect(deleted.after.audit).toHaveLength(1);
    expect(deleted.after.audit[0].action).toBe("member.reject");
    expect(deleted.after.audit[0].target).toBe(deleted.before.user[0].id);
    expect(deleted.after.actor).toEqual(deleted.before.actor);
    expect(deleted.after.actorSession).toEqual(deleted.before.actorSession);
  });
});
