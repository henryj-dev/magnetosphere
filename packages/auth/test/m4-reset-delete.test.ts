// token consume→user snapshot→hash→credential writeの実SDK順序をbarrierで固定する。試験の実行は別承認。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { authOptions, createAuth } from "../src/index.ts";
import { AUTH_VERSION_MAX } from "@magnetosphere/db/src/schema/common.ts";
import { OPEN, type TestDb } from "./db.ts";
import { makeAuthConfig } from "./helpers.ts";
import { apiReply, mail, OPS, PASSWORD } from "./signup-policy/rig.ts";

const kinds = (process.env.MG_TEST_DBS ?? "sqlite").split(",") as (keyof typeof OPEN)[];
const BASE = "http://localhost:3000";
function barrier() {
  let arrive!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  const resumed = new Promise<void>((resolve) => { release = resolve; });
  return { reached, release, wait: async () => { arrive(); await resumed; } };
}

describe.each(kinds)("%s M4.T4 reset/delete", (kind) => {
  let h: TestDb, cfg: ReturnType<typeof makeAuthConfig>, auth: ReturnType<typeof createAuth>;
  const api = () => auth.api as any;
  const settle = async () => { while (cfg.pending.length) await Promise.all(cfg.pending.splice(0)); };
  const add = async (tag: string) => {
    const email = mail(`m4-reset-${tag}`);
    return { email, id: await OPS.addPasswordUser(h.db, h.schema, email, PASSWORD, "member") };
  };
  const tokenFor = async (email: string) => {
    await api().requestPasswordReset({ body: { email } }); await settle();
    const message = cfg.outbox.filter((value) => value.to === email && value.text.includes("/reset-password/")).at(-1)!;
    return new URL(message.text.match(/https?:\/\/\S+/)![0]).pathname.split("/").at(-1)!;
  };
  const rows = async (table: any, id: string) => h.db.select().from(table).where(eq(table.userId, id));
  const user = async (id: string) => (await h.db.select().from((h.schema as any).user).where(eq((h.schema as any).user.id, id)))[0];
  beforeAll(async () => { h = await OPEN[kind](); cfg = makeAuthConfig(h); auth = createAuth(cfg); });
  afterAll(async () => { await settle(); await h?.close(); vi.restoreAllMocks(); });

  for (const missingAccount of [false, true]) {
    it(`M4.T4.reset-delete: consume/hash 일시정지 뒤 삭제는 credential ${missingAccount ? "INSERT" : "UPDATE"}를 막는다`, async () => {
      const x = await add(`deleted-${missingAccount}`), s = h.schema as any;
      await api().signInEmail({ body: { email: x.email, password: PASSWORD } });
      if (missingAccount) await h.db.delete(s.account).where(eq(s.account.userId, x.id));
      const token = await tokenFor(x.email), pause = barrier();
      const options = authOptions(cfg), hashes: string[] = [];
      (options.emailAndPassword as any).password = { hash: async (password: string) => { const hash = await hashPassword(password); hashes.push(hash); await pause.wait(); return hash; }, verify: verifyPassword };
      const onReset = vi.fn(options.emailAndPassword.onPasswordReset);
      options.emailAndPassword.onPasswordReset = onReset;
      const instance = betterAuth(options), errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const pending = instance.handler(new Request(`${BASE}/api/auth/reset-password`, { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ token, newPassword: "reset-after-delete-password-123" }) }));
      await pause.reached;
      try {
        // consumedtoken後にuserが読まれた時点のsnapshotが保存済み。削除と同じuser-first順序。
        expect(await h.db.select().from(s.verification).where(eq(s.verification.identifier, `reset-password:${token}`))).toHaveLength(0);
        await h.db.transaction(async (tx: any) => {
          let query = tx.select().from(s.user).where(eq(s.user.id, x.id));
          if (h.provider !== "sqlite") query = query.for("update");
          await query;
          await tx.update(s.user).set({ status: "deleted", deletedAt: new Date(), email: `deleted-${x.id}@invalid.test`, name: "deleted", authVersion: sql`${s.user.authVersion} + 1` }).where(eq(s.user.id, x.id));
          await tx.delete(s.account).where(eq(s.account.userId, x.id));
          await tx.delete(s.session).where(eq(s.session.userId, x.id));
        });
      } finally { pause.release(); }
      try {
        const response = await pending;
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(JSON.parse(text).code).toBe("INVALID_TOKEN");
        expect(response.headers.getSetCookie()).toEqual([]);
        expect(onReset).not.toHaveBeenCalled();
        expect(await rows(s.account, x.id)).toHaveLength(0);
        expect(await rows(s.session, x.id)).toHaveLength(0);
        expect((await user(x.id)).authVersion).toBe(1);
        expect((await user(x.id)).status).toBe("deleted");
        expect(await h.db.select().from(s.verification).where(like(s.verification.identifier, "magnetosphere:auth-write-guard:%"))).toHaveLength(0);
        for (const hash of hashes) { expect(text.includes(hash)).toBe(false); expect(JSON.stringify(errors.mock.calls).includes(hash)).toBe(false); }
        const reused = await apiReply(api().resetPassword({ body: { token, newPassword: "retry-consumed-password-123" } }));
        const invalid = await apiReply(api().resetPassword({ body: { token: "missing-token", newPassword: "retry-consumed-password-123" } }));
        expect(reused).toEqual(invalid);
      } finally { errors.mockRestore(); }
    });
  }

  it("M4.T4.reset-insert: 살아 있는 credential 없는 회원은 새 계정 생성·버전1·전체세션폐기로 복구된다", async () => {
    const x = await add("new-account"), s = h.schema as any;
    await api().signInEmail({ body: { email: x.email, password: PASSWORD } });
    await h.db.delete(s.account).where(eq(s.account.userId, x.id));
    const token = await tokenFor(x.email);
    expect((await apiReply(api().resetPassword({ body: { token, newPassword: "reset-insert-password-123" } }))).status).toBe(200);
    const accounts = await rows(s.account, x.id);
    expect(accounts).toHaveLength(1);
    expect(await verifyPassword({ hash: accounts[0].password, password: "reset-insert-password-123" })).toBe(true);
    expect((await user(x.id)).authVersion).toBe(1);
    expect(await rows(s.session, x.id)).toHaveLength(0);
  });

  it("M4.T4.reset-suspend: hash 뒤 정지/ABA는 onPasswordReset으로 인증·상태를 되살리지 않는다", async () => {
    const x = await add("suspended"), s = h.schema as any;
    await h.db.update(s.user).set({ emailVerified: false, signupOrigin: "public" }).where(eq(s.user.id, x.id));
    const token = await tokenFor(x.email), pause = barrier(), options = authOptions(cfg);
    (options.emailAndPassword as any).password = { hash: async (password: string) => { const hash = await hashPassword(password); await pause.wait(); return hash; }, verify: verifyPassword };
    const instance = betterAuth(options);
    const pending = apiReply((instance.api as any).resetPassword({ body: { token, newPassword: "suspended-reset-password-123" } }));
    await pause.reached;
    try { await h.db.update(s.user).set({ status: "suspended", authVersion: sql`${s.user.authVersion} + 1` }).where(eq(s.user.id, x.id)); }
    finally { pause.release(); }
    expect((await pending).status).toBe(400);
    expect((await user(x.id)).emailVerified).toBe(false);
    expect((await user(x.id)).status).toBe("suspended");
    expect((await user(x.id)).authVersion).toBe(1);
    expect(await verifyPassword({ hash: (await rows(s.account, x.id))[0].password, password: PASSWORD })).toBe(true);
  });

  it("M4.T4.reset-max: 상한의 reset은 계정/세션/버전을 변경하지 않고 INVALID_TOKEN으로 닫는다", async () => {
    const x = await add("max"), s = h.schema as any;
    await h.db.update(s.user).set({ authVersion: AUTH_VERSION_MAX }).where(eq(s.user.id, x.id));
    await api().signInEmail({ body: { email: x.email, password: PASSWORD } });
    const token = await tokenFor(x.email);
    expect((await apiReply(api().resetPassword({ body: { token, newPassword: "max-reset-password-123" } }))).code).toBe("invalid_token");
    expect((await user(x.id)).authVersion).toBe(AUTH_VERSION_MAX);
    expect(await rows(s.session, x.id)).toHaveLength(1);
    expect(await verifyPassword({ hash: (await rows(s.account, x.id))[0].password, password: PASSWORD })).toBe(true);
  });

  it("M4.T4.reset-zero: credential UPDATE 0행은 onPasswordReset/200을 막고 version/session을 rollback한다", async () => {
    const x = await add("zero"), s = h.schema as any;
    const signed = await api().signInEmail({ body: { email: x.email, password: PASSWORD }, returnHeaders: true });
    const token = await tokenFor(x.email), original = h.db.transaction.bind(h.db);
    const options = authOptions(cfg), onReset = vi.fn(options.emailAndPassword.onPasswordReset);
    options.emailAndPassword.onPasswordReset = onReset;
    const instance = betterAuth(options);
    const mock = vi.spyOn(h.db, "transaction").mockImplementation((callback: any, config: any) => original(async (tx: any) => {
      const update = tx.update.bind(tx);
      tx.update = (table: any) => table !== s.account ? update(table) : { set: () => ({ where: () => ({ returning: async () => [], then: (resolve: any) => resolve([{ affectedRows: 0 }]) }) }) };
      return callback(tx);
    }, config));
    try {
      expect((await apiReply((instance.api as any).resetPassword({ body: { token, newPassword: "zero-row-password-123" } }))).status).toBe(400);
      expect(onReset).not.toHaveBeenCalled();
      expect((await user(x.id)).authVersion).toBe(0);
      expect(await rows(s.session, x.id)).toHaveLength(1);
      expect(await verifyPassword({ hash: (await rows(s.account, x.id))[0].password, password: PASSWORD })).toBe(true);
      expect(await api().getSession({ headers: new Headers({ cookie: signed.headers.getSetCookie().map((value: string) => value.split(";")[0]).join("; ") }) })).not.toBeNull();
    } finally { mock.mockRestore(); }
  });
});
