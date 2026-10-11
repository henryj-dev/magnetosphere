// 관리자 초대 API (M3.T1) 공용 단언. 단위(admin.test.ts, SQLite 파일 DB + D1 경로)와 네 DB(admin.db.test.ts, pnpm test:db)가
// 같은 단언을 쓴다. 각 함수는 앱이 붙은 RouteEnv 하나를 받고, 관리자·이메일을 스스로 새로 만든다 (같은 DB 를 여러 시험이 나눠 써도 겹치지 않게).
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect } from "vitest";
import { addUser, call, openRoutes, type RouteEnv } from "../routes/env.ts";

export const BASE = "https://llm.example.com";
export const DAY = 86_400_000;

/** [이름, D1 경로(batch)를 타는지] */
export type Variant = readonly [label: string, d1: boolean];
/** 단위 시험: Node SQLite 와 libsql batch 로 흉내 낸 D1 경로 */
export const NODE_AND_D1: readonly Variant[] = [
  ["Node SQLite", false],
  ["D1 경로(libsql batch)", true],
];

/** app_settings 한 행을 그대로 쓴다 (정책 검사 없이, 시험 준비용). value undefined 면 지운다 */
export async function setRaw(e: RouteEnv, key: string, value: unknown) {
  const t = e.h.schema.appSettings;
  await e.h.db.delete(t).where(eq(t.key, key));
  if (value !== undefined) await e.h.db.insert(t).values({ key, value: JSON.stringify(value), updatedAt: new Date(), updatedBy: null });
}

/** 초대를 만들 수 있는 설정 (설치 끝·메일 있음) */
export async function prepareInvites(e: RouteEnv) {
  await setRaw(e, "public_base_url", BASE);
  await setRaw(e, "mail_settings", { provider: "resend", from: "noreply@example.com", apiKey: "enc" });
}

const invites = (e: RouteEnv) => e.h.db.select().from(e.h.schema.invites);
const audits = (e: RouteEnv, action: string) => e.h.db.select().from(e.h.schema.auditLog).where(eq(e.h.schema.auditLog.action, action));
const create = (e: RouteEnv, user: string, body: unknown) => call(e, "POST", "/api/admin/invites", { user, body });
const ms = (v: unknown) => (v instanceof Date ? v.getTime() : new Date(v as string | number).getTime());
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const inviteById = async (e: RouteEnv, id: string) => (await e.h.db.select().from(e.h.schema.invites).where(eq(e.h.schema.invites.id, id)))[0];
const isLive = (r: any) => r.usedAt === null && r.revokedAt === null && ms(r.expiresAt) > Date.now();

/**
 * 끼어들기 장치. 같은 DB 에 앱을 하나 더 띄우되, 그 앱의 db.transaction·db.batch 를 부를 때마다 queue 의 앞 함수를 먼저 부른다
 * (읽은 뒤 쓰기 전에 다른 요청이 초대를 차지·취소·추가한 상황). d1 이면 DbHandle.kind 를 "d1" 로 바꿔 D1 경로(batch)를 탄다.
 * Node SQLite 드라이버(libsql)도 drizzle batch 를 지원한다 — 실제 D1 런타임은 아니다.
 */
async function interleaved(e: RouteEnv, d1: boolean) {
  const queue: (undefined | (() => Promise<void>))[] = [];
  const target = e.h.db;
  const db = new Proxy(target, {
    get(o, p, r) {
      if (p === "transaction" || p === "batch") {
        const f = o[p].bind(o);
        return async (...a: unknown[]) => {
          const before = queue.shift();
          if (before) await before();
          return f(...a);
        };
      }
      return Reflect.get(o, p, r);
    },
  });
  const app = await openRoutes({ h: { ...e.h, db, kind: d1 ? "d1" : e.h.kind } });
  return { app, queue };
}

/** 시험 준비용 초대 행을 바로 넣는다 */
async function rawInvite(e: RouteEnv, o: { email: string | null; createdBy: string; expiresAt?: Date; usedAt?: Date | null; revokedAt?: Date | null }) {
  const id = randomUUID();
  await e.h.db.insert(e.h.schema.invites).values({
    id,
    email: o.email,
    tokenHash: sha256(id),
    role: "member",
    expiresAt: o.expiresAt ?? new Date(Date.now() + 7 * DAY),
    usedAt: o.usedAt ?? null,
    usedBy: null,
    createdBy: o.createdBy,
    revokedAt: o.revokedAt ?? null,
  });
  return id;
}

