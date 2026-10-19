// TC-A1.T1.a~j 관리자 MFA 단위 시험 (DB 없음). TOTP·HOTP·base32 는 RFC 시험 벡터, 정책은 시험 전용 설정 객체를 넘긴다.
//   pnpm -C packages/auth exec vitest run test/mfa-unit.test.ts
// 정책 수치는 이 파일의 시험 전용 값이다. 제품 기본값이 아니다.
import { describe, expect, test } from "vitest";
import { createCipher } from "../../runtime/src/crypto.ts";
import { loadMfaPolicy, MFA_POLICY_ENV, type MfaPolicy } from "../src/mfa/policy.ts";
import { factorSecretAad, openFactorSecret, sealFactorSecret } from "../src/mfa/store.ts";
import { base32Decode, base32Encode, hotp, otpauthUri, timeStep, totpAt, verifyTotp, type TotpAlgorithm } from "../src/mfa/totp.ts";

const ascii = (s: string) => new TextEncoder().encode(s);

/** 시험 전용 정책 설정 (env 꼴 문자열). 값은 시험 편의로 고른 것이다 */
const TEST_POLICY_ENV: Record<string, string> = {
  MFA_TOTP_PERIOD_S: "30",
  MFA_TOTP_DIGITS: "6",
  MFA_TOTP_ALGORITHM: "SHA-1",
  MFA_TOTP_PAST_WINDOW: "1",
  MFA_TOTP_FUTURE_WINDOW: "1",
  MFA_SEED_BYTES: "20",
  MFA_RECENCY_TTL_S: "300",
  MFA_CHALLENGE_TTL_S: "600",
  MFA_PENDING_TTL_S: "900",
  MFA_GRANT_TTL_S: "86400",
  MFA_ADMIN_SESSION_ABSOLUTE_TTL_S: "3600",
  MFA_FAILURE_LIMIT: "5",
  MFA_ACCOUNT_FAILURE_LIMIT: "20",
  MFA_FAILURE_WINDOW_S: "900",
  MFA_FAILURE_DELAY_BASE_S: "1",
  MFA_FAILURE_DELAY_MAX_S: "900",
  MFA_RECOVERY_CODE_COUNT: "10",
};
const TEST_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));

