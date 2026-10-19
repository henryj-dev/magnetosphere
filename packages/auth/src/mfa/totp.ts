// 관리자 MFA 의 HOTP(RFC 4226)·TOTP(RFC 6238). WebCrypto HMAC 만 써서 Node 와 Workers 가 같은 코드다 (A1 설계 1·7절).
// 수치(step 폭·자릿수·해시·시간창)는 여기서 정하지 않는다. 모두 호출자가 정책(policy.ts)에서 받아 넘긴다.
//
// 판정은 시간창 안의 맞은 step 번호를 돌려준다. 재사용 차단은 이 번호로 DB CAS(store.ts consumeTotpStep)가 한다.
// 비교는 상수 시간이고 시간창의 모든 step 을 끝까지 계산한다 (맞은 위치가 응답 시간으로 드러나지 않게).
// 오류 메시지에는 seed·코드를 넣지 않는다.
import { constantTimeEqual } from "better-auth/crypto";

export type TotpAlgorithm = "SHA-1" | "SHA-256" | "SHA-512";
export const TOTP_ALGORITHMS: readonly TotpAlgorithm[] = ["SHA-1", "SHA-256", "SHA-512"];

/**
 * 판정 한 번에 계산하는 step 수(past + future + 1)의 상한. 공통 정책값이 아니라 구현 안전 한계다:
 * 요청 하나가 HMAC 을 이 횟수보다 많이 돌리지 않게 막는다(계산량 DoS). 정책 검사(policy.ts)와 verifyTotp 가 같이 쓴다.
 */
export const TOTP_WINDOW_STEPS_LIMIT = 64;

// ---------- base32 (RFC 4648 §6) ----------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, 대문자, 패딩 없음 (otpauth URI 의 secret 형식) */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buf = 0;
  let bits = 0;
  for (const b of bytes) {
    buf = (buf << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(buf >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buf &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(buf << (5 - bits)) & 31];
  return out;
}

/** base32 를 바이트로. 대소문자는 가리지 않고 끝의 "=" 패딩은 받는다. 다른 글자·남는 비트가 0 이 아니면 예외 (입력은 메시지에 넣지 않는다) */
export function base32Decode(text: string): Uint8Array<ArrayBuffer> {
  const s = text.toUpperCase().replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((s.length * 5) / 8));
  let buf = 0;
  let bits = 0;
  let i = 0;
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error("base32 형식이 아니다");
    buf = (buf << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out[i++] = (buf >>> (bits - 8)) & 255;
      bits -= 8;
    }
    buf &= (1 << bits) - 1;
  }
  // RFC 4648 §3.5: 남는 비트는 0 이어야 한다. 5비트 이상 남으면 길이가 맞지 않는다
  if (bits >= 5 || buf !== 0) throw new Error("base32 형식이 아니다");
  return out;
}

// ---------- HOTP·TOTP ----------

/** 카운터를 8바이트 빅엔디언으로 (RFC 4226 §5.1 C). JS number 안전 정수 범위만 받는다 */
function counterBytes(counter: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error("HOTP 카운터가 0 이상의 안전 정수가 아니다");
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  return out;
}

function checkDigits(digits: number): void {
  // RFC 4226 §5.3 동적 절단은 31비트 정수라 10자리 이상은 뜻이 없다. 정책 범위(6~8)는 policy.ts 가 정한다
  if (!Number.isInteger(digits) || digits < 1 || digits > 9) throw new Error("HOTP 자릿수가 범위 밖이다");
}

async function hmacKey(secret: Uint8Array<ArrayBuffer>, algorithm: TotpAlgorithm): Promise<CryptoKey> {
  if (!TOTP_ALGORITHMS.includes(algorithm)) throw new Error("모르는 HMAC 해시");
  return crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: algorithm }, false, ["sign"]);
}

async function hotpWithKey(key: CryptoKey, counter: number, digits: number): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBytes(counter)));
  // RFC 4226 §5.4 동적 절단: 마지막 바이트의 낮은 4비트가 오프셋
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** RFC 4226 HOTP 값 (0 으로 채운 digits 자리 문자열) */
export async function hotp(secret: Uint8Array<ArrayBuffer>, counter: number, digits: number, algorithm: TotpAlgorithm): Promise<string> {
  checkDigits(digits);
  return hotpWithKey(await hmacKey(secret, algorithm), counter, digits);
}