/** TC-M3.T1.g 감사 기록은 실제 변경과 같다: 읽은 뒤 사용·취소된 초대의 DELETE 는 404·감사 0행, 재초대 invite.revoke 는 실제로 취소된 행만 */
export async function tcM3T1g(e: RouteEnv, variants: readonly Variant[]) {
  const admin = await addUser(e.h, { role: "admin" });
  const run = randomUUID().slice(0, 8);
  for (const [label, d1] of variants) {
    const { app, queue } = await interleaved(e, d1);
    try {
      const revokes = async () => (await audits(e, "invite.revoke")).map((a: any) => a.target as string).sort();
      const before = await revokes();
      // DELETE: 읽은 뒤 다른 요청이 사용(수락)·취소한다
      for (const claim of ["usedAt", "revokedAt"] as const) {
        const id = await rawInvite(e, { email: `g-del-${claim}-${d1}-${run}@example.com`, createdBy: admin });
        queue.push(async () => void (await e.h.db.update(e.h.schema.invites).set({ [claim]: new Date() }).where(eq(e.h.schema.invites.id, id))));
        const del = await call(app, "DELETE", `/api/admin/invites/${id}`, { user: admin });
        expect({ label, claim, status: del.status, error: del.json?.error }).toEqual({ label, claim, status: 404, error: "not_found" });
        expect(await revokes(), `${label} ${claim}`).toEqual(before);
        const row = await inviteById(e, id);
        if (claim === "usedAt") expect(row.revokedAt, label).toBeNull();
      }
      // 재초대: 앞서 살아 있던 A 를 읽은 뒤 A 는 사용되고, 같은 이메일 B 가 끼어든다
      const email = `g-re-${d1}-${run}@example.com`;
      const a = await rawInvite(e, { email, createdBy: admin });
      let b = "";
      queue.push(async () => {
        await e.h.db.update(e.h.schema.invites).set({ usedAt: new Date() }).where(eq(e.h.schema.invites.id, a));
        b = await rawInvite(e, { email, createdBy: admin });
      });
      const re = await call(app, "POST", "/api/admin/invites", { user: admin, body: { role: "member", email } });
      expect(re.status, `${label} ${re.text}`).toBe(201);
      expect((await inviteById(e, a)).revokedAt, `${label} 사용한 A 는 취소되지 않는다`).toBeNull();
      expect((await inviteById(e, b)).revokedAt, `${label} 끼어든 B 는 취소된다`).not.toBeNull();
      const added = (await revokes()).filter((x: string) => !before.includes(x));
      expect({ label, revoked: added }).toEqual({ label, revoked: [b] });
    } finally {
      await app.close();
    }
  }
}

