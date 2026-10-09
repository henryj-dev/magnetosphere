// TC-S3.T1.e: packages/auth 의 Better Auth 옵션으로 getAuthTables 를 돌린 결과가 packages/db 공통 정의
// (common.ts 의 better-auth 소유 테이블)와 같은지 본다. 스키마 생성기(packages/db/scripts/gen-schema.mjs)도
// 같은 AUTH_SCHEMA_OPTIONS 로 검사하지만, 여기서는 실제 구성(authOptions)이 그 객체를 빠짐없이 쓰는지를 본다.
import { getAuthTables } from "better-auth/db";
import { describe, expect, test } from "vitest";
import { TABLES } from "@magnetosphere/db/src/schema/common.ts";
import { authOptions } from "../src/index.ts";
import { consoleMailer } from "../src/mail/index.ts";
import { BASE } from "./client.ts";
import { SECRET } from "./helpers.ts";

// Better Auth 필드 타입마다 받아들이는 공통 정의 칼럼 종류 (생성기와 같은 표)
const BA_KINDS: Record<string, string[]> = { string: ["id", "string", "text", "json"], number: ["integer", "bigint", "usd"], boolean: ["boolean"], date: ["timestamp"] };

/** 어긋난 점 목록. 빈 배열이면 같다 */
export function diffAuthTables(options: Parameters<typeof getAuthTables>[0]): string[] {
  const problems: string[] = [];
  const ba = Object.values(getAuthTables(options));
  const ours = Object.entries(TABLES).filter(([, t]) => t.owner === "better-auth");
  const baNames = new Set(ba.map((t) => t.modelName));
  for (const [key] of ours) if (!baNames.has(key)) problems.push(`${key}: 공통 정의엔 있는데 구성에 없는 테이블`);
  for (const t of ba) {
    const mine = TABLES[t.modelName];
    if (!mine || mine.owner !== "better-auth") {
      problems.push(`${t.modelName}: 구성엔 있는데 공통 정의에 없는 테이블`);
      continue;
    }
    const fields = Object.entries(t.fields).map(([k, f]) => [f.fieldName ?? k, f] as const);
    for (const [name, f] of fields) {
      const c = mine.columns[name];
      const at = `${t.modelName}.${name}`;
      if (!c) {
        problems.push(`${at}: 칼럼 없음`);
        continue;
      }
      if (!BA_KINDS[f.type as string]?.includes(c.kind)) problems.push(`${at}: 타입 ${String(f.type)} ≠ ${c.kind}`);
      if (!!f.required !== !!c.notNull && !(c.notNull && (c.default !== undefined || c.defaultNow))) problems.push(`${at}: 필수 여부 불일치`);
      if (f.required && !c.notNull) problems.push(`${at}: 필수인데 NULL 허용`);
      if (!!f.unique !== !!c.unique) problems.push(`${at}: 고유 여부 불일치`);
      if (f.defaultValue !== undefined && typeof f.defaultValue !== "function" && f.defaultValue !== c.default) problems.push(`${at}: 기본값 불일치`);
      const r = f.references;
      if (!!r !== !!c.references) problems.push(`${at}: 참조 유무 불일치`);
      else if (r && (r.model !== c.references!.table || r.field !== c.references!.column || (r.onDelete ?? "cascade") !== c.references!.onDelete)) problems.push(`${at}: 참조 대상 불일치`);
    }
    for (const col of Object.keys(mine.columns)) if (col !== "id" && !fields.some(([n]) => n === col)) problems.push(`${t.modelName}.${col}: 구성이 모르는 칼럼`);
  }
  return problems;
}

const options = () => authOptions({ database: { db: {}, provider: "sqlite", schema: {} }, baseURL: BASE, secret: SECRET, mailer: consoleMailer(), clientIp: () => null, waitUntil: () => {}, onMailError: () => {} });

describe("TC-S3.T1.e 구성과 스키마", () => {
  test("TC-S3.T1.e Better Auth 구성의 테이블이 공통 정의와 같다", () => {
    const o = options();
    expect(o.plugins.map((p) => p.id)).toContain("sso");
    expect(o.rateLimit.storage).toBe("database");
    expect(diffAuthTables(o)).toEqual([]);
  });

  test("TC-S3.T1.e 음성 대조: 플러그인을 더하면 어긋남을 잡는다", () => {
    const o = options();
    const extra = { id: "extra", schema: { extraThing: { fields: { label: { type: "string", required: true } } } } } as const;
    expect(diffAuthTables({ ...o, plugins: [...o.plugins, extra as any] })).toContain("extraThing: 구성엔 있는데 공통 정의에 없는 테이블");
  });

  test("TC-S3.T1.e 음성 대조: rateLimit 저장소를 바꾸면 어긋남을 잡는다", () => {
    const o = options();
    expect(diffAuthTables({ ...o, rateLimit: { ...o.rateLimit, storage: "memory" } })).toContain("rateLimit: 공통 정의엔 있는데 구성에 없는 테이블");
  });

  test("TC-S3.T1.e 음성 대조: 추가 칼럼을 빼면 어긋남을 잡는다", () => {
    const o = options();
    expect(diffAuthTables({ ...o, user: {} })).toContain("user.role: 구성이 모르는 칼럼");
  });
});
