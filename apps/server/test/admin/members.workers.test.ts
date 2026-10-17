// TC-M4.T1.d1 실제 D1 batch 롤백, TC-M4.T1.c·T1.d 실제 D1 batch 끼리의 동시 경쟁. 실행 승인은 별도다.
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
interface RaceRows {
  users: { id: string; role: string; status: string; authVersion: number }[];
  sessions: { id: string; userId: string; authVersion: number }[];
  accounts: { id: string; userId: string }[];
  verifications: { id: string }[];
  audits: { id: string; action: string; actorId: string; target: string }[];
  activeAdmins: number;
}
interface RaceRound {
  kind: "approveReject" | "roleRole" | "suspendSuspend";
  round: number;
  barrier: boolean;
  results: { action: string; actorId: string; actorSessionId: string; targetId: string; batch: string; error: string | null }[];
  ids: { a: string; b: string; target: string; sa: string; sb: string; targetSession: string; account: string; verification: string };
  before: RaceRows;
  after: RaceRows;
  same: Record<string, boolean>;
}

/** 시험 Worker 의 같은 요청 안에서 실제 D1 batch 두 개를 겹친다. 응답에는 token 이 없다 */
async function race(kind: "approveReject" | "lastAdmin"): Promise<RaceRound[]> {
  const response = await fetch(`${base}/__test/member-race?kind=${kind}`, { method: "POST" });
  const body = await response.json() as { rounds?: RaceRound[]; error?: string };
  if (response.status !== 200 || !body.rounds) throw new Error(`D1 fixture 준비 실패 (${response.status}): ${body.error ?? "시험 Worker 응답이 아니다"}`);
  return body.rounds;
}