/** TC-M3.T1.h 같은 이메일 동시 재초대 → 살아 있는 초대 1개 (승자는 (expires_at, id) 가 큰 쪽, 진 쪽은 409 invite_conflict·링크 없음) */
export async function tcM3T1h(e: RouteEnv, variants: readonly Variant[]) {
  const admin = await addUser(e.h, { role: "admin" });
  const run = randomUUID().slice(0, 8);
  const liveOf = async (email: string) => (await invites(e)).filter((r: any) => r.email === email && isLive(r));
  const supersededTargets = async () =>
    (await audits(e, "invite.revoke")).filter((a: any) => JSON.parse(a.detail).reason === "superseded").map((a: any) => a.target as string).sort();
  for (const [label, d1] of variants) {
    const { app, queue } = await interleaved(e, d1);
    try {
      // 내 트랜잭션이 커밋된 뒤, 정리 전에 서로의 취소를 못 본 동시 요청의 초대가 생긴다 (첫 번째 호출 = 만들기, 두 번째 = 정리)
      // 더 큰 형제(만료 30일) → 나는 진다
      const big = `h-big-${d1}-${run}@example.com`;
      let sib = "";
      queue.push(undefined, async () => void (sib = await rawInvite(e, { email: big, createdBy: admin, expiresAt: new Date(Date.now() + 30 * DAY) })));
      const lose = await call(app, "POST", "/api/admin/invites", { user: admin, body: { role: "member", email: big } });
      expect({ label, status: lose.status, error: lose.json?.error, link: lose.json?.link }).toEqual({ label, status: 409, error: "invite_conflict", link: undefined });
      expect(lose.text).not.toContain("/invite#");
      expect((await liveOf(big)).map((r: any) => r.id), label).toEqual([sib]);
      // 더 작은 형제(만료 1일) → 내가 이기고 형제를 취소한다
      const small = `h-small-${d1}-${run}@example.com`;
      let low = "";
      const before = await supersededTargets();
      queue.push(undefined, async () => void (low = await rawInvite(e, { email: small, createdBy: admin, expiresAt: new Date(Date.now() + DAY) })));
      const win = await call(app, "POST", "/api/admin/invites", { user: admin, body: { role: "member", email: small } });
      expect(win.status, `${label} ${win.text}`).toBe(201);
      expect((await liveOf(small)).map((r: any) => r.id), label).toEqual([win.json.invite.id]);
      expect((await inviteById(e, low)).revokedAt, label).not.toBeNull();
      const added = (await supersededTargets()).filter((x: string) => !before.includes(x));
      expect(added.includes(low), label).toBe(true);
      // 진 요청의 자기 행은 취소됐고 superseded 감사가 있다. 이긴 형제(sib)에는 취소 기록이 없다
      const loser = (await invites(e)).filter((r: any) => r.email === big && r.id !== sib);
      expect(loser.map((r: any) => r.revokedAt !== null), label).toEqual([true]);
      const targets = await supersededTargets();
      expect([targets.includes(loser[0].id), targets.includes(sib)], label).toEqual([true, false]);
    } finally {
      await app.close();
    }
  }
  // 실제로 겹친 요청 여럿: 살아 있는 초대는 정확히 1개이고 그것은 201 을 받은 것 중 하나다
  const email = `h-many-${run}@example.com`;
  const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => create(e, admin, { role: "member", email, expiresInDays: 1 + (i % 3) })));
  expect(rs.every((r) => r.status === 201 || (r.status === 409 && r.json?.error === "invite_conflict" && r.json?.link === undefined)), rs.map((r) => r.text).join("\n")).toBe(true);
  const live = await liveOf(email);
  expect(live).toHaveLength(1);
  expect(rs.filter((r) => r.status === 201).map((r) => r.json.invite.id)).toContain(live[0].id);
}


type Res = Awaited<ReturnType<typeof call>>;

/** 회차 하나에서 본 것 */
export interface RoundObservation {
  kind: "empty-pair" | "same-email" | "distinct-emails";
  requests: number;
  created: number;
  conflict: number;
  /** 201 을 받았지만 끝에 취소된 초대 (뒤에 온 요청의 재초대·정리가 취소) */
  createdThenRevoked: number;
  /** 같은 이메일: 살아 있는 초대 수. 서로 다른 이메일: 살아 있는 초대가 정확히 1개인 이메일 수 */
  live: number;
  ms: number;
  /** 단언 실패 (없으면 빈 배열). 500 이면 그때 찍힌 오류(DB 오류 코드 포함)를 붙인다 */
  failures: string[];
}

export interface ConcurrentObservation {
  rounds: RoundObservation[];
  failures: string[];
}

/** fn 이 도는 동안 앱 기록(e.logs)과 console.error 로 나간 줄을 모은다 (500 의 원인 — DB 오류 코드 — 을 보고에 붙이려고) */
async function capturing<T>(e: RouteEnv, fn: () => Promise<T>): Promise<{ value: T; printed: string[] }> {
  const from = e.logs.length;
  const printed: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => {
    printed.push(a.map((x) => (x instanceof Error ? `${x.message} ${(x as any).code ?? ""} ${(x as any).cause?.message ?? ""} ${(x as any).cause?.code ?? ""}` : String(x))).join(" "));
    orig(...a);
  };
  try {
    const value = await fn();
    return { value, printed: [...e.logs.slice(from), ...printed] };
  } finally {
    console.error = orig;
  }
}

/** 응답이 201(링크 있음)·409 invite_conflict(링크 없음) 말고 다른 것이면 실패 문장 */
function oddResponses(rs: Res[], printed: string[]): string[] {
  const out: string[] = [];
  const prefix = `${BASE}/invite#`;
  for (const r of rs) {
    if (r.status === 201 && typeof r.json?.link === "string" && r.json.link.startsWith(prefix) && r.json.invite?.id) continue;
    if (r.status === 409 && JSON.stringify(r.json) === JSON.stringify({ error: "invite_conflict" }) && !r.text.includes("/invite#")) continue;
    out.push(`응답 ${r.status} ${r.text.slice(0, 200)}`);
  }
  if (out.length && printed.length) out.push(`그때 기록: ${printed.join(" | ").slice(0, 2000)}`);
  return out;
}

