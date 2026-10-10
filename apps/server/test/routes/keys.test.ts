// K4.T1·T7 회원 키 API (계획서 v5.7 5.2·5.7). 가짜 OmniRoute 어댑터의 호출 기록으로 발급·삭제·재발급 순서를 본다.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OmniRouteError } from "@magnetosphere/omniroute";
import { markMissing } from "../../src/keys/apply.ts";
import { rebalanceMember } from "../../src/limits/member.ts";
import { monthKey } from "../../src/limits/month.ts";
import { KEY_DELETE_DELAY_MS } from "../../src/queue/index.ts";
import { sql } from "../helpers.ts";
import { addUser, call, keysOf, openRoutes, seedKey, type RouteEnv } from "./env.ts";

let e: RouteEnv;
beforeEach(async () => {
  e = await openRoutes();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await e.close();
});

/** 계획서 5.2 의 2~5번 (G-K4.21 이 이 기대값을 찾는다) */
const ISSUE_ORDER = ["createKey", "setKeyActive(false)", "setBudget", "setKeyActive(true)"];
const down = (fn: string) => new OmniRouteError(fn, "(시험)", 503, null, "OmniRoute 가 응답하지 않는다");
const jobs = async (action: string) => (await e.h.db.select().from(e.h.schema.omnirouteJobs)).filter((j: { action: string }) => j.action === action);

describe("TC-K4.T1.a 발급 순서가 계획서 5.2 와 같다", () => {
  it("createKey → setKeyActive(false) → setBudget → setKeyActive(true), 201 에 원문 1회. 예산이 성공한 뒤에만 켠다 (대조: 예산 실패면 켜기 호출 0)", async () => {
    const u = await addUser(e.h, { limitUsd: 5 });
    const r = await call(e, "POST", "/api/me/keys", { user: u, body: { label: "노트북" } });
    expect(r.status, r.text).toBe(201);
    expect(e.om.writes()).toEqual(ISSUE_ORDER);
    const secret = r.json.secret as string;
    expect(secret).toMatch(/^sk-/);
    expect(r.text.split(secret).length - 1, "응답에 원문은 한 번").toBe(1);
    const [ork] = [...e.om.keys.keys()];
    expect(e.om.keys.get(ork)).toMatchObject({ isActive: true, budget: 5 });
    expect(r.json.key).toMatchObject({ label: "노트북", state: "active", syncState: "synced", preview: secret.slice(-4) });

    // 대조: 예산 단계가 실패하면 setKeyActive(true) 를 한 번도 부르지 않는다
    const u2 = await addUser(e.h, { limitUsd: 5 });
    e.om.calls.length = 0;
    e.om.fail.setBudget = [down("setBudget")];
    const r2 = await call(e, "POST", "/api/me/keys", { user: u2, body: {} });
    expect(r2.status).toBe(502);
    expect(e.om.writes()).toEqual(["createKey", "setKeyActive(false)", "setBudget", "deleteKey"]);
  });
});

describe("TC-K4.T1.b 2~5 단계 어디서 실패해도 만든 키를 지운다", () => {
  it("끄기·예산·켜기 실패 각각 → deleteKey 1건, api_keys 행 0, 응답 502", async () => {
    for (const [fn, nth] of [["setKeyActive", 0], ["setBudget", 0], ["setKeyActive", 1]] as const) {
      const u = await addUser(e.h, { limitUsd: 5 });
      e.om.calls.length = 0;
      // nth 번째 setKeyActive 호출이 실패한다 (0: 끄기, 1: 켜기)
      e.om.fail[fn] = [...Array(nth).fill(undefined), down(fn)];
      const r = await call(e, "POST", "/api/me/keys", { user: u, body: {} });
      expect(r.status, `${fn}#${nth}`).toBe(502);
      const created = e.om.of("createKey");
      expect(created, `${fn}#${nth}`).toHaveLength(1);
      expect(e.om.of("deleteKey"), `${fn}#${nth}`).toHaveLength(1);
      expect(await keysOf(e.h, u), `${fn}#${nth} 행`).toEqual([]);
      expect(e.om.keys.size, `${fn}#${nth} OmniRoute 에 남은 키`).toBe(0);
      e.om.fail = {};
    }
  });
});

