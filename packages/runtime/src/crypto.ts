// 비밀 값 암호화 (계획서 7장 "비밀 값"). oma_live_ 토큰, OIDC Client Secret, SAML 개인키를 DB 에 넣기 전에 쓴다.
// WebCrypto AES-256-GCM 만 쓰고 Node 전용 API(node:crypto, Buffer)를 부르지 않아 Node 와 Workers 가 같은 코드다.
// Docker → Workers 로 옮겨도 저장된 값을 그대로 읽는다 (TC-S4.T2.a).
//
// 형식: "v1:" + base64(iv 12바이트 ‖ 암호문 ‖ 인증 태그 16바이트). 키·알고리즘을 바꾸면 접두사를 올린다.
// 키: APP_ENCRYPTION_KEY = 32바이트를 base64 로 쓴 값. 길이가 다르면 시작을 거부한다 (TC-S4.T2.c).
// AAD: 값을 저장하는 자리 이름(예: "app_settings.mail_settings.apiKey")을 추가 인증 데이터로 묶는다.
//   암호문을 다른 칼럼·키로 옮겨 붙이면 복호화가 실패한다 (TC-S4.T2.d, S4 보안 리뷰 L3). AAD 는 암호문에 들어가지 않는다.

const PREFIX = "v1:";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface Cipher {
  /** aad: 값을 저장하는 자리 이름. 복호화 때 같은 값을 넘겨야 한다 */
  encrypt(plain: string, aad: string): Promise<string>;
  /** 변조·다른 키·다른 AAD·모르는 형식이면 예외 (TC-S4.T2.b, TC-S4.T2.d) */
  decrypt(token: string, aad: string): Promise<string>;
}

function aadBytes(aad: string): Uint8Array<ArrayBuffer> {
  if (typeof aad !== "string" || aad === "") throw new Error("AAD(저장 자리 이름)가 비어 있다");
  return new TextEncoder().encode(aad);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function createCipher(base64Key: string): Promise<Cipher> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64(base64Key.trim());
  } catch {
    throw new Error("APP_ENCRYPTION_KEY 가 base64 가 아니다");
  }
  if (raw.length !== KEY_BYTES) throw new Error(`APP_ENCRYPTION_KEY 는 ${KEY_BYTES}바이트여야 한다 (지금 ${raw.length}바이트)`);
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

  return {
    async encrypt(plain, aad) {
      const additionalData = aadBytes(aad);
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, new TextEncoder().encode(plain)));
      const out = new Uint8Array(IV_BYTES + sealed.length);
      out.set(iv);
      out.set(sealed, IV_BYTES);
      return PREFIX + toBase64(out);
    },
    async decrypt(token, aad) {
      const additionalData = aadBytes(aad);
      if (!token.startsWith(PREFIX)) throw new Error("모르는 암호문 형식 (v1: 접두사 없음)");
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = fromBase64(token.slice(PREFIX.length));
      } catch {
        throw new Error("암호문이 base64 가 아니다");
      }
      if (bytes.length < IV_BYTES + 16) throw new Error("암호문이 너무 짧다");
      try {
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES), additionalData }, key, bytes.subarray(IV_BYTES));
        return new TextDecoder("utf-8", { fatal: true }).decode(plain);
      } catch {
        // 인증 태그 불일치(변조·다른 키·다른 AAD). WebCrypto 오류 문구는 런타임마다 달라 같은 문구로 바꾼다
        throw new Error("복호화 실패: 암호문이 변조됐거나 키·저장 자리(AAD)가 다르다");
      }
    },
  };
}