/** 읽은 expires_at 을 그대로 매개변수로 넘겨 같은 행이 잡히는지 (MySQL datetime(3)·시간대·정밀도 왕복). settleSiblings 의 (expires_at, id) 비교가 이 왕복에 기댄다 */
async function expiresRoundTrip(e: RouteEnv, rows: any[]): Promise<string[]> {
  const t = e.h.schema.invites;
  const out: string[] = [];
  for (const r of rows) {
    const got = await e.h.db.select({ id: t.id }).from(t).where(and(eq(t.id, r.id), eq(t.expiresAt, r.expiresAt)));
    if (got.length !== 1) out.push(`expires_at 왕복 불일치 ${r.id} ${ms(r.expiresAt)}`);
  }
  return out;
}

/** 같은 이메일 n 개 동시: 살아 있는 초대 1개 = 201 하나(id·토큰 해시), 나머지 201 은 취소, 409 행도 취소, 감사 = 실제 취소 */
async function sameEmailRound(e: RouteEnv, kind: RoundObservation["kind"], n: number): Promise<RoundObservation> {
  const admin = await addUser(e.h, { role: "admin" });
  const email = `i-${kind}-${randomUUID().slice(0, 8)}@example.com`;
  const t0 = Date.now();
  const { value: rs, printed } = await capturing(e, () => Promise.all(Array.from({ length: n }, (_, i) => create(e, admin, { role: "member", email, expiresInDays: 1 + (i % 3) }))));
  const elapsed = Date.now() - t0;
  const failures = oddResponses(rs, printed);
  const ok = rs.filter((r) => r.status === 201 && r.json?.link);
  const conflict = rs.filter((r) => r.status === 409);
  const rows = (await invites(e)).filter((r: any) => r.email === email);
  const live = rows.filter(isLive);
  const obs = (): RoundObservation => ({ kind, requests: n, created: ok.length, conflict: conflict.length, createdThenRevoked: Math.max(ok.length - live.length, 0), live: live.length, ms: elapsed, failures });
  if (failures.length) return obs();
  if (rows.length !== n) failures.push(`초대 행 ${rows.length}개 (요청 ${n})`);
  if (live.length !== 1) {
    failures.push(`살아 있는 초대 ${live.length}개`);
    return obs();
  }
  const winner = live[0];
  const prefix = `${BASE}/invite#`;
  const byHash = ok.filter((r) => sha256(r.json.link.slice(prefix.length)) === winner.tokenHash).map((r) => r.json.invite.id);
  if (JSON.stringify(byHash) !== JSON.stringify([winner.id])) failures.push(`살아 있는 초대 해시와 맞는 201: ${JSON.stringify(byHash)} (살아 있는 id ${winner.id})`);
  const okIds = ok.map((r) => r.json.invite.id as string);
  const rowById = new Map<string, any>(rows.map((r: any) => [r.id as string, r]));
  for (const id of okIds) if (id !== winner.id && rowById.get(id)?.revokedAt == null) failures.push(`201 ${id} 가 살아 있지도 취소되지도 않음`);
  const conflictRows = rows.filter((r: any) => !okIds.includes(r.id));
  if (conflictRows.length !== conflict.length) failures.push(`201 에 없는 행 ${conflictRows.length}개 ≠ 409 ${conflict.length}개`);
  for (const r of conflictRows) if (r.revokedAt == null) failures.push(`409 행 ${r.id} 취소 안 됨`);
  // 감사 = 실제 변경
  const ids = new Set(rows.map((r: any) => r.id as string));
  const creates = (await audits(e, "invite.create")).filter((a: any) => ids.has(a.target)).length;
  if (creates !== n) failures.push(`invite.create ${creates}행 (요청 ${n})`);
  const revokeCount: Record<string, number> = {};
  for (const a of await audits(e, "invite.revoke")) if (ids.has(a.target)) revokeCount[a.target] = (revokeCount[a.target] ?? 0) + 1;
  const want = Object.fromEntries(rows.filter((r: any) => r.id !== winner.id).map((r: any) => [r.id, 1]));
  const sortObj = (o: Record<string, number>) => JSON.stringify(Object.entries(o).sort());
  if (sortObj(revokeCount) !== sortObj(want)) failures.push(`invite.revoke ${JSON.stringify(revokeCount)} ≠ 취소된 행마다 1 ${JSON.stringify(want)}`);
  failures.push(...(await expiresRoundTrip(e, rows)));
  return obs();
}