describe("TC-K4.T1.c 되돌리기도 실패하면 큐에 넣고 켜진 채 남지 않는다", () => {
  it("예산 실패 + deleteKey 503 → key.rollback 1개, 키 isActive false (끄기 단계까지). 끄기 실패 + deleteKey 실패도 다시 끈다", async () => {
    const u = await addUser(e.h, { limitUsd: 5 });
    e.om.fail.setBudget = [down("setBudget")];
    e.om.fail.deleteKey = [down("deleteKey")];
    const r = await call(e, "POST", "/api/me/keys", { user: u, body: {} });
    expect(r.status).toBe(502);
    const [ork] = [...e.om.keys.keys()];
    expect(e.om.keys.get(ork)?.isActive).toBe(false);
    const rb = await jobs("key.rollback");
    expect(rb).toHaveLength(1);
    expect(JSON.parse(rb[0].payload).omnirouteKeyId).toBe(ork);
    const [row] = await keysOf(e.h, u);
    expect(row.state, "행은 삭제 표시로 남아 정합성 점검이 끄고 지운다").toBe("deleted");

    // 끄기가 실패한 키(만든 직후 켜져 있다)도 되돌리기가 실패하면 다시 끈다
    const u2 = await addUser(e.h, { limitUsd: 5 });
    e.om.fail.setKeyActive = [down("setKeyActive")];
    e.om.fail.deleteKey = [down("deleteKey")];
    const r2 = await call(e, "POST", "/api/me/keys", { user: u2, body: {} });
    expect(r2.status).toBe(502);
    const ork2 = [...e.om.keys.keys()].find((x) => x !== ork)!;
    expect(e.om.keys.get(ork2)?.isActive).toBe(false);
    expect(await jobs("key.rollback")).toHaveLength(2);

    // 새 키를 켠 뒤 같은 분배에서 다른 키의 예산이 실패해도(rebalanceMember 가 던진다) 되돌리기가 실패하면 다시 끈다
    const u3 = await addUser(e.h, { limitUsd: 5 });
    const other = await seedKey(e, u3, { budgetUsd: 1 });
    e.om.fail.setBudget = [down("setBudget")];
    e.om.fail.deleteKey = [down("deleteKey")];
    const r3 = await call(e, "POST", "/api/me/keys", { user: u3, body: {} });
    expect(r3.status).toBe(502);
    const ork3 = [...e.om.keys.keys()].find((x) => x !== ork && x !== ork2 && x !== other.ork)!;
    expect(e.om.of("setKeyActive").filter((c) => c.id === ork3).map((c) => c.value), "켜진 뒤 실패한 경우").toContain(true);
    expect(e.om.keys.get(ork3)?.isActive, "되돌리기 실패 뒤 켜진 채 남지 않는다").toBe(false);
  });
});

