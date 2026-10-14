// Better Auth 1.7.7 DBAdapter의 바깥 계약은 canonical model/field 이름이다.
// factory 안에서만 modelName/fieldName을 바꾸므로 wrapper는 user/account + camelCase를 받고,
// 직접 쓰기는 cfg.database.schema의 Drizzle 칼럼(방언별 물리 이름 mapping)을 사용한다.
import { tryGetCurrentAuthEndpointContext } from "@better-auth/core/context";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { AUTH_VERSION_MAX } from "@magnetosphere/db/src/schema/common.ts";
import { activeAuthUser, aliveAuthUser, validAuthVersion } from "./auth-version.ts";
import type { AuthConfig } from "./index.ts";

const RESET = Symbol("reset-credential-snapshot");
const OBSERVED = Symbol("observed-auth-version");
type ResetSnapshot = { id: string; version?: number; writtenVersion?: number };
export const invalidReset = () => new APIError("BAD_REQUEST", { code: "INVALID_TOKEN", message: "Invalid token" });
const staleChange = () => new APIError("UNAUTHORIZED", { code: "INVALID_EMAIL_OR_PASSWORD", message: "다시 로그인해 주세요" });
const failedWrite = () => new APIError("INTERNAL_SERVER_ERROR", { code: "PASSWORD_WRITE_FAILED", message: "비밀번호를 저장하지 못했어요" });
function endpointContext(): any {
  return tryGetCurrentAuthEndpointContext()?.context ?? null;
}
function resetContext(): any {
  const ctx = tryGetCurrentAuthEndpointContext();
  return ctx?.path === "/reset-password" ? ctx.context : null;
}
function rememberUser(candidate: any): void {
  const context = endpointContext();
  if (!context) return;
  const observed = context[OBSERVED];
  // 조회 단계에서는 계정 존재/비밀번호 검증 전 응답을 바꾸지 않는다.
  // 잘못된 Map은 복구하거나 덮어쓰지 않는다. 소비 경계가 snapshot 없음으로 거부한다.
  if (observed !== undefined && !(observed instanceof Map)) return;
  const id = candidate?.id;
  if (typeof id !== "string") return;
  const versions = observed ?? new Map<string, unknown>();
  if (!observed) context[OBSERVED] = versions;
  // invalid version도 최초 값 그대로 보존한다. 다음 조회의 정상 값으로 보정하지 않는다.
  if (!versions.has(id)) versions.set(id, candidate.authVersion);
}
export function observedAuthVersion(id: string): number | undefined {
  const observed = endpointContext()?.[OBSERVED];
  const version: unknown = observed instanceof Map ? observed.get(id) : undefined;
  // email은 core password.verify 뒤 sessionBefore, OAuth도 sessionBefore에서 fail-closed.
  return validAuthVersion(version) ? version : undefined;
}

export interface CredentialWrite {
  userId: string;
  version: number;
  password: string;
  // reset은 SDK가 넘긴 account create/updateMany만 실행한다. change는 현재 credential·session CAS다.
  mode: "reset-create" | "reset-update" | "change";
  account?: any;
  session?: any;
  fingerprint?: string;
  rotate?: boolean;
  data?: Record<string, any>;
}

