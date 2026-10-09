// check-sso-paths.mjs 음성 대조 (TC-S3.T1.d): sso 플러그인은 있는데 disabledPaths 가 없는 구성.
// 경로 이름이 주석에만 있으면 세지 않는다: "/sso/register"
import { betterAuth } from "better-auth";
import { sso } from "@better-auth/sso";

export const auth = betterAuth({
  emailAndPassword: { enabled: true },
  plugins: [sso()],
});