describe("TC-K4.T1.d 거부 조건은 OmniRoute 를 부르지 않는다", () => {
  it("pending·suspended·이메일 미인증 → 403, 남은 한도 0 → 409 limit_exhausted, 최대 개수 → 409 max_keys. 각 경우 OmniRoute 호출 0", async () => {
    const cases: [string, Parameters<typeof addUser>[1], number, string][] = [
      ["pending", { status: "pending" }, 403, "member_inactive"],
      ["suspended", { status: "suspended" }, 403, "member_inactive"],
      ["미인증", { emailVerified: false }, 403, "email_unverified"],
      ["한도 0", { limitUsd: 0 }, 409, "limit_exhausted"],
      ["최대 개수", { maxKeys: 0 }, 409, "max_keys"],
    ];
    for (const [name, spec, status, code] of cases) {
      const u = await addUser(e.h, spec);
      const r = await call(e, "POST", "/api/me/keys", { user: u, body: {} });
      expect([r.status, r.json?.error], name).toEqual([status, code]);
      expect(e.om.calls, name).toEqual([]);
      expect(await keysOf(e.h, u), name).toEqual([]);
    }
    // 남은 한도 0 을 오늘 창으로만 아는 경우: 분석(읽기) 한 번뿐, 키를 만들지 않는다
    const u = await addUser(e.h, { limitUsd: 1 });
    const old = await seedKey(e, u, { state: "deleted" });
    e.om.costs[old.ork] = 1.5;
    const r = await call(e, "POST", "/api/me/keys", { user: u, body: {} });
    expect([r.status, r.json?.error]).toEqual([409, "limit_exhausted"]);
    expect(e.om.seq()).toEqual(["getAnalytics"]);
    // 분석을 읽지 못하면 남은 한도를 모르므로 발급하지 않는다 (fail-closed)
    e.om.calls.length = 0;
    e.om.fail.getAnalytics = [down("getAnalytics")];
    const r2 = await call(e, "POST", "/api/me/keys", { user: u, body: {} });
    expect([r2.status, r2.json?.error]).toEqual([502, "omniroute_failed"]);
    expect(e.om.writes()).toEqual([]);
  });
});

describe("TC-K4.T1.e 최대 개수는 기본 2, 비활성 포함, 삭제 제외, 줄여도 기존 키 유지", () => {
  it("기본 2 → 201·201·409, 하나 끄고도 409, 하나 지우면 201, max 3 → 201, 3→1 → 기존 3개 그대로·새 발급 409", async () => {
    const u = await addUser(e.h, { maxKeys: null });
    const post = async () => (await call(e, "POST", "/api/me/keys", { user: u, body: {} })).status;
    const live = async () => (await keysOf(e.h, u)).filter((k: { state: string }) => k.state !== "deleted").length;
    const first = await call(e, "POST", "/api/me/keys", { user: u, body: {} });
    expect(first.status).toBe(201);
    expect(await post()).toBe(201);
    expect(await post(), "기본 최대 2").toBe(409);
    expect((await call(e, "POST", `/api/me/keys/${first.json.key.id}/disable`, { user: u })).status).toBe(200);
    expect(await post(), "꺼진 키도 센다").toBe(409);
    expect((await call(e, "DELETE", `/api/me/keys/${first.json.key.id}`, { user: u })).status).toBe(200);
    expect(await post(), "삭제한 키는 세지 않는다").toBe(201);
    await e.h.db.update(e.h.schema.user).set({ maxKeys: 3 }).where(eq(e.h.schema.user.id, u));
    expect(await post()).toBe(201);
    expect(await live()).toBe(3);
    await e.h.db.update(e.h.schema.user).set({ maxKeys: 1 }).where(eq(e.h.schema.user.id, u));
    expect(await post(), "줄이면 새 발급만 막는다").toBe(409);
    expect(await live(), "기존 키는 그대로").toBe(3);
  });
});