describe("TOTP·HOTP·base32", () => {
  test("TC-A1.T1.a RFC 4226 부록 D HOTP 시험 벡터 (카운터 0~9)", async () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    const secret = ascii("12345678901234567890");
    for (let c = 0; c < expected.length; c++) expect(await hotp(secret, c, 6, "SHA-1")).toBe(expected[c]);
  });

  test("TC-A1.T1.b RFC 6238 부록 B TOTP 시험 벡터 (SHA-1·SHA-256·SHA-512, 8자리, 30초)", async () => {
    const seeds: Record<TotpAlgorithm, Uint8Array<ArrayBuffer>> = {
      "SHA-1": ascii("12345678901234567890"),
      "SHA-256": ascii("12345678901234567890123456789012"),
      "SHA-512": ascii("1234567890123456789012345678901234567890123456789012345678901234"),
    };
    const table: [number, string, string, string][] = [
      [59, "94287082", "46119246", "90693936"],
      [1111111109, "07081804", "68084774", "25091201"],
      [1111111111, "14050471", "67062674", "99943326"],
      [1234567890, "89005924", "91819424", "93441116"],
      [2000000000, "69279037", "90698825", "38618901"],
      [20000000000, "65353130", "77737706", "47863826"],
    ];
    for (const [t, sha1, sha256, sha512] of table) {
      const step = timeStep(t * 1000, 30);
      expect(await totpAt(seeds["SHA-1"], step, 8, "SHA-1")).toBe(sha1);
      expect(await totpAt(seeds["SHA-256"], step, 8, "SHA-256")).toBe(sha256);
      expect(await totpAt(seeds["SHA-512"], step, 8, "SHA-512")).toBe(sha512);
      // verifyTotp 도 같은 벡터를 그 step 으로 받는다
      expect(await verifyTotp({ secret: seeds["SHA-512"], code: sha512, nowMs: t * 1000, periodS: 30, digits: 8, algorithm: "SHA-512", pastWindow: 0, futureWindow: 0 })).toEqual({ ok: true, step });
    }
    // 부록 B 의 step 값(16진 T)
    expect(timeStep(59_000, 30)).toBe(0x1);
    expect(timeStep(1111111109_000, 30)).toBe(0x23523ec);
    expect(timeStep(20000000000_000, 30)).toBe(0x27bc86aa);
  });

  test("TC-A1.T1.c base32 RFC 4648 §10 벡터와 잘못된 입력 거부", () => {
    const vectors: [string, string][] = [["", ""], ["f", "MY"], ["fo", "MZXQ"], ["foo", "MZXW6"], ["foob", "MZXW6YQ"], ["fooba", "MZXW6YTB"], ["foobar", "MZXW6YTBOI"]];
    for (const [plain, enc] of vectors) {
      expect(base32Encode(ascii(plain))).toBe(enc);
      expect(new TextDecoder().decode(base32Decode(enc))).toBe(plain);
      expect(new TextDecoder().decode(base32Decode(enc.toLowerCase()))).toBe(plain);
    }
    expect(new TextDecoder().decode(base32Decode("MZXW6YQ="))).toBe("foob");
    expect(new TextDecoder().decode(base32Decode("MZXW6YTBOI======"))).toBe("foobar");
    for (const bad of ["MZXW1", "MZ XW", "MZXW6YR", "M"]) expect(() => base32Decode(bad)).toThrow("base32 형식이 아니다");
    const random = crypto.getRandomValues(new Uint8Array(37));
    expect(base32Decode(base32Encode(random))).toEqual(random);
  });

  test("TC-A1.T1.d 시간창 경계: 과거·미래 window 안은 맞은 step, 밖은 거부", async () => {
    const secret = crypto.getRandomValues(new Uint8Array(20));
    const periodS = 30;
    const now = 1_800_000_015_000;
    const n = timeStep(now, periodS);
    const base = { secret, nowMs: now, periodS, digits: 6, algorithm: "SHA-1" as const };
    const code = (s: number) => totpAt(secret, s, 6, "SHA-1");
    const check = async (s: number, pastWindow: number, futureWindow: number) => verifyTotp({ ...base, code: await code(s), pastWindow, futureWindow });
    expect(await check(n, 0, 0)).toEqual({ ok: true, step: n });
    expect(await check(n - 1, 1, 0)).toEqual({ ok: true, step: n - 1 });
    expect(await check(n + 1, 0, 1)).toEqual({ ok: true, step: n + 1 });
    expect(await check(n - 2, 1, 1)).toEqual({ ok: false });
    expect(await check(n + 2, 1, 1)).toEqual({ ok: false });
    expect(await check(n - 1, 0, 1)).toEqual({ ok: false });
    expect(await check(n + 1, 1, 0)).toEqual({ ok: false });
    expect(await check(n - 3, 3, 0)).toEqual({ ok: true, step: n - 3 });
    // step 경계: 같은 step 의 첫 초와 마지막 초
    expect(timeStep(n * periodS * 1000, periodS)).toBe(n);
    expect(timeStep((n + 1) * periodS * 1000 - 1, periodS)).toBe(n);
    // 구현 한계(64 step)를 넘는 시간창은 계산하지 않는다
    await expect(verifyTotp({ ...base, code: await code(n), pastWindow: 32, futureWindow: 32 })).rejects.toThrow("구현 한계");
    expect(await verifyTotp({ ...base, code: await code(n), pastWindow: 31, futureWindow: 32 })).toEqual({ ok: true, step: n });
    // 형식이 틀린 코드는 예외 없이 불일치
    for (const bad of ["", "12345", "1234567", "12a456", " 123456", "１２３４５６"]) expect(await verifyTotp({ ...base, code: bad, pastWindow: 1, futureWindow: 1 })).toEqual({ ok: false });
  });

  test("TC-A1.T1.k2 시간창에서 여러 step 이 맞으면 가장 큰 step, 음수 step 은 건너뛴다", async () => {
    const secret = crypto.getRandomValues(new Uint8Array(20));
    const n = 1000;
    const nowMs = n * 30_000;
    // 1자리 코드 10개에 11 step 이면 겹치는 값이 반드시 있다
    const steps = Array.from({ length: 11 }, (_, i) => n - 5 + i);
    const codes = await Promise.all(steps.map((s) => totpAt(secret, s, 1, "SHA-1")));
    const dup = codes.find((c, i) => codes.indexOf(c) !== i);
    if (dup === undefined) throw new Error("비둘기집 원리상 겹치는 코드가 있어야 한다");
    const matching = steps.filter((_, i) => codes[i] === dup);
    expect(matching.length).toBeGreaterThan(1);
    expect(await verifyTotp({ secret, code: dup, nowMs, periodS: 30, digits: 1, algorithm: "SHA-1", pastWindow: 5, futureWindow: 5 })).toEqual({ ok: true, step: Math.max(...matching) });
    // 지금이 step 0 이면 과거 window 의 음수 step 은 계산하지 않는다 (예외 없음)
    const zero = await totpAt(secret, 0, 6, "SHA-1");
    expect(await verifyTotp({ secret, code: zero, nowMs: 1_000, periodS: 30, digits: 6, algorithm: "SHA-1", pastWindow: 3, futureWindow: 0 })).toEqual({ ok: true, step: 0 });
    const wrong = zero === "000000" ? "000001" : "000000";
    expect(await verifyTotp({ secret, code: wrong, nowMs: 1_000, periodS: 30, digits: 6, algorithm: "SHA-1", pastWindow: 3, futureWindow: 0 })).toEqual({ ok: false });
  });

  test("TC-A1.T1.e otpauth URI 는 secret·issuer·algorithm·digits·period 를 모두 명시한다", () => {
    const secret = ascii("12345678901234567890");
    const uri = otpauthUri({ issuer: "Magneto sphere", account: "admin@example.com", secret, periodS: 45, digits: 7, algorithm: "SHA-256" });
    const u = new URL(uri);
    expect(u.protocol).toBe("otpauth:");
    expect(u.host).toBe("totp");
    expect(decodeURIComponent(u.pathname)).toBe("/Magneto sphere:admin@example.com");
    expect(u.searchParams.get("secret")).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(u.searchParams.get("issuer")).toBe("Magneto sphere");
    expect(u.searchParams.get("algorithm")).toBe("SHA256");
    expect(u.searchParams.get("digits")).toBe("7");
    expect(u.searchParams.get("period")).toBe("45");
    expect(uri).not.toContain("+");
    expect(() => otpauthUri({ issuer: "a:b", account: "x", secret, periodS: 30, digits: 6, algorithm: "SHA-1" })).toThrow();
  });
});