/** RFC 6238 §4.2 시간 step: floor((unix 초 − T0) / X), T0 = 0 */
export function timeStep(nowMs: number, periodS: number): number {
  if (!Number.isSafeInteger(periodS) || periodS <= 0) throw new Error("TOTP step 폭이 양의 정수가 아니다");
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new Error("시각이 범위 밖이다");
  return Math.floor(Math.floor(nowMs / 1000) / periodS);
}

/** step 의 TOTP 값 */
export async function totpAt(secret: Uint8Array<ArrayBuffer>, step: number, digits: number, algorithm: TotpAlgorithm): Promise<string> {
  return hotp(secret, step, digits, algorithm);
}

export interface TotpCheck {
  secret: Uint8Array<ArrayBuffer>;
  /** 사용자가 낸 코드. 숫자 digits 자리가 아니면 바로 불일치 */
  code: string;
  nowMs: number;
  periodS: number;
  digits: number;
  algorithm: TotpAlgorithm;
  /** 지금보다 이전 step 을 몇 개까지 받나 (≥ 0) */
  pastWindow: number;
  /** 지금보다 이후 step 을 몇 개까지 받나 (≥ 0) */
  futureWindow: number;
}

/**
 * 시간창 [now − past, now + future] 안에서 코드를 찾는다. 맞으면 { ok: true, step }.
 * 둘 이상 맞으면(서로 다른 step 의 우연한 같은 값) 가장 큰 step 을 돌려준다 — CAS 가 그 이하를 모두 막아 재사용 여지가 가장 작다.
 * 재사용 여부는 여기서 보지 않는다. 돌려준 step 으로 store.ts consumeTotpStep 을 불러야 한 번만 받는다.
 */
export async function verifyTotp(c: TotpCheck): Promise<{ ok: true; step: number } | { ok: false }> {
  checkDigits(c.digits);
  for (const w of [c.pastWindow, c.futureWindow]) if (!Number.isSafeInteger(w) || w < 0) throw new Error("TOTP 시간창이 0 이상의 정수가 아니다");
  if (c.pastWindow + c.futureWindow + 1 > TOTP_WINDOW_STEPS_LIMIT) throw new Error("TOTP 시간창이 구현 한계를 넘는다");
  const now = timeStep(c.nowMs, c.periodS);
  const key = await hmacKey(c.secret, c.algorithm);
  const wellFormed = typeof c.code === "string" && c.code.length === c.digits && /^[0-9]+$/.test(c.code);
  // 형식이 틀려도 같은 양의 계산을 한다. 비교 대상은 같은 길이의 고정 문자열로 바꾼다
  const given = wellFormed ? c.code : "x".repeat(c.digits);
  let matched = -1;
  for (let s = now - c.pastWindow; s <= now + c.futureWindow; s++) {
    if (s < 0) continue;
    const expected = await hotpWithKey(key, s, c.digits);
    if (constantTimeEqual(expected, given) && wellFormed) matched = s;
  }
  return matched >= 0 ? { ok: true, step: matched } : { ok: false };
}

// ---------- seed·otpauth URI ----------

/** 무작위 seed. 길이는 정책(seedBytes)에서 받는다 */
export function generateSecret(bytes: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("seed 길이가 양의 정수가 아니다");
  return crypto.getRandomValues(new Uint8Array(bytes));
}

const URI_ALGORITHM: Record<TotpAlgorithm, string> = { "SHA-1": "SHA1", "SHA-256": "SHA256", "SHA-512": "SHA512" };

/**
 * 인증 앱 등록용 otpauth URI (Key Uri Format).
 * otpauth://totp/{issuer}:{account}?secret=..&issuer=..&algorithm=..&digits=..&period=..
 * 매개변수를 모두 명시한다 — 앱 기본값에 기대지 않는다.
 */
export function otpauthUri(o: { issuer: string; account: string; secret: Uint8Array; periodS: number; digits: number; algorithm: TotpAlgorithm }): string {
  if (!o.issuer || o.issuer.includes(":") || !o.account || o.account.includes(":")) throw new Error("otpauth 발급자·계정 이름에 ':' 을 쓸 수 없고 비워 둘 수 없다");
  const label = `${encodeURIComponent(o.issuer)}:${encodeURIComponent(o.account)}`;
  const q = new URLSearchParams({
    secret: base32Encode(o.secret),
    issuer: o.issuer,
    algorithm: URI_ALGORITHM[o.algorithm],
    digits: String(o.digits),
    period: String(o.periodS),
  });
  return `otpauth://totp/${label}?${q.toString().replace(/\+/g, "%20")}`;
}
