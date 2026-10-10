// K1 리뷰 #10: 구조 비교(TC-S2.T3.d)의 SQL 정규화는 따옴표 밖에서만 공백을 맞춘다. 문자열 리터럴 안은 그대로 둔다.
import { describe, expect, it } from "vitest";
import { norm } from "./dbs.ts";

describe("TC-K1.T1.c 구조 비교 정규화는 문자열 리터럴 안의 공백을 바꾸지 않는다", () => {
  it("DEFAULT 'a, b' 와 DEFAULT 'a,b' 는 다르고, 따옴표 밖의 괄호·쉼표 둘레 공백은 같다", () => {
    expect(norm("CREATE TABLE `t` ( `c` text DEFAULT 'a, b' )")).not.toBe(norm("CREATE TABLE `t` ( `c` text DEFAULT 'a,b' )"));
    expect(norm("DEFAULT 'x ( y )'")).not.toBe(norm("DEFAULT 'x(y)'"));
    // 작은따옴표를 두 번 써서 넣은 리터럴도 한 덩어리다
    expect(norm("DEFAULT 'it''s , ok'")).not.toBe(norm("DEFAULT 'it''s,ok'"));
    // 대조: 따옴표 밖은 SQLite 의 ALTER TABLE ADD 덧붙임과 바로 만든 CREATE 를 같게 본다
    expect(norm("CREATE TABLE `t` ( `a` integer NOT NULL , `b` integer)")).toBe(norm("CREATE TABLE `t` ( `a` integer NOT NULL, `b` integer )"));
  });
});