/** 두 요청 중 정확히 하나만 이기고, 장벽 회차에서는 둘 다 batch 에 닿은 뒤 진 쪽이 감사 guard 로 되돌려졌는지 본다 */
function decided(r: RaceRound) {
  const at = `${r.kind} ${r.round}`;
  expect(r.results, at).toHaveLength(2);
  const won = r.results.filter((x) => x.error === null);
  expect(won, at).toHaveLength(1);
  const lost = r.results.find((x) => x.error !== null)!;
  expect(won[0].batch, at).toBe("ok");
  if (r.barrier) expect(lost.batch, at).toBe("guard");
  else expect(["none", "guard"], at).toContain(lost.batch);
  return { at, won: won[0], lost };
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

  it("TC-M4.T1.c D1: pending 회원 승인·거절 동시 batch 20 회는 하나만 성공하고 최종 행·감사가 승자와 맞다", async () => {
    const rounds = await race("approveReject");
    expect(rounds).toHaveLength(20);
    expect(rounds.filter((r) => r.barrier)).toHaveLength(10);
    for (const r of rounds) {
      const { at, won, lost } = decided(r);
      const { a, b, target, sa, sb, targetSession, account, verification } = r.ids;
      expect(r.before.activeAdmins, at).toBe(2);
      expect(r.before.users.find((x) => x.id === target), at).toEqual({ id: target, role: "member", status: "pending", authVersion: 0 });
      expect(r.before.sessions.map((x) => x.id).sort(), at).toEqual([sa, sb, targetSession].sort());
      expect(r.before.accounts, at).toEqual([{ id: account, userId: target }]);
      expect(r.before.verifications, at).toEqual([{ id: verification }]);
      expect(r.before.audits, at).toHaveLength(0);
      const approved = won.action === "approve";
      // 장벽 회차는 둘 다 pending 을 관찰했으므로 진 쪽은 CAS 0행 → guard 롤백 → stale_member 다.
      // 자연 회차에서 진 쪽이 승자 커밋 뒤에 읽으면 전이 판정(invalid_transition)이나 대상 없음(not_found)으로 batch 전에 끝난다.
      if (r.barrier) expect(lost.error, at).toBe("stale_member");
      else expect(approved ? ["stale_member", "invalid_transition"] : ["stale_member", "not_found"], at).toContain(lost.error);
      expect(lost.action, at).toBe(approved ? "reject" : "approve");
      // 두 관리자 행·세션은 어느 쪽이 이겨도 그대로다.
      for (const id of [a, b, sa, sb]) expect(r.same[id], `${at} ${id}`).toBe(true);
      expect(r.after.activeAdmins, at).toBe(2);
      expect(r.after.sessions.map((x) => x.id).sort(), at).toEqual([sa, sb].sort());
      if (approved) {
        expect(r.after.users.find((x) => x.id === target), at).toEqual({ id: target, role: "member", status: "active", authVersion: 1 });
        expect(r.after.accounts, at).toEqual(r.before.accounts);
        expect(r.after.verifications, at).toEqual(r.before.verifications);
      } else {
        expect(r.after.users.find((x) => x.id === target), at).toBeUndefined();
        expect(r.after.accounts, at).toHaveLength(0);
        expect(r.after.verifications, at).toHaveLength(0);
      }
      // 거절로 지운 행에 승인이 다시 쓰거나 감사가 둘 남지 않는다.
      expect(r.after.audits.map(({ action, actorId, target: t }) => ({ action, actorId, target: t })), at).toEqual([{ action: approved ? "member.approve" : "member.reject", actorId: won.actorId, target }]);
    }
  });

  it("TC-M4.T1.d D1: 두 관리자의 서로 동시 강등·정지 batch 각 20 회는 활성 관리자 하나와 승자 감사 하나만 남긴다", async () => {
    const rounds = await race("lastAdmin");
    expect(rounds.filter((r) => r.kind === "roleRole")).toHaveLength(20);
    expect(rounds.filter((r) => r.kind === "suspendSuspend")).toHaveLength(20);
    expect(rounds.filter((r) => r.barrier)).toHaveLength(20);
    for (const r of rounds) {
      const { at, won, lost } = decided(r);
      const { a, b, sa, sb } = r.ids;
      expect(r.before.activeAdmins, at).toBe(2);
      expect(r.before.users.map(({ role, status, authVersion }) => ({ role, status, authVersion })), at).toEqual([
        { role: "admin", status: "active", authVersion: 0 },
        { role: "admin", status: "active", authVersion: 0 },
      ]);
      expect(r.before.sessions.map((x) => x.id).sort(), at).toEqual([sa, sb].sort());
      expect(r.before.audits, at).toHaveLength(0);
      // 장벽 회차는 둘 다 batch 에 닿은 뒤 guard 재판정에서 먼저 권한을 잃은 쪽이 403 forbidden 이다.
      // 자연 회차는 진 쪽 사전 읽기가 승자 커밋 앞뒤 어디였는지에 따라 401·403·409 last_admin 중 하나로 끝날 수 있다.
      if (r.barrier) expect(lost.error, at).toBe("forbidden");
      else expect(["forbidden", "unauthorized", "last_admin"], at).toContain(lost.error);
      expect(won.targetId, at).toBe(lost.actorId);
      expect(lost.targetId, at).toBe(won.actorId);
      const winnerSession = won.actorId === a ? sa : sb;
      expect(winnerSession, at).toBe(won.actorSessionId);
      expect(r.same[won.actorId], at).toBe(true);
      expect(r.same[winnerSession], at).toBe(true);
      expect(r.after.activeAdmins, at).toBe(1);
      expect(r.after.users.find((x) => x.id === lost.actorId), at).toEqual({
        id: lost.actorId,
        role: r.kind === "roleRole" ? "member" : "admin",
        status: r.kind === "suspendSuspend" ? "suspended" : "active",
        authVersion: 1,
      });
      expect(r.after.sessions.map((x) => x.id), at).toEqual([winnerSession]);
      expect(r.after.audits.map(({ action, actorId, target }) => ({ action, actorId, target })), at).toEqual([
        { action: r.kind === "roleRole" ? "member.role" : "member.suspend", actorId: won.actorId, target: lost.actorId },
      ]);
    }
  });
});
