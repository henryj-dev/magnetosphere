// Better Auth 1.7.7 의 Drizzle 스키마 생성기(@better-auth/drizzle-adapter createSchema)로
// 세 방언(sqlite·mysql·pg)의 스키마 파일을 만든다. 테스트가 쓰는 설정(sso 플러그인)과 같은 옵션으로 생성한다.
import { writeFileSync } from "node:fs";
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { authOptionsForSchema } from "./test/auth-options.mjs";

for (const provider of ["sqlite", "mysql", "pg"]) {
  const options = authOptionsForSchema();
  const adapter = drizzleAdapter({}, { provider })(options);
  const out = await adapter.createSchema(options, `schema/${provider}.ts`);
  // relations-v2 생성기는 drizzle 1.0 의 defineRelationsPart 를 덧붙인다. 0.45 에는 없고 테스트에 필요 없어 잘라낸다.
  const code = out.code
    .split("\nexport const authRelations")[0]
    .replace(/import \{ defineRelationsPart \} from "drizzle-orm";\n/, "")
    .replace("import { defineRelationsPart, ", "import { ");
  writeFileSync(`schema/${provider}.ts`, code);
  console.log(`[gen] schema/${provider}.ts`, out.code.length, "bytes");
}
