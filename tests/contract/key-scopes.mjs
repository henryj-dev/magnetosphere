// 계약 시험 도구: 대시보드 쿠키로 OmniRoute 키에 범위(scopes)를 붙인다 (2단계 실행판 TC-K3.T3.c, V10 privilegeEscalation 재현).
// 회원 앱 어댑터(packages/omniroute)는 scopes 를 보내지 못한다 (계획서 5.8, TC-S5.T2.i). 그래서 "누가 회원 키에 manage 를 붙인"
// 상태는 시험이 이 도구로 OmniRoute 에 직접 만든다. 회원 앱 코드는 이 파일을 쓰지 않는다.

/**
 * @param {string} baseUrl 계약 환경 OmniRoute 주소 (예: http://127.0.0.1:20170)
 * @param {string} password 대시보드 비밀번호 (INITIAL_PASSWORD)
 * @param {string} keyId OmniRoute 키 id
 * @param {string[]} scopes 붙일 범위 (예: ["manage"])
 * @returns {Promise<number>} PATCH 응답 상태코드
 */
export async function grantScopes(baseUrl, password, keyId, scopes) {
  const origin = new URL(baseUrl).origin;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ password }),
  });
  const cookie = login.headers.getSetCookie().map((s) => s.split(";")[0]).find((s) => s.startsWith("auth_token="));
  if (!cookie) throw new Error(`대시보드 로그인 실패 (${login.status})`);
  const res = await fetch(`${baseUrl}/api/keys/${encodeURIComponent(keyId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ scopes }),
  });
  await res.text();
  return res.status;
}
