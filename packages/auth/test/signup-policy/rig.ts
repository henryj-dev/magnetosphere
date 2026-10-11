// 가입 정책 시험(M2)의 Rig 와 DB 도구. 시험은 Rig 하나만 보고 돈다.
//   packages/auth 네 DB:   node-rig.ts — Better Auth handler·auth.api 를 바로 (서버 앞 판정 없이)
//   apps/server 네 DB:     apps/server/test/signup/env.ts — 서버 앱(createApp + buildServices) 전체
//   apps/server D1:        apps/server/test/signup/worker.ts — 같은 서버 앱을 wrangler dev 시험 Worker 에서
// 그래서 같은 단언이 다섯 DB 에서 같은 관찰을 요구한다. 이 파일은 Workers 에서도 import 된다 (Node 전용 모듈을 쓰지 않는다).
import { hashPassword } from "better-auth/crypto";
import { and, eq, like, sql } from "drizzle-orm";
import type { MailMessage } from "../../src/index.ts";

type AnyDb = any;
type Schema = any;

/** 응답 하나. code 는 서버(app.ts)의 error 또는 Better Auth 의 code 를 소문자로 맞춘 것 */
export interface Reply {
  status: number;
  code: string | null;
  /** 응답 본문 그대로 (바이트 비교용) */
  body: string;
}

export interface Invite {
  inviteId: string;
  role: "member" | "admin";
  email: string | null;
  verified: boolean;
}

export interface Rig {
  label: string;
  /** 공개 HTTP 가입 POST /api/auth/sign-up/email. 요청마다 다른 IP (ip 를 주면 그 IP) */
  signUp(body: Record<string, unknown>, o?: { ip?: string; headers?: Record<string, string> }): Promise<Reply>;
  /** 서버 안 호출 auth.api.signUpEmail. invite 를 주면 runAsInvite 안에서 */
  apiSignUp(body: Record<string, unknown>, invite?: Invite): Promise<Reply>;
  /** OAuth·SSO JIT 가 부르는 internalAdapter.createUser·createOAuthUser 를 바로 */
  internalCreate(fn: "createUser" | "createOAuthUser", email: string): Promise<Reply>;
  /** 공개 HTTP 요청 아무거나 (/api/auth/* 의 경로) */
  request(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply>;
  op<K extends OpName>(name: K, ...args: OpArgs<K>): Promise<OpResult<K>>;
  /** 지금까지 보낸 메일 (응답과 떼어 보낸 전송이 끝난 뒤) */
  outbox(): Promise<MailMessage[]>;
  /** auth.api 의 경로 목록 (경로가 없는 서버 전용 엔드포인트는 "(server) <이름>") */
  apiPaths(): Promise<string[]>;
}

/** 응답을 Reply 로 */
export async function reply(res: Response): Promise<Reply> {
  const body = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(body);
  } catch {}
  const code = typeof json?.error === "string" ? json.error : typeof json?.code === "string" ? json.code : null;
  return { status: res.status, code: code?.toLowerCase() ?? null, body };
}

/** auth.api 호출의 결과·APIError 를 Reply 로 */
export async function apiReply(p: Promise<unknown>): Promise<Reply> {
  try {
    const r = await p;
    return { status: 200, code: null, body: JSON.stringify(r ?? null) };
  } catch (e: any) {
    const code = e?.body?.code;
    return { status: Number(e?.statusCode ?? 500), code: typeof code === "string" ? code.toLowerCase() : null, body: JSON.stringify(e?.body ?? null) };
  }
}

const byEmail = (s: Schema, email: string) => eq(s.user.email, email.toLowerCase());

async function upsertSetting(db: AnyDb, s: Schema, key: string, value: unknown) {
  await db.delete(s.appSettings).where(eq(s.appSettings.key, key));
  if (value !== undefined) await db.insert(s.appSettings).values({ key, value: JSON.stringify(value), updatedAt: new Date(), updatedBy: null });
}

