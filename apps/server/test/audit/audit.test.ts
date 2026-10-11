// M1.T3 감사 기록 쓰기 (SQLite). 개인정보·비밀 값 키 거부(TC-M1.T3.a), action 허용 목록(TC-M1.T3.b).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { AUDIT_ACTIONS, AuditError, auditStatement, PHASE2_AUDIT_ACTIONS, writeAudit, type AuditAction, type AuditEntry } from "../../src/audit/index.ts";
import { makeTestEnv, type TestEnv } from "../helpers.ts";

const NOW = new Date("2026-10-11T00:00:00.000Z");
let t: TestEnv;
let h: DbHandle;
beforeEach(async () => {
  t = await makeTestEnv();
  h = await connectNode(t.env.DATABASE_URL);
});
afterEach(async () => {
  await h?.close();
  t?.cleanup();
});

const entry = (over: Partial<AuditEntry>): AuditEntry => ({ actorId: "admin-1", action: "member.suspend", target: "m-1", detail: null, ip: "198.18.0.1", now: NOW, ...over });
const rows = async () => (await h.db.select().from(h.schema.auditLog)) as any[];

async function refused(e: AuditEntry, code: string): Promise<void> {
  const err = await writeAudit(h, e).then(
    () => null,
    (x: unknown) => x,
  );
  expect(err, JSON.stringify(e.detail ?? e.action)).toBeInstanceOf(AuditError);
  expect((err as AuditError).code, JSON.stringify(e.detail ?? e.action)).toBe(code);
}

describe("M1.T3 감사 기록", () => {
  it("TC-M1.T3.a detail 에 이메일·이름·비밀번호·토큰·해시 키가 있으면 어느 깊이든 예외·행 0, { from, to } 는 1행 (Q17)", async () => {
    const bad: Record<string, unknown>[] = [
      { email: "a@b.example" },
      { token: "raw-token" },
      { tokenHash: "abc" },
      { token_hash: "abc" },
      { nested: { email: "a@b.example" } },
      { list: [{ ok: 1 }, { Email: "a@b.example" }] },
      { name: "홍길동" },
      { password: "x" },
      { newEmail: "a@b.example" },
      { apiKey: "re_x" },
    ];
    for (const detail of bad) await refused(entry({ detail }), "forbidden_detail_key");
    for (const detail of [[1], "문자열", 3] as unknown[]) await refused(entry({ detail: detail as Record<string, unknown> }), "invalid_detail");
    // 트랜잭션·D1 batch 용 문도 만들 때 거부한다 (보내기 전)
    expect(() => auditStatement(h, entry({ detail: { inviteId: "i-1", tokenHash: "abc" } }))).toThrow(AuditError);
    expect(await rows(), "거부한 기록은 행이 없다").toEqual([]);

    // 대조: 개인정보가 없는 detail 은 그대로 남는다 (이름(name)이 아닌 키 이름에 name 이 들어간 것도 된다)
    await writeAudit(h, entry({ detail: { from: "active", to: "suspended", keyNames: 2 } }));
    const [row] = await rows();
    expect({ ...row, id: typeof row.id, detail: JSON.parse(row.detail) }).toEqual({
      id: "string",
      actorId: "admin-1",
      action: "member.suspend",
      target: "m-1",
      detail: { from: "active", to: "suspended", keyNames: 2 },
      ip: "198.18.0.1",
      createdAt: NOW,
    });
    // 문으로 받아 트랜잭션 안에서 쓸 수 있다
    await h.db.transaction(async (tx: any) => {
      await auditStatement(h, entry({ action: "member.unsuspend", detail: { from: "suspended", to: "active" } }), tx);
    });
    expect((await rows()).map((r) => r.action).sort()).toEqual(["member.suspend", "member.unsuspend"]);
  });

  it("TC-M1.T3.b 모르는 action 은 예외, 허용 목록 12개는 각 1행 (Q17)", async () => {
    for (const action of ["member.Suspend", "x", "member.suspend ", "alert.", ""]) await refused(entry({ action: action as AuditAction }), "unknown_action");
    expect(await rows()).toEqual([]);

    expect(AUDIT_ACTIONS).toHaveLength(12);
    for (const action of AUDIT_ACTIONS) await writeAudit(h, entry({ action, detail: { n: 1 } }));
    // 2단계가 이미 쓰는 이름도 같은 표에 있다
    for (const action of PHASE2_AUDIT_ACTIONS) await writeAudit(h, entry({ action, actorId: null, ip: null }));
    const counts = new Map<string, number>();
    for (const r of await rows()) counts.set(r.action, (counts.get(r.action) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual(Object.fromEntries([...AUDIT_ACTIONS, ...PHASE2_AUDIT_ACTIONS].map((a) => [a, 1])));
  });
});
