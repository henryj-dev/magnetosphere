// Better Auth 옵션 가운데 DB 스키마를 바꾸는 부분. 스키마 생성기(scripts/gen-schema.mjs)와
// Better Auth 구성(S3, packages/auth)이 같은 객체를 써서 테이블·칼럼이 어긋나지 않게 한다.
// 플러그인을 더하거나 스키마에 영향을 주는 옵션을 바꾸면 여기서 바꾸고 pnpm -C packages/db gen 을 돌린다.
import { sso } from "@better-auth/sso";
import { USER_ADDITIONAL_FIELDS } from "./schema/common.ts";

export const AUTH_SCHEMA_OPTIONS = {
  emailAndPassword: { enabled: true },
  user: { additionalFields: USER_ADDITIONAL_FIELDS },
  // 여러 인스턴스(MySQL·Postgres)에서도 한도를 함께 세도록 요청 수 제한 기록을 DB(rate_limit)에 둔다 (계획서 3.2).
  rateLimit: { storage: "database" },
  plugins: [sso()],
} as const;