/** 시험이 부르는 DB 동작. 값은 JSON 으로 오가므로 DB 마다 다른 표현(0/1, "5.000000")을 여기서 맞춘다 */
export const OPS = {
  /** user·account·verification·session 행 수 */
  async rows(db: AnyDb, s: Schema) {
    const n = async (t: any) => (await db.select({ id: t.id }).from(t)).length;
    return { user: await n(s.user), account: await n(s.account), verification: await n(s.verification), session: await n(s.session) };
  },
  /** user 행 수만 (다른 표 이름을 바꿔 둔 시험에서도 센다) */
  async userCount(db: AnyDb, s: Schema) {
    return (await db.select({ id: s.user.id }).from(s.user)).length;
  },
  /** 설치가 끝난 상태 (관리자 한 명) */
  async addAdmin(db: AnyDb, s: Schema) {
    const now = new Date();
    const id = crypto.randomUUID();
    await db.insert(s.user).values({ id, name: "admin", email: `admin-${id}@example.test`, emailVerified: true, role: "admin", createdAt: now, updatedAt: now });
    return id;
  },
  /** app_settings 한 행을 검사 없이 바로 넣는다 (undefined 면 지운다). 설정 API 가 만들지 않는 상태도 만든다 */
  async setSetting(db: AnyDb, s: Schema, key: string, value?: unknown) {
    await upsertSetting(db, s, key, value);
  },
  /** 메일 설정 행 (Q15 "메일 설정됨" = 이 행이 있다). 값은 쓰지 않는다 (시험 메일러가 보낸다) */
  async setMail(db: AnyDb, s: Schema, on: boolean) {
    await upsertSetting(db, s, "mail_settings", on ? { provider: "resend", from: "noreply@example.test", apiKey: "v1:test-not-used" } : undefined);
  },
  async user(db: AnyDb, s: Schema, email: string) {
    const [r] = await db.select().from(s.user).where(byEmail(s, email));
    if (!r) return null;
    return {
      id: r.id as string,
      role: r.role as string,
      status: r.status as string,
      emailVerified: Boolean(r.emailVerified),
      monthlyLimitUsd: r.monthlyLimitUsd === null ? null : Number(r.monthlyLimitUsd),
      maxKeys: r.maxKeys === null ? null : Number(r.maxKeys),
    };
  },
  /** 공개 가입 하루 세기 칸(rate_limit signup-day|*)의 값 합 */
  async signupCount(db: AnyDb, s: Schema) {
    const rows = await db.select({ count: s.rateLimit.count }).from(s.rateLimit).where(like(s.rateLimit.key, "signup-day|%"));
    return rows.reduce((n: number, r: { count: number }) => n + Number(r.count), 0);
  },
  /** 그 action 의 감사 기록 행 수 */
  async audits(db: AnyDb, s: Schema, action: string) {
    return (await db.select({ id: s.auditLog.id }).from(s.auditLog).where(eq(s.auditLog.action, action))).length;
  },
  /** 비밀번호로 로그인할 수 있는 회원 (credential 계정까지). 관리자·정지 회원을 만든다 */
  async addPasswordUser(db: AnyDb, s: Schema, email: string, password: string, role: "member" | "admin", status: "active" | "suspended" | "pending" = "active") {
    const now = new Date();
    const id = crypto.randomUUID();
    await db.insert(s.user).values({ id, name: "회원", email: email.toLowerCase(), emailVerified: true, role, status, monthlyLimitUsd: 5, createdAt: now, updatedAt: now });
    await db.insert(s.account).values({ id: crypto.randomUUID(), accountId: id, providerId: "credential", userId: id, password: await hashPassword(password), createdAt: now, updatedAt: now });
    return id;
  },
  async verify(db: AnyDb, s: Schema, email: string) {
    await db.update(s.user).set({ emailVerified: true }).where(byEmail(s, email));
  },
  /** 표 이름 바꾸기. 그 표에 쓰는 문장을 실행 중에 실패시킨다 (되돌리기 시험) */
  async renameTable(db: AnyDb, _s: Schema, from: string, to: string) {
    const q = sql.raw(`ALTER TABLE ${from} RENAME TO ${to}`);
    await (typeof db.run === "function" ? db.run(q) : db.execute(q));
  },
  /** 새 날: 하루 가입 수 칸·상한 알림 칸과 상한 알림 기록을 지운다 (날짜가 바뀐 것과 같은 상태) */
  async newDay(db: AnyDb, s: Schema) {
    await db.delete(s.rateLimit).where(like(s.rateLimit.key, "signup-%"));
    await db.delete(s.auditLog).where(eq(s.auditLog.action, "alert.signup_cap"));
  },
  /** 회원 행을 지운다 (account·session 도). 다음 단언의 행 수를 0 에서 다시 센다 */
  async deleteMembers(db: AnyDb, s: Schema) {
    const members = await db.select({ id: s.user.id }).from(s.user).where(eq(s.user.role, "member"));
    for (const { id } of members) {
      await db.delete(s.session).where(eq(s.session.userId, id));
      await db.delete(s.account).where(eq(s.account.userId, id));
      await db.delete(s.user).where(and(eq(s.user.id, id), eq(s.user.role, "member")));
    }
  },
};

export type OpName = keyof typeof OPS;
export type OpResult<K extends OpName> = Awaited<ReturnType<(typeof OPS)[K]>>;
export type OpArgs<K extends OpName> = (typeof OPS)[K] extends (db: any, s: any, ...a: infer A) => any ? A : never;

/** 회원 행 수 */
export const userRows = (rig: Rig) => rig.op("userCount");

let seq = 0;
/** 겹치지 않는 이메일. 기본 도메인은 example.test */
export const mail = (tag: string, domain = "example.test") => `${tag}-${Date.now().toString(36)}-${seq++}@${domain}`;
export const PASSWORD = "correct-horse-battery-staple";
export const body = (email: string, extra: Record<string, unknown> = {}) => ({ email, password: PASSWORD, name: "가입자", ...extra });

/** 가입 하나의 결과와 생긴 행·메일 수 */
export async function attempt(rig: Rig, run: () => Promise<Reply>) {
  const r0 = await rig.op("rows");
  const m0 = (await rig.outbox()).length;
  const r = await run();
  const r1 = await rig.op("rows");
  const m1 = (await rig.outbox()).length;
  return { ...r, user: r1.user - r0.user, account: r1.account - r0.account, verification: r1.verification - r0.verification, mail: m1 - m0 };
}