describe("TC-K4.T1.g 원문 키는 응답에만 있다", () => {
  it("발급 뒤 DB 덤프·서버 로그에 원문 0건, key_preview == 원문 끝 4자리", async () => {
    const printed: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void printed.push(a.map(String).join(" ")));
    const u = await addUser(e.h);
    const r = await call(e, "POST", "/api/me/keys", { user: u, body: {} });
    expect(r.status).toBe(201);
    const secret = r.json.secret as string;
    // 실패 경로(되돌리기)의 로그도 본다
    e.om.fail.setBudget = [down("setBudget")];
    expect((await call(e, "POST", "/api/me/keys", { user: await addUser(e.h), body: {} })).status).toBe(502);
    expect(e.om.secrets).toHaveLength(2);
    const tables = (await sql(e.t, "SELECT name FROM sqlite_master WHERE type = 'table'")).map((row) => String(row.name));
    let dump = "";
    for (const t of tables) dump += JSON.stringify(await sql(e.t, `SELECT * FROM "${t}"`));
    const logs = [...printed, ...e.logs].join("\n");
    expect(logs, "로그가 비어 있지 않다 (대조)").toMatch(/발급 실패/);
    for (const s of e.om.secrets) {
      // 원문과, 접두사·끝 4자리를 뺀 앞부분 16자
      const head = s.slice(3, 19);
      expect([dump.includes(s), dump.includes(head)], "DB 에 원문").toEqual([false, false]);
      expect([logs.includes(s), logs.includes(head)], "로그에 원문").toEqual([false, false]);
    }
    const [row] = await keysOf(e.h, u);
    expect(row.keyPreview).toBe(secret.slice(-4));
  });
});

describe("TC-K4.T1.h OmniRoute 키 이름에 개인정보가 없다", () => {
  it("이름 ~ /^m_[0-9a-f]{8}_[0-9a-f]{8}$/, 회원 이메일·이름 문자열 0", async () => {
    const u = await addUser(e.h);
    const [user] = await e.h.db.select().from(e.h.schema.user).where(eq(e.h.schema.user.id, u));
    const r = await call(e, "POST", "/api/me/keys", { user: u, body: { label: "회사 노트북" } });
    expect(r.status).toBe(201);
    const name = e.om.of("createKey")[0].value as string;
    expect(name).toMatch(/^m_[0-9a-f]{8}_[0-9a-f]{8}$/);
    expect(name).toBe(`m_${u.slice(0, 8)}_${r.json.key.id.slice(0, 8)}`);
    for (const pii of [user.email, user.email.split("@")[0], user.name, "회사 노트북"]) expect(name.includes(pii), pii).toBe(false);
  });
});

describe("TC-K4.T1.i 목록은 남은 발급 가능 개수를 준다", () => {
  it("GET /api/me/keys → { keys[], remainingSlots }, 키 1(최대 2) → remainingSlots 1, 원문 필드 없음", async () => {
    const u = await addUser(e.h);
    const issued = await call(e, "POST", "/api/me/keys", { user: u, body: {} });
    // 지운 키는 목록·개수에 없다
    await seedKey(e, u, { state: "deleted" });
    const r = await call(e, "GET", "/api/me/keys", { user: u });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ maxKeys: 2, remainingSlots: 1 });
    expect(r.json.keys).toHaveLength(1);
    expect(Object.keys(r.json.keys[0]).sort()).toEqual(["createdAt", "disabledReason", "id", "label", "preview", "state", "syncState"]);
    expect(r.text.includes(issued.json.secret)).toBe(false);
    expect(r.text).not.toMatch(/sk-/);
  });
});

describe("TC-K4.T7.a 이름 변경은 OmniRoute 를 부르지 않는다", () => {
  it("PATCH label → 200, OmniRoute 호출 0, OmniRoute 키 이름은 m_ 그대로", async () => {
    const u = await addUser(e.h);
    const k = await seedKey(e, u);
    const name = e.om.keys.get(k.ork)!.name;
    const r = await call(e, "PATCH", `/api/me/keys/${k.id}`, { user: u, body: { label: "새 이름" } });
    expect(r.status).toBe(200);
    expect(r.json.key.label).toBe("새 이름");
    expect(e.om.calls).toEqual([]);
    expect(e.om.keys.get(k.ork)!.name).toBe(name);
    // 잘못된 이름은 400 (너무 김, 문자열 아님)
    expect((await call(e, "PATCH", `/api/me/keys/${k.id}`, { user: u, body: { label: "x".repeat(65) } })).status).toBe(400);
    expect((await call(e, "PATCH", `/api/me/keys/${k.id}`, { user: u, body: { label: 5 } })).status).toBe(400);
  });
});

