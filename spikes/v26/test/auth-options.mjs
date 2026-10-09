// 스키마 생성과 테스트가 함께 쓰는 Better Auth 옵션 조각.
import { sso } from "@better-auth/sso";
export const ssoPlugin = (opts = {}) => sso(opts);
export function authOptionsForSchema() {
  return { emailAndPassword: { enabled: true }, plugins: [ssoPlugin()] };
}
