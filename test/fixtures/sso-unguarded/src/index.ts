// check-sso-paths.mjs 음성 대조 (TC-S3.T1.d): sso 플러그인은 있는데 disabledPaths 가 없는 구성.
// 검사기는 authOptions() 의 결과만 본다. 경로 문자열이 파일 어딘가에 있어도 통과하지 않는다:
const NOT_WIRED = ["/sso/register", "/sso/update-provider", "/sso/delete-provider", "/sso/request-domain-verification", "/sso/verify-domain", "/sso/providers", "/sso/get-provider"];

export function authOptions(_cfg: unknown) {
  void NOT_WIRED;
  return { emailAndPassword: { enabled: true }, plugins: [{ id: "sso" }] };
}
