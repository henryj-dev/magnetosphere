// Better Auth 내부 기록 (M3.T2 보안 리뷰 L-1·재검토 LOW-1). authOptions 의 logger 는 메시지와, 덧붙은 오류의 이름·문자열 code 만 남긴다.
// 오류의 message·stack·params·cause 에는 이메일·이름·비밀번호 해시가 들 수 있다.
import { afterEach, describe, expect, it, vi } from "vitest";
import { authOptions } from "../src/index.ts";
import { consoleMailer } from "../src/mail/index.ts";
import { BASE } from "./client.ts";
import { SECRET } from "./helpers.ts";

const options = () => authOptions({ database: { db: {}, kind: "sqlite", provider: "sqlite", schema: {} } as any, baseURL: BASE, secret: SECRET, mailer: consoleMailer(), clientIp: () => null, waitUntil: () => {}, onMailError: () => {} });

afterEach(() => vi.restoreAllMocks());

describe("Better Auth 내부 기록", () => {
  it("M3.T2.L1 오류 인자는 이름·문자열 code 만 꼬리에 붙고 message·stack·params·cause 는 남지 않는다", () => {
    const lines: string[] = [];
    for (const m of ["error", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(`${m}:${a.map(String).join(" ")}`));
    const log = (options() as any).logger.log as (level: string, message: string, ...args: unknown[]) => void;
    const dbError = Object.assign(new Error("Failed query: insert into user\nparams: leak@example.com,홍길동,$argon2id$hash"), {
      name: "DrizzleQueryError",
      params: ["leak@example.com", "홍길동"],
      cause: Object.assign(new Error("Duplicate entry 'leak@example.com' for key 'user.email'"), { code: "ER_DUP_ENTRY" }),
    });
    const coded = Object.assign(new Error("secret detail leak@example.com"), { name: "APIError", code: "USER_ALREADY_EXISTS" });
    const numeric = Object.assign(new TypeError("leak@example.com"), { code: 1062 });
    log("error", "Failed to create user", dbError, coded, numeric, { email: "leak@example.com" });
    log("warn", "plain");
    expect(lines).toEqual(["error:[auth] Failed to create user (DrizzleQueryError) (APIError:USER_ALREADY_EXISTS) (TypeError)", "warn:[auth] plain"]);
    for (const leak of ["leak@example.com", "홍길동", "argon2", "Duplicate", "params", "    at "]) expect(lines.join("\n")).not.toContain(leak);
  });
});
