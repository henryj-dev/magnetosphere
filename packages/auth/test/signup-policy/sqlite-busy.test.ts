// TC-M2.T7.b Node SQLite 에서 겹친 쓰기가 SQLITE_BUSY 로 깨지지 않는다 (M2.T7, V29 sqliteConcurrentSignUp).
// 운영 구성 그대로다: SQLite 연결은 런타임 어댑터의 connectNode(packages/runtime/src/node.ts), 인증은 createAuth.
// libSQL 클라이언트는 트랜잭션마다 풀에서 연결을 따로 잡는다 (@libsql/client sqlite3.js transaction()). 동기 드라이버라
// 한 프로세스 안에서 트랜잭션 둘이 겹치거나, 열린 트랜잭션 옆에서 다른 연결이 쓰면 잠금을 기다리지 못하고 SQLITE_BUSY 다.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
// 런타임 어댑터는 packages/auth 에 기대므로(@magnetosphere/auth) 의존성으로 두지 않고 상대 경로로 가져온다
import { connectNode } from "../../../runtime/src/node.ts";
import type { DbHandle } from "../../../runtime/src/types.ts";
import { createTestDb, type TestDb } from "../../../runtime/test/dbs.ts";
import { createAuth, type MailMessage } from "../../src/index.ts";
import { BASE, client, email, PASSWORD } from "../client.ts";
import { linkIn, randomIp, SECRET } from "../helpers.ts";

const N = 10;

describe("TC-M2.T7.b Node SQLite 겹친 쓰기", () => {
  let t: TestDb;
  let h: DbHandle;
  let auth: ReturnType<typeof createAuth>;
  const outbox: MailMessage[] = [];
  const pending: Promise<unknown>[] = [];
  const settle = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
  beforeAll(async () => {
    t = await createTestDb("sqlite");
    h = await connectNode(t.url);
    auth = createAuth({
      database: h,
      baseURL: BASE,
      secret: SECRET,
      trustedOrigins: [BASE],
      mailer: { send: async (m) => void outbox.push(m) },
      clientIp: randomIp,
      waitUntil: (p) => void pending.push(p),
      onMailError: () => {},
    });
  });
  afterAll(async () => {
    await h?.close();
    await t?.drop();
  });

  const users = async () => (await h.db.select({ id: h.schema.user.id }).from(h.schema.user)).length;
  const failures = (rs: PromiseSettledResult<unknown>[]) => rs.flatMap((r) => (r.status === "rejected" ? [String((r.reason as Error)?.message ?? r.reason).slice(0, 160)] : []));

  /** 인증된 회원 하나 (차례로 만든다) */
  async function verified(tag: string) {
    const e = email(tag);
    await auth.api.signUpEmail({ body: { email: e, password: PASSWORD, name: "x" } });
    await h.db.update(h.schema.user).set({ emailVerified: true }).where(eq(h.schema.user.email, e));
    return e;
  }

  /** 재설정 메일의 토큰 (메일 링크 /reset-password/<토큰>) */
  async function resetToken(e: string) {
    const r = await client(auth.handler).post("/request-password-reset", { email: e, redirectTo: "/reset" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    await settle();
    const mail = outbox.filter((m) => m.to === e).at(-1);
    const token = mail && new URL(linkIn(mail.text)!).pathname.split("/").at(-1);
    if (!token) throw new Error(`재설정 메일이 없다: ${e}`);
    return token;
  }

  test(`TC-M2.T7.b (1) auth.api.signUpEmail ${N}건 동시 → ${N}건 성공·user +${N}, (2) 재설정 트랜잭션과 로그인(rate_limit·세션 쓰기) ${N}쌍 겹침 → 500·SQLITE_BUSY 0`, async () => {
    // (1) 가입 트랜잭션끼리 겹친다
    const before = await users();
    const signUps = await Promise.allSettled(Array.from({ length: N }, (_, i) => auth.api.signUpEmail({ body: { email: email(`busy-${i}`), password: PASSWORD, name: "x" } })));
    await settle();
    expect(failures(signUps), "동시 가입 실패").toEqual([]);
    expect(await users()).toBe(before + N);

    // (2) 재설정(Better Auth 트랜잭션)과 로그인(rate_limit 세기·세션 넣기, 트랜잭션 밖 쓰기)을 같은 시각에
    const resetters: { e: string; token: string }[] = [];
    for (let i = 0; i < N; i++) {
      const e = await verified(`reset-${i}`);
      resetters.push({ e, token: await resetToken(e) });
    }
    const signers: string[] = [];
    for (let i = 0; i < N; i++) signers.push(await verified(`login-${i}`));
    const pairs = await Promise.all(
      resetters.flatMap(({ token }, i) => [
        client(auth.handler).post("/reset-password", { newPassword: `busy-reset-horse-${i}`, token }),
        client(auth.handler).post("/sign-in/email", { email: signers[i], password: PASSWORD }),
      ]),
    );
    await settle();
    const bad = pairs.map((r, i) => ({ i, status: r.status, body: JSON.stringify(r.json)?.slice(0, 120) })).filter((r) => r.status !== 200);
    expect(bad, "겹친 재설정·로그인 실패").toEqual([]);
  });
});
