// 3단계 확인 항목 V29~V31 의 시험 구성 (M0). 지금 구성(authOptions)에 훅 하나만 바꿔 끼운 Better Auth 를 만든다.
// Node 네 DB 시험(packages/auth/test/verify-p3/*.test.ts)과 D1 시험 Worker(apps/server/test/verify-p3/worker.ts)가 같은 함수를 쓴다.
// 그래서 이 파일과 ops.ts 는 Workers 에서도 import 된다. Node 전용 모듈은 node:async_hooks(nodejs_compat)만 쓴다.
import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { authOptions, type AuthConfig } from "../../src/index.ts";
import { withClientIp } from "../../src/rate-limit.ts";
import { accountOfUser, statusOf, userById, deleteSession } from "./ops.ts";

/**
 * 앱 쪽 초대 문맥 (V29 (마)). 3단계 초대 수락이 als.run({ inviteId }, () => auth.api.signUpEmail(...)) 으로 넘길 값의 자리다.
 * 공개 HTTP 요청은 이 값을 만들 길이 없어야 한다 (본문·헤더를 읽지 않는다).
 */
export const inviteContext = new AsyncLocalStorage<{ inviteId: string }>();

/** 훅이 본 것. 시험이 /sign-up 한 번마다 읽고 비운다 */
export type HookLog =
  | { at: "before"; path: string; email: string | null; inviteId: string | null }
  | { at: "create.before"; email: string; inviteId: string | null }
  | { at: "create.after"; email: string; inviteId: string | null; userVisible: boolean; accountVisible: boolean }
  | { at: "sendVerificationEmail"; email: string; emailVerified: boolean };

/**
 * 시험 구성 이름.
 *   plain              지금 구성 그대로 (createAuth 와 같은 옵션)
 *   before403          hooks.before 가 /sign-up/email 에서 APIError(403) — V29 (가)
 *   create403·create400 user.create.before 가 APIError(403·400) — V29 (나)·(다)
 *   createData         user.create.before 가 { data: { emailVerified: true, status: "pending", monthlyLimitUsd: 5 } } — V29 (라)
 *   als                hooks.before·user.create.before·user.create.after 가 초대 문맥과 커밋 여부를 기록만 한다 — V29 (마)
 *   resetRevoke        revokeSessionsOnPasswordReset: true — V30
 *   sessionGuard       session.create.before 가 status suspended·pending 회원을 APIError(403, account_*) 로 거부 — V31
 *   sessionAfterDelete session.create.after 가 방금 만든 세션 행을 지운다 — V31
 */
