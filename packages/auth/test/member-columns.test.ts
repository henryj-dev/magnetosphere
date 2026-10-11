// M1.T4 스키마 0003 이 더한 user.deleted_at (Q9). USER_ADDITIONAL_FIELDS 에 input: false 로 둬, 가입·회원정보 수정 본문으로
// 쓸 수 없는지 네 DB 에서 본다. 판정은 권한 칼럼(TC-S3.T1.a)과 같다: 기본값 없는 칼럼이라 가입은 400 FIELD_NOT_ALLOWED + 계정 없음,
// null·칼럼 이름(snake_case)은 버려져 200 + NULL, 수정은 400 FIELD_NOT_ALLOWED.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { client, email, PASSWORD } from "./client.ts";
import { ALL_DBS, OPEN, type TestDb } from "./db.ts";
import { makeAuth, markVerified, userRow } from "./helpers.ts";

const AT = "2026-10-11T00:00:00.000Z";

describe.each(ALL_DBS)("새 user 칼럼 입력 차단 — %s", (kind) => {
  let h: TestDb;
  let app: ReturnType<typeof makeAuth>;
  beforeAll(async () => {
    h = await OPEN[kind]();
    app = makeAuth(h);
  });
  afterAll(async () => {
    await h?.close();
  });

  test(`TC-M1.T4.b ${kind}: 가입·회원정보 수정 본문의 deletedAt 은 쓰이지 않는다 (가입 400 + 계정 없음 또는 200 + NULL, 수정 400)`, async () => {
    const c = client(app.handler);
    for (const value of [AT, Date.parse(AT)]) {
      const e = email("del");
      const r = await c.post("/sign-up/email", { email: e, password: PASSWORD, name: "x", deletedAt: value });
      expect(r.status, `가입 deletedAt=${JSON.stringify(value)}`).toBe(400);
      expect(r.json?.code).toBe("FIELD_NOT_ALLOWED");
      expect(await userRow(h, e), "계정이 만들어지면 안 된다").toBeUndefined();
    }
    // null(TC-S3.T1.a 의 monthlyLimitUsd null 과 같다)과 칼럼 이름(snake_case, 모르는 필드)은 버려져 200 + NULL 이다
    for (const body of [{ deletedAt: null }, { deleted_at: AT }]) {
      const e = email("del-drop");
      expect((await c.post("/sign-up/email", { email: e, password: PASSWORD, name: "x", ...body })).status, JSON.stringify(body)).toBe(200);
      expect((await userRow(h, e)).deletedAt, JSON.stringify(body)).toBeNull();
    }

    // 회원정보 수정
    const e = email("del-upd");
    expect((await c.post("/sign-up/email", { email: e, password: PASSWORD, name: "x" })).status).toBe(200);
    await markVerified(h, e);
    expect((await c.post("/sign-in/email", { email: e, password: PASSWORD })).status).toBe(200);
    // 대조: 세션이 살아 있어 아래 400 이 인증 실패 때문이 아니다
    expect((await c.post("/update-user", { name: "renamed" })).status).toBe(200);
    for (const body of [{ deletedAt: AT }, { name: "again", deletedAt: AT }, { deletedAt: Date.parse(AT) }]) {
      const r = await c.post("/update-user", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json?.code, JSON.stringify(body)).toBe("FIELD_NOT_ALLOWED");
    }
    // null 은 가입처럼 버려진다. 남는 필드가 없어 400 "No fields to update" 다
    expect((await c.post("/update-user", { deletedAt: null })).status).toBe(400);
    const row = await userRow(h, e);
    expect({ name: row.name, deletedAt: row.deletedAt }).toEqual({ name: "renamed", deletedAt: null });
  });
});
