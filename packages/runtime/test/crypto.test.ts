// 암호화 유틸 TC (pnpm test). Node·Workers 교차는 test/cross-runtime.test.ts (pnpm test:cross-runtime).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCipher } from "../src/crypto.ts";

const VECTORS = JSON.parse(readFileSync(new URL("./fixtures/crypto-vectors.json", import.meta.url), "utf8")) as {
  key: string;
  cases: { plain: string; aad: string; token: string }[];
};

const AAD = "app_settings.omniroute_token";

/** base64 문자 하나를 다른 문자로 바꾼다 (바이트 하나 이상이 바뀐다) */
function flipAt(token: string, i: number) {
  const c = token[i];
  return token.slice(0, i) + (c === "A" ? "B" : "A") + token.slice(i + 1);
}

/** 암호문 바이트 하나를 바꾼다 */
function flipByte(token: string, byteIndex: number) {
  const bytes = Uint8Array.from(atob(token.slice(3)), (c) => c.charCodeAt(0));
  bytes[byteIndex] ^= 0x01;
  return "v1:" + btoa(String.fromCharCode(...bytes));
}

describe("TC-S4.T2.b 변조된 암호문은 복호화에 실패한다", () => {
  it("iv·암호문·인증 태그의 바이트 하나만 바꿔도 예외", async () => {
    const cipher = await createCipher(VECTORS.key);
    const token = await cipher.encrypt("oma_live_secret", AAD);
    expect(await cipher.decrypt(token, AAD)).toBe("oma_live_secret");
    const len = atob(token.slice(3)).length;
    for (const i of [0, 11, 12, 13, len - 17, len - 1]) {
      await expect(cipher.decrypt(flipByte(token, i), AAD)).rejects.toThrow(/복호화 실패/);
    }
    await expect(cipher.decrypt(flipAt(token, 10), AAD)).rejects.toThrow();
  });

  it("다른 키·접두사 없음·잘린 값도 예외", async () => {
    const cipher = await createCipher(VECTORS.key);
    const other = await createCipher(btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
    const token = await cipher.encrypt("x", AAD);
    await expect(other.decrypt(token, AAD)).rejects.toThrow(/복호화 실패/);
    await expect(cipher.decrypt(token.slice(3), AAD)).rejects.toThrow(/v1:/);
    await expect(cipher.decrypt("v1:AAAA", AAD)).rejects.toThrow(/짧다/);
  });
});

describe("TC-S4.T2.c 키가 32바이트가 아니면 시작을 거부한다", () => {
  it("16·31·33바이트, base64 아님, 빈 값 → 예외. 32바이트 → 예외 없음", async () => {
    const key = (n: number) => btoa(String.fromCharCode(...new Uint8Array(n).fill(1)));
    await expect(createCipher(key(16))).rejects.toThrow(/32바이트/);
    await expect(createCipher(key(31))).rejects.toThrow(/32바이트/);
    await expect(createCipher(key(33))).rejects.toThrow(/32바이트/);
    await expect(createCipher("")).rejects.toThrow(/32바이트/);
    await expect(createCipher("not base64 !!")).rejects.toThrow(/base64/);
    await expect(createCipher(key(32))).resolves.toBeDefined();
  });
});

describe("TC-S4.T2.d 다른 AAD(저장 자리)로는 복호화하지 못한다", () => {
  it("같은 키·같은 암호문이라도 AAD 가 다르면 예외, 같으면 평문", async () => {
    const cipher = await createCipher(VECTORS.key);
    const token = await cipher.encrypt("re_live_key", "app_settings.mail_settings.apiKey");
    expect(await cipher.decrypt(token, "app_settings.mail_settings.apiKey")).toBe("re_live_key");
    await expect(cipher.decrypt(token, "app_settings.omniroute_token")).rejects.toThrow(/복호화 실패/);
    await expect(cipher.decrypt(token, "app_settings.mail_settings.apikey")).rejects.toThrow(/복호화 실패/);
    // 고정 벡터도 자기 AAD 로만 열린다
    const v = VECTORS.cases[2];
    await expect(cipher.decrypt(v.token, VECTORS.cases[1].aad)).rejects.toThrow(/복호화 실패/);
    await expect(cipher.encrypt("x", "")).rejects.toThrow(/AAD/);
  });
});

describe("암호화 유틸 공통", () => {
  it("같은 평문도 매번 다른 암호문 (iv 무작위), v1: 접두사", async () => {
    const cipher = await createCipher(VECTORS.key);
    const [a, b] = [await cipher.encrypt("same", AAD), await cipher.encrypt("same", AAD)];
    expect(a).not.toBe(b);
    expect(a.startsWith("v1:")).toBe(true);
  });
});