export const SCENARIOS = ["plain", "before403", "create403", "create400", "createData", "als", "resetRevoke", "sessionGuard", "sessionAfterDelete"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const HOOK_DATA = { emailVerified: true, status: "pending", monthlyLimitUsd: 5 } as const;

const inviteId = () => inviteContext.getStore()?.inviteId ?? null;

// 초대 문맥 호출을 hooks.before 에서 잡아 두는 자리 (concurrentSignUps). 잡혀 있는 동안 공개 요청 하나가 처음부터 끝까지 돈다
const holds = new Map<string, Promise<void>>();

/**
 * transaction: false 는 Better Auth 의 대화형 트랜잭션을 끈다. D1 은 대화형 트랜잭션이 없어 지금 구성(transaction: true)으로는
 * 가입이 drizzle 의 "begin" 에서 500 이다 (V29 d1Transaction). D1 시험 Worker 는 이 값을 끄고 나머지를 잰다.
 */
export function probeOptions(cfg: AuthConfig, scenario: Scenario, log: HookLog[], { transaction = true }: { transaction?: boolean } = {}) {
  const base = authOptions(cfg);
  const { db, schema } = cfg.database as { db: any; schema: any };
  const userCreate = base.databaseHooks.user.create;
  const opts: BetterAuthOptions = { ...base, databaseHooks: { ...base.databaseHooks } };
  if (!transaction) opts.database = drizzleAdapter(db, { provider: cfg.database.provider, schema, transaction: false });
  switch (scenario) {
    case "plain":
      break;
    case "before403":
      opts.hooks = {
        before: createAuthMiddleware(async (ctx) => {
          if (ctx.path === "/sign-up/email") throw new APIError("FORBIDDEN", { code: "PROBE_REJECT", message: "probe_reject" });
        }),
      };
      break;
    case "create403":
    case "create400":
      opts.databaseHooks = {
        user: {
          create: {
            before: async () => {
              throw new APIError(scenario === "create403" ? "FORBIDDEN" : "BAD_REQUEST", { code: "PROBE_REJECT", message: "probe_reject" });
            },
          },
        },
      };
      break;
    case "createData":
      opts.databaseHooks = { user: { create: { before: async (user) => ({ data: { ...user, ...HOOK_DATA } }) } } };
      // 발송기가 받는 user 를 기록하고 원래 발송기로 넘긴다
      opts.emailVerification = {
        ...base.emailVerification,
        sendVerificationEmail: async (data) => {
          log.push({ at: "sendVerificationEmail", email: data.user.email, emailVerified: Boolean(data.user.emailVerified) });
          return base.emailVerification.sendVerificationEmail(data);
        },
      };
      break;
    case "als":
      opts.hooks = {
        before: createAuthMiddleware(async (ctx) => {
          if (!ctx.path.startsWith("/sign-up")) return;
          const id = inviteId();
          log.push({ at: "before", path: ctx.path, email: typeof ctx.body?.email === "string" ? ctx.body.email : null, inviteId: id });
          const hold = id ? holds.get(id) : undefined;
          if (hold) await hold;
        }),
      };
      opts.databaseHooks = {
        user: {
          create: {
            before: async (user) => {
              log.push({ at: "create.before", email: String(user.email), inviteId: inviteId() });
              return userCreate.before(user);
            },
            // 가입 트랜잭션 밖의 연결(cfg.database.db)로 읽는다. 커밋 뒤라면 user 와, 같은 트랜잭션에서 뒤에 넣은 credential account 가 보인다
            after: async (user) => {
              log.push({
                at: "create.after",
                email: String(user.email),
                inviteId: inviteId(),
                userVisible: (await userById(db, schema, user.id)) !== undefined,
                accountVisible: (await accountOfUser(db, schema, user.id)) !== undefined,
              });
            },
          },
        },
      };
      break;
    case "resetRevoke":
      opts.emailAndPassword = { ...base.emailAndPassword, revokeSessionsOnPasswordReset: true };
      break;
    case "sessionGuard":
      opts.databaseHooks = {
        ...opts.databaseHooks,
        session: {
          create: {
            before: async (session) => {
              const status = await statusOf(db, schema, session.userId);
              if (status === "suspended" || status === "pending") throw new APIError("FORBIDDEN", { code: `account_${status}`, message: `account_${status}` });
            },
          },
        },
      };
      break;
    case "sessionAfterDelete":
      opts.databaseHooks = { ...opts.databaseHooks, session: { create: { after: async (session) => void (await deleteSession(db, schema, session.id)) } } };
      break;
  }
  return opts;
}

/** 시험 구성 하나의 인증 인스턴스. 운영 createAuth 와 같이 handler 는 클라이언트 IP 머리글을 붙여 감싼다 */
export function probeAuth(cfg: AuthConfig, scenario: Scenario, log: HookLog[], o: { transaction?: boolean } = {}) {
  const auth = betterAuth(probeOptions(cfg, scenario, log, o));
  return { handler: withClientIp(auth.handler, cfg.clientIp), api: auth.api, options: auth.options };
}

/** auth.api.signUpEmail 를 초대 문맥 안에서 부른다. 거부는 { status, code } 로 돌려준다 */
async function apiSignUp(api: { signUpEmail: (a: any) => Promise<any> }, body: Record<string, unknown>, invite: string) {
  try {
    await inviteContext.run({ inviteId: invite }, () => api.signUpEmail({ body }));
    return { status: 200, code: null };
  } catch (e: any) {
    return { status: Number(e?.statusCode ?? 500), code: (e?.body?.code as string) ?? null };
  }
}

/**
 * 초대 문맥 안의 서버 호출 auth.api.signUpEmail 과 공개 HTTP 가입을 같은 시각에 돌린다 (V29 (마)).
 * 서버 호출은 hooks.before 에서 공개 요청이 끝날 때까지 기다린다. 그래서 공개 요청 전체가 초대 문맥이 열려 있는 동안 돈다.
 * 두 가입의 트랜잭션은 겹치지 않는다 (Node SQLite 는 동시 가입 트랜잭션이 SQLITE_BUSY 로 깨진다, V29 sqliteConcurrentSignUp).
 */
export async function concurrentSignUps(auth: ReturnType<typeof probeAuth>, baseURL: string, invited: Record<string, unknown>, publicBody: Record<string, unknown>) {
  const id = `inv-${crypto.randomUUID()}`;
  let release!: () => void;
  holds.set(id, new Promise<void>((r) => (release = r)));
  const req = new Request(`${baseURL}/api/auth/sign-up/email`, { method: "POST", headers: { origin: baseURL, "content-type": "application/json" }, body: JSON.stringify(publicBody) });
  const pub = auth.handler(req).then(
    (r) => r.status,
    () => 500,
  );
  const [api, publicStatus] = await Promise.all([apiSignUp(auth.api, invited, id), pub.finally(() => release())]);
  holds.delete(id);
  return { api, publicStatus, inviteId: id };
}