describe("MFA 정책", () => {
  test("TC-A1.T1.f 정책 값이 하나라도 없으면 unavailable(missing) 이고 기본값을 채우지 않는다", async () => {
    const ready = await loadMfaPolicy(TEST_POLICY_ENV);
    expect(ready.state).toBe("ready");
    expect(await loadMfaPolicy({})).toEqual({ state: "unavailable", reason: "missing", field: "MFA_TOTP_PERIOD_S" });
    for (const name of Object.values(MFA_POLICY_ENV)) {
      for (const empty of [undefined, "", "   "]) {
        const env = { ...TEST_POLICY_ENV, [name]: empty };
        expect(await loadMfaPolicy(env)).toEqual({ state: "unavailable", reason: "missing", field: name });
      }
    }
  });

  test("TC-A1.T1.g 범위 밖·정수 아님·모르는 해시·TTL 관계 위반은 unavailable 이고 이유에 값 원문이 없다", async () => {
    const cases: [string, string | number, string][] = [
      ["MFA_TOTP_PERIOD_S", "0", "out_of_range"],
      ["MFA_TOTP_PERIOD_S", "-30", "out_of_range"],
      ["MFA_TOTP_DIGITS", "5", "out_of_range"],
      ["MFA_TOTP_DIGITS", "9", "out_of_range"],
      ["MFA_TOTP_PAST_WINDOW", "-1", "out_of_range"],
      ["MFA_TOTP_FUTURE_WINDOW", "-1", "out_of_range"],
      ["MFA_SEED_BYTES", "15", "out_of_range"],
      ["MFA_SEED_BYTES", "129", "out_of_range"],
      ["MFA_GRANT_TTL_S", "0", "out_of_range"],
      ["MFA_FAILURE_LIMIT", "0", "out_of_range"],
      ["MFA_ACCOUNT_FAILURE_LIMIT", "0", "out_of_range"],
      // 계정 칸 제한이 계정+IP 칸보다 낮으면 계정+IP 칸이 뜻이 없다 (보안 리뷰 L2)
      ["MFA_ACCOUNT_FAILURE_LIMIT", "4", "inconsistent"],
      ["MFA_TOTP_PERIOD_S", "30.5", "not_integer"],
      ["MFA_TOTP_PERIOD_S", "1e3", "not_integer"],
      ["MFA_TOTP_PERIOD_S", "0x1e", "not_integer"],
      ["MFA_TOTP_PERIOD_S", 30.5, "not_integer"],
      ["MFA_TOTP_PERIOD_S", "99999999999999999999", "not_integer"],
      ["MFA_RECENCY_TTL_S", "SENTINEL-VALUE-7731", "not_integer"],
      ["MFA_TOTP_ALGORITHM", "MD5", "unknown_algorithm"],
      ["MFA_TOTP_ALGORITHM", "SENTINEL-VALUE-7731", "unknown_algorithm"],
      ["MFA_RECENCY_TTL_S", "3601", "inconsistent"],
      ["MFA_CHALLENGE_TTL_S", "3601", "inconsistent"],
      ["MFA_PENDING_TTL_S", "3601", "inconsistent"],
      ["MFA_FAILURE_DELAY_BASE_S", "0", "out_of_range"],
      ["MFA_FAILURE_DELAY_MAX_S", "0", "out_of_range"],
      ["MFA_RECOVERY_CODE_COUNT", "0", "out_of_range"],
      ["MFA_RECOVERY_CODE_COUNT", "51", "out_of_range"],
      // 시간창 합의 구현 한계(64 step)는 더 큰 쪽 설정 이름으로 알린다
      ["MFA_TOTP_PAST_WINDOW", "63", "implementation_limit"],
      ["MFA_TOTP_FUTURE_WINDOW", "63", "implementation_limit"],
    ];
    for (const [name, value, reason] of cases) {
      const r = await loadMfaPolicy({ ...TEST_POLICY_ENV, [name]: value });
      expect(r, `${name}=${value}`).toEqual({ state: "unavailable", reason, field: name });
      const text = JSON.stringify(r);
      expect(text).not.toContain("SENTINEL");
      if (String(value).length > 1) expect(text).not.toContain(String(value));
    }
    // 지연 상한이 첫 지연보다 작으면 두 배씩 늘리는 규칙이 성립하지 않는다. 상한 설정 이름으로 알린다
    expect(await loadMfaPolicy({ ...TEST_POLICY_ENV, MFA_FAILURE_DELAY_BASE_S: "901" })).toEqual({ state: "unavailable", reason: "inconsistent", field: "MFA_FAILURE_DELAY_MAX_S" });
    // (1+1+1) × 계정 실패 제한 ≥ 10^6 이면 IP 를 바꿔도 실패 예산이 코드 공간을 덮는다. 시간창 관계라 시간창 설정 이름으로 알린다
    expect(await loadMfaPolicy({ ...TEST_POLICY_ENV, MFA_ACCOUNT_FAILURE_LIMIT: "333334" })).toEqual({ state: "unavailable", reason: "inconsistent", field: "MFA_TOTP_PAST_WINDOW" });
    expect(await loadMfaPolicy({ ...TEST_POLICY_ENV, MFA_TOTP_DIGITS: "8", MFA_ACCOUNT_FAILURE_LIMIT: "33333334" })).toEqual({ state: "unavailable", reason: "inconsistent", field: "MFA_TOTP_PAST_WINDOW" });
    // 계정+IP 칸 제한이 계정 칸보다 크면 계정 칸 이름으로 알린다
    expect(await loadMfaPolicy({ ...TEST_POLICY_ENV, MFA_FAILURE_LIMIT: "21" })).toEqual({ state: "unavailable", reason: "inconsistent", field: "MFA_ACCOUNT_FAILURE_LIMIT" });
    // 경계 안쪽 값은 받는다
    for (const [name, value] of [["MFA_TOTP_DIGITS", "8"], ["MFA_TOTP_PAST_WINDOW", "0"], ["MFA_SEED_BYTES", "16"], ["MFA_SEED_BYTES", "128"], ["MFA_RECENCY_TTL_S", "3600"], ["MFA_TOTP_ALGORITHM", "sha-512"], ["MFA_TOTP_ALGORITHM", "SHA-256"], ["MFA_ACCOUNT_FAILURE_LIMIT", "333333"], ["MFA_FAILURE_LIMIT", "20"], ["MFA_TOTP_PAST_WINDOW", "62"]]) {
      expect((await loadMfaPolicy({ ...TEST_POLICY_ENV, [name]: value })).state, `${name}=${value}`).toBe("ready");
    }
  });

  test("TC-A1.T1.h 정책 버전은 정규화한 값의 SHA-256 이고 값이 바뀌면 바뀐다", async () => {
    const base = await loadMfaPolicy(TEST_POLICY_ENV);
    if (base.state !== "ready") throw new Error("시험 정책이 ready 가 아니다");
    expect(base.version).toMatch(/^[0-9a-f]{64}$/);
    // 문자열·숫자·공백·대소문자 차이는 같은 정책
    const numeric = Object.fromEntries(Object.entries(TEST_POLICY_ENV).map(([k, v]) => [k, k === "MFA_TOTP_ALGORITHM" ? " sha-1 " : Number(v)]));
    const same = await loadMfaPolicy(numeric);
    expect(same.state === "ready" && same.version).toBe(base.version);
    expect(same.state === "ready" && same.policy).toEqual(base.policy);
    const expectedPolicy: MfaPolicy = {
      totpPeriodS: 30, totpDigits: 6, totpAlgorithm: "SHA-1", totpPastWindow: 1, totpFutureWindow: 1, seedBytes: 20,
      recencyTtlS: 300, challengeTtlS: 600, pendingTtlS: 900, grantTtlS: 86400, adminSessionAbsoluteTtlS: 3600, failureLimit: 5, accountFailureLimit: 20, failureWindowS: 900,
      failureDelayBaseS: 1, failureDelayMaxS: 900, recoveryCodeCount: 10,
    };
    expect(base.policy).toEqual(expectedPolicy);
    expect(Object.isFrozen(base.policy)).toBe(true);
    const versions = new Set([base.version]);
    const changes: Record<string, string> = {
      MFA_TOTP_PERIOD_S: "60", MFA_TOTP_DIGITS: "8", MFA_TOTP_ALGORITHM: "SHA-256", MFA_TOTP_PAST_WINDOW: "0", MFA_TOTP_FUTURE_WINDOW: "0",
      MFA_SEED_BYTES: "32", MFA_RECENCY_TTL_S: "301", MFA_CHALLENGE_TTL_S: "601", MFA_PENDING_TTL_S: "901", MFA_GRANT_TTL_S: "86401",
      MFA_ADMIN_SESSION_ABSOLUTE_TTL_S: "3601", MFA_FAILURE_LIMIT: "6", MFA_ACCOUNT_FAILURE_LIMIT: "21", MFA_FAILURE_WINDOW_S: "901",
      MFA_FAILURE_DELAY_BASE_S: "2", MFA_FAILURE_DELAY_MAX_S: "901", MFA_RECOVERY_CODE_COUNT: "11",
    };
    expect(Object.keys(changes).sort()).toEqual(Object.values(MFA_POLICY_ENV).sort());
    for (const [name, value] of Object.entries(changes)) {
      const r = await loadMfaPolicy({ ...TEST_POLICY_ENV, [name]: value });
      if (r.state !== "ready") throw new Error(`${name} 변경 정책이 ready 가 아니다`);
      expect(versions.has(r.version), name).toBe(false);
      versions.add(r.version);
    }
    // 정책과 관계없는 설정은 버전에 들어가지 않는다
    const extra = await loadMfaPolicy({ ...TEST_POLICY_ENV, UNRELATED: "x" });
    expect(extra.state === "ready" && extra.version).toBe(base.version);
  });
});

