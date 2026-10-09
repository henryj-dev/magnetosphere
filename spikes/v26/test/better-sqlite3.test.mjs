// 참고(게이트 밖): better-sqlite3 + Drizzle 은 트랜잭션 콜백이 동기 전용이라 Better Auth 의 비동기 트랜잭션 경로와 맞지 않는다.
// SQLite 드라이버로 libsql 을 고른 근거를 실제 Better Auth 경로로 남긴다.
import { describe, it, expect } from "vitest";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { count } from "drizzle-orm";
import * as schema from "../schema/sqlite.ts";
import { makeAuth, client } from "./auth.mjs";
import { registerProvider, oidcLogin } from "./keycloak.mjs";

const kit = createRequire(import.meta.url)("drizzle-kit/api");
const log = (...a) => console.log("[v26-bs3]", ...a);

async function open(name) {
  const file = fileURLToPath(new URL(`../${name}.sqlite`, import.meta.url));
  rmSync(file, { force: true });
  const sqlite = new Database(file);
  const ddl = await kit.generateSQLiteMigration(await kit.generateSQLiteDrizzleJson({}), await kit.generateSQLiteDrizzleJson(schema));
  for (const s of ddl) sqlite.exec(s);
  const db = drizzle(sqlite, { schema });
  const users = () => db.select({ n: count() }).from(schema.user).all()[0].n;
  return { db, provider: "sqlite", schema, users, close: () => sqlite.close() };
}

describe.each([true, false])("V26 참고 better-sqlite3 transaction=%s", (transaction) => {
  it("better-sqlite3 로 resolveUser 가 있는 SSO 로그인이 되는지", async () => {
    const h = await open(`bs3-${transaction}`);
    const auth = makeAuth(h, {}, { transaction });
    const admin = client(auth);
    const su = await admin.post("/sign-up/email", { email: "admin@example.com", password: "adminpass1234", name: "Admin" });
    const reg = su.status === 200 ? await registerProvider(admin, "kc-bs3") : null;
    let cb = null, err = null;
    if (reg?.status === 200) { try { cb = await oidcLogin(client(auth), "kc-bs3"); } catch (e) { err = String(e.message).slice(0, 200); } }
    // 동기 트랜잭션이 던진 뒤에도 비동기 콜백은 계속 돈다. 남은 쓰기가 끝나도록 잠깐 기다린 뒤 행 수를 센다.
    await new Promise((r) => setTimeout(r, 500));
    const out = { transaction, signUp: su.status, signUpErr: su.json?.code ?? su.json?.message, register: reg?.status, registerErr: reg?.json?.code ?? reg?.json?.message, callback: cb?.status, location: cb?.location, err, users: h.users() };
    log(JSON.stringify(out));
    h.close();
    if (transaction) {
      // 비동기 콜백을 동기 트랜잭션에 넘겨 가입부터 500. 그런데 user 행은 트랜잭션 밖에서 남는다.
      expect(su.status).toBe(500);
      expect(out.users).toBe(1);
    } else {
      // 트랜잭션을 끄면 가입은 되지만 resolveUser 를 쓰는 SSO 로그인은 플러그인이 거부한다.
      expect(cb.location).toMatch(/error=SSO_USER_RESOLUTION_REQUIRES_NATIVE_TRANSACTIONS/);
    }
  });
});