describe("TC-K4.T7.b 삭제는 바로 끄고, 행을 남기고, DELETE 는 2분 뒤다 (V18 의존)", () => {
  it("DELETE → 응답 전 setKeyActive(false) 1·deleteKey 0, state deleted·deleted_at, key.delete next_run_at == 끈 시각 + 120,000ms, 다음 분배 apiKeyIds 에 그 id", async () => {
    const T = new Date("2026-10-07T03:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    const u = await addUser(e.h);
    const k = await seedKey(e, u);
    const r = await call(e, "DELETE", `/api/me/keys/${k.id}`, { user: u });
    expect(r.status).toBe(200);
    expect(e.om.seq()).toEqual(["setKeyActive(false)"]);
    expect(e.om.keys.get(k.ork)?.isActive).toBe(false);
    const [row] = await keysOf(e.h, u);
    expect(row.state).toBe("deleted");
    expect(row.deletedAt).toBeInstanceOf(Date);
    const del = await jobs("key.delete");
    expect(del).toHaveLength(1);
    expect(new Date(del[0].nextRunAt).getTime() - T.getTime()).toBe(KEY_DELETE_DELAY_MS);
    expect(KEY_DELETE_DELAY_MS).toBe(120_000);
    // 다음 분배가 지운 키의 사용액을 센다
    e.om.calls.length = 0;
    await rebalanceMember(e.h, u, { client: () => e.om.client() });
    expect(e.om.of("getAnalytics")[0].apiKeyIds).toContain(k.ork);
    // 지운 키는 다시 지우거나 켤 수 없다
    expect((await call(e, "DELETE", `/api/me/keys/${k.id}`, { user: u })).status).toBe(404);
  });
});

describe("TC-K4.T7.c 재발급은 새 키 + 옛 키 삭제이고 한도를 초기화하지 않는다 (V19 의존)", () => {
  it("어댑터 호출 == [createKey, setKeyActive(false), setBudget, setKeyActive(true), setKeyActive(false)], regenerate 0, 새 원문, 옛 행 deleted, 다음 분배 apiKeyIds 에 옛·새 id", async () => {
    const u = await addUser(e.h, { limitUsd: 5 });
    const old = await seedKey(e, u, { budgetUsd: 5, budgetMonth: monthKey(new Date()) });
    const r = await call(e, "POST", `/api/me/keys/${old.id}/regenerate`, { user: u });
    expect(r.status, r.text).toBe(201);
    expect(e.om.writes(), "새 키 발급 순서 + 옛 키 끄기").toEqual([...ISSUE_ORDER, "setKeyActive(false)"]);
    expect(e.om.of("regenerate")).toEqual([]);
    expect(e.om.of("setKeyActive").at(-1)?.id).toBe(old.ork);
    const fresh = [...e.om.keys.values()].find((k) => k.id !== old.ork)!;
    expect(r.json.secret).toBe(fresh.secret);
    expect(r.json.key.id).not.toBe(old.id);
    const rows = await keysOf(e.h, u);
    expect(rows.find((x: { id: string }) => x.id === old.id).state).toBe("deleted");
    expect((await jobs("key.delete")).map((j: { keyId: string }) => j.keyId)).toEqual([old.id]);
    e.om.calls.length = 0;
    await rebalanceMember(e.h, u, { client: () => e.om.client() });
    expect([...(e.om.of("getAnalytics")[0].apiKeyIds ?? [])].sort()).toEqual([old.ork, fresh.id].sort());
  });
});

describe("TC-K4.T7.d 남의 키는 404 이고 OmniRoute 를 부르지 않는다", () => {
  it("회원 B 세션으로 A 키에 disable·enable·regenerate·DELETE·PATCH → 모두 404, OmniRoute 0", async () => {
    const a = await addUser(e.h);
    const b = await addUser(e.h);
    const k = await seedKey(e, a);
    const tries: [string, string, unknown?][] = [
      ["POST", `/api/me/keys/${k.id}/disable`],
      ["POST", `/api/me/keys/${k.id}/enable`],
      ["POST", `/api/me/keys/${k.id}/regenerate`],
      ["DELETE", `/api/me/keys/${k.id}`],
      ["PATCH", `/api/me/keys/${k.id}`, { label: "남의 키" }],
    ];
    for (const [method, path, body] of tries) {
      const r = await call(e, method, path, { user: b, body });
      expect([method, path, r.status]).toEqual([method, path, 404]);
    }
    expect(e.om.calls).toEqual([]);
    const [row] = await keysOf(e.h, a);
    expect([row.state, row.label ?? null]).toEqual(["active", null]);
    // 세션 없이도 OmniRoute 를 부르지 않는다
    expect((await call(e, "POST", `/api/me/keys/${k.id}/disable`, {})).status).toBe(401);
    expect(e.om.calls).toEqual([]);
  });
});

describe("TC-K4.T7.e 회원이 끈 키는 회원이 켤 수 있다", () => {
  it("disable(member) → enable → 200, setKeyActive(true) 1. admin 이 끈 키 → enable 403, limit 으로 꺼진 키 → enable 409 limit_exhausted", async () => {
    const u = await addUser(e.h, { limitUsd: 5 });
    const k = await seedKey(e, u);
    expect((await call(e, "POST", `/api/me/keys/${k.id}/disable`, { user: u })).status).toBe(200);
    expect(e.om.keys.get(k.ork)?.isActive).toBe(false);
    const r = await call(e, "POST", `/api/me/keys/${k.id}/enable`, { user: u });
    expect(r.status, r.text).toBe(200);
    expect(e.om.of("setKeyActive").filter((c) => c.value === true)).toHaveLength(1);
    expect(e.om.keys.get(k.ork)?.isActive).toBe(true);
    // 켜기 전에 예산을 건다
    expect(e.om.writes().slice(-2)).toEqual(["setBudget", "setKeyActive(true)"]);

    const admin = await seedKey(e, u, { state: "disabled", reason: "admin" });
    const limit = await seedKey(e, u, { state: "disabled", reason: "limit" });
    e.om.calls.length = 0;
    expect((await call(e, "POST", `/api/me/keys/${admin.id}/enable`, { user: u })).status).toBe(403);
    const lr = await call(e, "POST", `/api/me/keys/${limit.id}/enable`, { user: u });
    expect([lr.status, lr.json?.error]).toEqual([409, "limit_exhausted"]);
    // 회원이 끄기를 눌러도 관리자가 끈 이유는 member 로 바뀌지 않는다
    expect((await call(e, "POST", `/api/me/keys/${admin.id}/disable`, { user: u })).status).toBe(200);
    expect((await call(e, "POST", `/api/me/keys/${admin.id}/enable`, { user: u })).status).toBe(403);
    expect(e.om.of("setKeyActive").filter((c) => c.value === true)).toEqual([]);
  });
});

describe("TC-K4.T7.f 재발급도 발급 조건을 본다", () => {
  it("최대 2·키 2개에서 재발급 → 201 (옛 키를 빼고 셈), 남은 한도 0 → 409 limit_exhausted·OmniRoute 0", async () => {
    const u = await addUser(e.h, { maxKeys: 2, limitUsd: 5 });
    const a = await seedKey(e, u);
    await seedKey(e, u);
    const r = await call(e, "POST", `/api/me/keys/${a.id}/regenerate`, { user: u });
    expect(r.status, r.text).toBe(201);
    // 발급은 최대 개수에 막힌다 (대조)
    expect((await call(e, "POST", "/api/me/keys", { user: u, body: {} })).status).toBe(409);

    const z = await addUser(e.h, { limitUsd: 0 });
    const zk = await seedKey(e, z, { state: "disabled", reason: "member" });
    e.om.calls.length = 0;
    const rz = await call(e, "POST", `/api/me/keys/${zk.id}/regenerate`, { user: z });
    expect([rz.status, rz.json?.error]).toEqual([409, "limit_exhausted"]);
    expect(e.om.calls).toEqual([]);
    const [row] = await keysOf(e.h, z);
    expect(row.state, "옛 키는 그대로").toBe("disabled");
  });
});

describe("TC-K4.T7.g 발급 중인 자리 행은 회원이 건드리지 못한다 (K4 보안 리뷰 M1)", () => {
  it("발급 도중 GET → state issuing(개수에는 듦), enable·disable·PATCH·regenerate·DELETE → 409 issuing·pending- id 호출 0·alert.key_missing 0, 발급은 201. 예산 단계 전 행이 바뀌면 되돌린다", async () => {
    const u = await addUser(e.h, { limitUsd: 5, maxKeys: 2 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let paused!: () => void;
    const reached = new Promise<void>((r) => (paused = r));
    e.om.before = async (c) => {
      if (c.fn === "createKey") {
        paused();
        await gate;
      }
    };
    const pending = call(e, "POST", "/api/me/keys", { user: u, body: {} });
    await reached;
    const list = await call(e, "GET", "/api/me/keys", { user: u });
    expect(list.json.keys.map((k: { state: string }) => k.state)).toEqual(["issuing"]);
    expect(list.json.remainingSlots).toBe(1);
    const id = list.json.keys[0].id as string;
    const tries: [string, string, unknown?][] = [
      ["POST", `/api/me/keys/${id}/enable`],
      ["POST", `/api/me/keys/${id}/disable`],
      ["PATCH", `/api/me/keys/${id}`, { label: "x" }],
      ["POST", `/api/me/keys/${id}/regenerate`],
      ["DELETE", `/api/me/keys/${id}`],
    ];
    for (const [method, path, body] of tries) {
      const r = await call(e, method, path, { user: u, body });
      expect([method, path, r.status, r.json?.error]).toEqual([method, path, 409, "issuing"]);
    }
    release();
    const done = await pending;
    expect(done.status, done.text).toBe(201);
    expect(e.om.calls.filter((c) => c.id?.startsWith("pending-"))).toEqual([]);
    const alerts = (await e.h.db.select().from(e.h.schema.auditLog)).filter((a: { action: string }) => a.action === "alert.key_missing");
    expect(alerts).toEqual([]);
    expect(done.json.key).toMatchObject({ state: "active", syncState: "synced" });
    // K3 쪽 방어: 자리 행 id 로는 missing·alert.key_missing 을 쓰지 않는다
    await markMissing(e.h, undefined, { keyId: id, omnirouteKeyId: `pending-${id}` }, new Date());
    expect((await e.h.db.select().from(e.h.schema.auditLog)).filter((a: { action: string }) => a.action === "alert.key_missing")).toEqual([]);

    // 예산 단계 전에 자리 행이 바뀌면(다른 쓰기) 예산·켜기를 하지 않고 되돌린다 (모순 상태 active·limit 을 만들지 않는다)
    const u2 = await addUser(e.h, { limitUsd: 5 });
    e.om.calls.length = 0;
    e.om.before = async (c) => {
      if (c.fn === "setKeyActive" && c.value === false) await e.h.db.update(e.h.schema.apiKeys).set({ state: "active", disabledReason: null }).where(eq(e.h.schema.apiKeys.userId, u2));
    };
    const r2 = await call(e, "POST", "/api/me/keys", { user: u2, body: {} });
    expect(r2.status).toBe(409);
    expect(e.om.writes()).toEqual(["createKey", "setKeyActive(false)", "deleteKey"]);
    expect(await keysOf(e.h, u2)).toEqual([]);
  });
});