describe("seed 암호화·비밀값 노출", () => {
  test("TC-A1.T1.i seed 암호문은 다른 factor·회원의 AAD 로 복호화되지 않는다", async () => {
    const cipher = await createCipher(TEST_KEY);
    const secret = crypto.getRandomValues(new Uint8Array(20));
    const sealed = await sealFactorSecret(cipher, secret, "factor-a", "user-1");
    expect(factorSecretAad("factor-a", "user-1")).toBe("mfa_factor.secret_enc|v1|factor-a|user-1");
    expect(await openFactorSecret(cipher, sealed, "factor-a", "user-1")).toEqual(secret);
    await expect(openFactorSecret(cipher, sealed, "factor-b", "user-1")).rejects.toThrow("복호화 실패");
    await expect(openFactorSecret(cipher, sealed, "factor-a", "user-2")).rejects.toThrow("복호화 실패");
    // 같은 키의 다른 저장 자리(AAD) 암호문도 받지 않는다
    const elsewhere = await cipher.encrypt(base32Encode(secret), "app_settings.mail_settings.apiKey");
    await expect(openFactorSecret(cipher, elsewhere, "factor-a", "user-1")).rejects.toThrow("복호화 실패");
    // AAD 구분자를 id 에 넣어 다른 칸을 흉내낼 수 없다
    expect(() => factorSecretAad("factor-a|user-1", "x")).toThrow();
  });

  test("TC-A1.T1.j 오류 메시지·정책 상태에 seed·코드 원문이 없다", async () => {
    const cipher = await createCipher(TEST_KEY);
    const secret = crypto.getRandomValues(new Uint8Array(20));
    const b32 = base32Encode(secret);
    const sealed = await sealFactorSecret(cipher, secret, "factor-a", "user-1");
    const messages: string[] = [];
    const capture = async (f: () => unknown) => {
      try {
        await f();
      } catch (e) {
        messages.push(String((e as Error).message));
        return;
      }
      throw new Error("예외가 나야 한다");
    };
    await capture(() => openFactorSecret(cipher, sealed, "factor-b", "user-1"));
    await capture(() => openFactorSecret(cipher, sealed.slice(0, -4) + "AAAA", "factor-a", "user-1"));
    await capture(() => base32Decode(b32 + "1"));
    await capture(() => base32Decode(`${b32}!`));
    const code = await totpAt(secret, 1, 6, "SHA-1");
    await capture(() => verifyTotp({ secret, code, nowMs: 30_000, periodS: 30, digits: 12, algorithm: "SHA-1", pastWindow: 0, futureWindow: 0 }));
    await capture(() => verifyTotp({ secret, code, nowMs: 30_000, periodS: 30, digits: 6, algorithm: "MD5" as TotpAlgorithm, pastWindow: 0, futureWindow: 0 }));
    expect(messages).toHaveLength(6);
    for (const m of messages) {
      expect(m).not.toContain(b32);
      expect(m).not.toContain(b32.toLowerCase());
      expect(m).not.toContain(sealed);
      expect(m).not.toContain(code);
    }
  });
});