/** token consume/hash는 이 트랜잭션 밖이다. 외부 auth.api를 DB transaction으로 감싸지 않는다. */
export function credentialWriter(cfg: AuthConfig) {
  const { db, schema, provider, kind } = cfg.database as any;
  const u = schema.user, a = schema.account, s = schema.session, v = schema.verification;
  const credential = (id: string) => and(eq(a.userId, id), eq(a.providerId, "credential"), eq(a.accountId, id));
  const affected = async (query: any, column: any) => provider === "mysql" ? (await query)[0].affectedRows : (await query.returning({ id: column })).length;
  const sameHash = (password: string) => provider === "mysql" ? sql`binary ${a.password} = binary ${password}` : eq(a.password, password);
  const existsCredential = (w: CredentialWrite) => sql`exists (select 1 from ${a} where ${credential(w.userId)} and ${a.id} = ${w.account.id} and ${sameHash(w.account.password)})`;
  const existsSession = (w: CredentialWrite) => sql`exists (select 1 from ${s} where ${s.id} = ${w.session.id} and ${s.userId} = ${w.userId} and ${s.token} = ${w.session.token} and ${s.authVersion} = ${w.version} and ${s.expiresAt} > ${new Date()})`;
  const userWhere = (w: CredentialWrite) => and(eq(u.id, w.userId), eq(u.authVersion, w.version), lt(u.authVersion, AUTH_VERSION_MAX), isNull(u.deletedAt), w.mode === "change" ? and(eq(u.status, "active"), eq(u.emailVerified, true), existsCredential(w), existsSession(w)) : inArray(u.status, ["pending", "active"]));
  const accountData = (w: CredentialWrite) => ({
    id: typeof w.data?.id === "string" ? w.data.id : crypto.randomUUID(),
    userId: w.userId, accountId: w.userId, providerId: "credential", password: w.password,
    createdAt: w.data?.createdAt instanceof Date ? w.data.createdAt : new Date(), updatedAt: new Date(),
  });
  const sessionWhere = (w: CredentialWrite) => and(eq(s.id, w.session.id), eq(s.token, w.session.token), eq(s.userId, w.userId), eq(s.authVersion, w.version));

  return async (w: CredentialWrite): Promise<number> => {
    const stale = w.mode === "change" ? staleChange : invalidReset;
    if (!validAuthVersion(w.version) || w.version === AUTH_VERSION_MAX) throw stale();
    try {
      if (kind === "d1") {
        // verification.valueはNOT NULL。INSERTなので対象user消失時も必ず評価される。
        // 実tokenのnamespaceと重ならず、valueは固定非秘密値。SDKのconsumeはidentifier完全一致。
        // 成功時は今回の正確なidだけ消す。失敗はbatch全体rollbackでguardを残さない。
        const guardIds: string[] = [];
        const guard = () => {
          const id = crypto.randomUUID();
          guardIds.push(id);
          const now = new Date();
          return db.insert(v).values({ id, identifier: `magnetosphere:auth-write-guard:${id}`, value: sql`case when changes() = 1 then 'internal-guard' else null end`, expiresAt: now, createdAt: now, updatedAt: now });
        };
        const nextUser = sql`exists (select 1 from ${u} where ${u.id} = ${w.userId} and ${u.authVersion} = ${w.version + 1} and ${u.deletedAt} is null and ${w.mode === "change" ? sql`${u.status} = 'active' and ${u.emailVerified} = 1` : sql`${u.status} in ('pending', 'active')`})`;
        const statements: any[] = [db.update(u).set({ authVersion: sql`${u.authVersion} + 1`, updatedAt: new Date() }).where(userWhere(w)), guard()];
        if (w.mode === "reset-create") {
          const data = accountData(w);
          // Drizzle insert.values에SQL 조건을 붙일 수 없어INSERT SELECT를 사용한다. 날짜는timestamp_ms다(D1).
          statements.push(db.run(sql`insert into ${a} (${sql.identifier(a.id.name)}, ${sql.identifier(a.userId.name)}, ${sql.identifier(a.accountId.name)}, ${sql.identifier(a.providerId.name)}, ${sql.identifier(a.password.name)}, ${sql.identifier(a.createdAt.name)}, ${sql.identifier(a.updatedAt.name)}) select ${data.id}, ${w.userId}, ${w.userId}, 'credential', ${w.password}, ${data.createdAt.getTime()}, ${data.updatedAt.getTime()} where ${nextUser} and not exists (select 1 from ${a} where ${credential(w.userId)})`));
        } else {
          statements.push(db.update(a).set({ password: w.password, updatedAt: new Date() }).where(and(credential(w.userId), nextUser, w.mode === "change" ? and(eq(a.id, w.account.id), sameHash(w.account.password)) : undefined)));
        }
        statements.push(guard()); // account 0行・複数行でもcoreの200/onPasswordResetまで進まない。
        if (w.mode === "change" && !w.rotate) {
          statements.push(db.update(s).set({ authVersion: w.version + 1, credentialFingerprint: w.fingerprint, updatedAt: new Date() }).where(and(sessionWhere(w), nextUser)), guard());
          statements.push(db.delete(s).where(and(eq(s.userId, w.userId), sql`${s.id} <> ${w.session.id}`)));
        } else statements.push(db.delete(s).where(eq(s.userId, w.userId)));
        statements.push(db.delete(v).where(inArray(v.id, guardIds)));
        await db.batch(statements);
      } else {
        await db.transaction(async (tx: any) => {
          // Nodeの最初の行lockはuser。account→sessionへ進み、会員管理mutexは取らない。
          let select = tx.select().from(u).where(eq(u.id, w.userId)).limit(1);
          if (provider === "sqlite") {
            // SQLiteは行lockがない。最初のuser条件UPDATEでwrite lockを確保する（版はまだ増やさない）。
            if (await affected(tx.update(u).set({ authVersion: sql`${u.authVersion}` }).where(userWhere(w)), u.id) !== 1) throw stale();
          } else select = select.for("update");
          const [user] = await select;
          if (!(w.mode === "change" ? activeAuthUser(user) : aliveAuthUser(user)) || user.authVersion !== w.version) throw stale();
          let accounts = tx.select().from(a).where(credential(w.userId));
          if (provider !== "sqlite") accounts = accounts.for("update");
          const rows = await accounts;
          if (w.mode === "reset-create" ? rows.length !== 0 : rows.length !== 1) throw stale();
          if (w.mode === "change") {
            if (rows[0].id !== w.account.id || rows[0].password !== w.account.password) throw stale();
            let sessions = tx.select().from(s).where(sessionWhere(w)).limit(1);
            if (provider !== "sqlite") sessions = sessions.for("update");
            const [current] = await sessions;
            if (!current || !validAuthVersion(current.authVersion) || current.expiresAt <= new Date()) throw stale();
          }
          if (w.mode === "reset-create") await tx.insert(a).values(accountData(w));
          else if (await affected(tx.update(a).set({ password: w.password, updatedAt: new Date() }).where(and(credential(w.userId), w.mode === "change" ? and(eq(a.id, w.account.id), sameHash(w.account.password)) : undefined)), a.id) !== 1) throw stale();
          if (await affected(tx.update(u).set({ authVersion: sql`${u.authVersion} + 1`, updatedAt: new Date() }).where(and(eq(u.id, w.userId), eq(u.authVersion, w.version), lt(u.authVersion, AUTH_VERSION_MAX), isNull(u.deletedAt), w.mode === "change" ? eq(u.status, "active") : inArray(u.status, ["pending", "active"]))), u.id) !== 1) throw stale();
          if (w.mode === "change" && !w.rotate) {
            if (await affected(tx.update(s).set({ authVersion: w.version + 1, credentialFingerprint: w.fingerprint, updatedAt: new Date() }).where(sessionWhere(w)), s.id) !== 1) throw stale();
            await tx.delete(s).where(and(eq(s.userId, w.userId), sql`${s.id} <> ${w.session.id}`));
          } else await tx.delete(s).where(eq(s.userId, w.userId));
        }, provider === "sqlite" ? undefined : { isolationLevel: "read committed" });
      }
    } catch (error) {
      if (error instanceof APIError) throw error;
      // 制約失敗を含めquery/params/cause/hashをlogger・応答へ渡さない。
      // D1 guard失敗はstale reset/changeとして閉じる。その他DB故障も固定APIError。
      if (kind === "d1") throw stale();
      throw failedWrite();
    }
    return w.version + 1;
  };
}