/** 서로 다른 이메일 n 개 동시: 모두 201, 이메일마다 살아 있는 초대 1개 (= 그 응답의 것), 취소·감사 invite.revoke 0 */
async function distinctEmailsRound(e: RouteEnv, n: number): Promise<RoundObservation> {
  const admin = await addUser(e.h, { role: "admin" });
  const run = randomUUID().slice(0, 8);
  const emails = Array.from({ length: n }, (_, i) => `i-d${i}-${run}@example.com`);
  const t0 = Date.now();
  const { value: rs, printed } = await capturing(e, () => Promise.all(emails.map((email, i) => create(e, admin, { role: "member", email, expiresInDays: 1 + (i % 3) }))));
  const elapsed = Date.now() - t0;
  const failures = oddResponses(rs, printed);
  const ok = rs.filter((r) => r.status === 201 && r.json?.link);
  const conflict = rs.filter((r) => r.status === 409);
  if (conflict.length) failures.push(`서로 다른 이메일인데 409 ${conflict.length}개`);
  const rows = (await invites(e)).filter((r: any) => emails.includes(r.email));
  let liveOne = 0;
  rs.forEach((r, i) => {
    const mine = rows.filter((x: any) => x.email === emails[i]);
    const live = mine.filter(isLive);
    if (live.length === 1) liveOne++;
    if (r.status === 201 && (mine.length !== 1 || live.length !== 1 || live[0].id !== r.json.invite.id)) failures.push(`${emails[i]}: 행 ${mine.length}·살아 있음 ${live.length}`);
  });
  const ids = new Set(rows.map((r: any) => r.id as string));
  const revokes = (await audits(e, "invite.revoke")).filter((a: any) => ids.has(a.target)).length;
  if (revokes) failures.push(`서로 다른 이메일인데 invite.revoke ${revokes}행`);
  failures.push(...(await expiresRoundTrip(e, rows)));
  return { kind: "distinct-emails", requests: n, created: ok.length, conflict: conflict.length, createdThenRevoked: 0, live: liveOne, ms: elapsed, failures };
}

/**
 * TC-M3.T1.i 끼어들기 장치 없이 실제 동시 요청(Promise.all). 회차마다 새 관리자(요청 수 제한 분당 30 회 안)로 보낸다.
 *   1. 빈 표에서 같은 이메일 2개 동시 (MySQL·MariaDB gap 잠금 교착 관찰) — 회차 전에 invites 를 비운다. 이 함수는 전용 DB 에서만 부른다
 *   2. 같은 이메일 4개·8개 동시 (Postgres 40P01·MySQL 1213 관찰)
 *   3. 서로 다른 이메일 12개 동시 (invites.email 에 인덱스가 없어 FOR UPDATE 가 다른 이메일 행까지 잠그는지 관찰)
 * 단언(회차마다): 응답은 201(링크 있음)·409 invite_conflict(링크 없음)뿐, 500 0 (교착·직렬화 실패는 500 으로 드러난다).
 *   같은 이메일: 요청마다 행 1개, 살아 있는 초대 정확히 1개 = 201 하나(invite.id·sha256(토큰) == token_hash),
 *   다른 201 은 뒤에 취소됨, 409 행은 취소됨, invite.create n 행·invite.revoke 는 취소된 행마다 1행.
 *   서로 다른 이메일: 모두 201, 이메일마다 살아 있는 초대 1개, invite.revoke 0행.
 *   모든 행: 읽은 expires_at 을 매개변수로 다시 넘기면 같은 행이 잡힌다.
 * 실패를 회차별로 모아 마지막에 한 번에 단언한다 (재현 빈도를 보고하려고).
 */
export async function tcM3T1i(e: RouteEnv, o: { rounds?: number } = {}): Promise<ConcurrentObservation> {
  const rounds = o.rounds ?? 3;
  const out: RoundObservation[] = [];
  for (let k = 0; k < rounds; k++) {
    await e.h.db.delete(e.h.schema.invites);
    out.push(await sameEmailRound(e, "empty-pair", 2));
  }
  for (let k = 0; k < rounds; k++) for (const n of [4, 8]) out.push(await sameEmailRound(e, "same-email", n));
  for (let k = 0; k < rounds; k++) out.push(await distinctEmailsRound(e, 12));
  const failures = out.flatMap((r, i) => r.failures.map((f) => `#${i} ${r.kind} n=${r.requests}: ${f}`));
  const result = { rounds: out, failures };
  expect(failures, JSON.stringify(out.map(({ failures: _, ...r }) => r))).toEqual([]);
  return result;
}