export function safeResetAdapter(cfg: AuthConfig) {
  const base = drizzleAdapter(cfg.database.db, { provider: cfg.database.provider, schema: cfg.database.schema, transaction: cfg.database.kind !== "d1" });
  const write = credentialWriter(cfg);
  return (options: any) => {
    const wrap = (adapter: any, inTransaction = false): any => ({
      ...adapter,
      // consumeの短いtransaction内でもchild factoryにwrapperを再適用する。
      transaction: (callback: any) => adapter.transaction((child: any) => callback(wrap(child, true))),
      consumeOne: async (input: any) => {
        const row = await adapter.consumeOne(input);
        const ctx = resetContext();
        if (ctx && input.model === "verification" && row?.expiresAt > new Date() && typeof row.value === "string" && typeof row.identifier === "string" && row.identifier.startsWith("reset-password:")) ctx[RESET] = { id: row.value } satisfies ResetSnapshot;
        return row;
      },
      findOne: async (input: any) => {
        const row = await adapter.findOne(input);
        const snapshot: ResetSnapshot | undefined = resetContext()?.[RESET];
        if (snapshot && snapshot.version === undefined && input.model === "user" && input.where?.length === 1 && input.where[0].field === "id" && input.where[0].value === snapshot.id) {
          if (!aliveAuthUser(row)) throw invalidReset();
          snapshot.version = row.authVersion;
        }
        // findUserById와 findUserByEmail(account join 포함)의 user다. join된 account id와 섞지 않는다.
        if (!snapshot && input.model === "user" && row) rememberUser(input.join ? (({ account, ...user }) => user)(row) : row);
        return row;
      },
      findMany: async (input: any) => {
        const rows = await adapter.findMany(input);
        // findAccountOwnerByKey: account findMany + user join. account.id가 아니라 join된 user.id다.
        if (input.model === "account" && input.join?.user) for (const row of rows) if (row?.user) rememberUser(row.user);
        return rows;
      },
      create: async (input: any) => {
        if (input.model === "user") {
          const created = await adapter.create(input);
          rememberUser(created);
          return created;
        }
        const ctx = resetContext();
        if (!ctx || input.model !== "account") return adapter.create(input);
        const snapshot: ResetSnapshot | undefined = ctx[RESET];
        const data = input.data;
        if (inTransaction || !snapshot || snapshot.writtenVersion !== undefined || !validAuthVersion(snapshot.version) || data?.userId !== snapshot.id || data?.accountId !== snapshot.id || data?.providerId !== "credential" || typeof data?.password !== "string" || Object.keys(data).some((key) => !["id", "userId", "accountId", "providerId", "password", "createdAt", "updatedAt"].includes(key))) throw invalidReset();
        const id = typeof data.id === "string" && input.forceAllowId ? data.id : crypto.randomUUID();
        snapshot.writtenVersion = await write({ userId: snapshot.id, version: snapshot.version, password: data.password, mode: "reset-create", data: { ...data, id } });
        const result = { ...data, id };
        return input.select ? Object.fromEntries(input.select.map((field: string) => [field, result[field]])) : result;
      },
      updateMany: async (input: any) => {
        const ctx = resetContext();
        if (!ctx || input.model !== "account") return adapter.updateMany(input);
        const snapshot: ResetSnapshot | undefined = ctx[RESET];
        const expected = { userId: snapshot?.id, providerId: "credential", accountId: snapshot?.id };
        if (inTransaction || !snapshot || snapshot.writtenVersion !== undefined || !validAuthVersion(snapshot.version) || input.where?.length !== 3 || input.where.some((condition: any) => !Object.hasOwn(expected, condition.field) || condition.value !== expected[condition.field as keyof typeof expected] || (condition.operator && condition.operator !== "eq") || (condition.connector && condition.connector !== "AND")) || new Set(input.where.map((condition: any) => condition.field)).size !== 3 || typeof input.update?.password !== "string" || Object.keys(input.update).some((key) => !["password", "updatedAt"].includes(key))) throw invalidReset();
        snapshot.writtenVersion = await write({ userId: snapshot.id, version: snapshot.version, password: input.update.password, mode: "reset-update" });
        return 1;
      },
    });
    return wrap(base(options));
  };
}

/** reset成功の同じ要求・増加済みversionだけで認証する。状態/削除は書き戻さない。 */
export async function confirmResetEmail(cfg: AuthConfig, userId: string): Promise<void> {
  const snapshot: ResetSnapshot | undefined = resetContext()?.[RESET];
  if (!snapshot || snapshot.id !== userId || !validAuthVersion(snapshot.writtenVersion)) throw invalidReset();
  const { db, schema } = cfg.database as any;
  const u = schema.user;
  await db.update(u).set({ emailVerified: true, updatedAt: new Date() }).where(and(eq(u.id, userId), eq(u.authVersion, snapshot.writtenVersion), eq(u.role, "member"), inArray(u.signupOrigin, ["public", "legacy", "invite"]), inArray(u.status, ["pending", "active"]), isNull(u.deletedAt)));
}
