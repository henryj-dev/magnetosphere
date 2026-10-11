// TC-M1.T1.d 같은 키 동시 쓰기 (pnpm test:db, Node 네 DB). 설정 저장소(writeSetting)와 설치의 설정 쓰기(setup/index.ts)가
// 한 문장 upsert 라 같은 키를 20건 동시에 써도 기본 키 충돌이 없고 행이 정확히 하나 남는지 본다. D1 판은 concurrent.workers.test.ts.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../../../../packages/runtime/test/dbs.ts";
import { writeSetting } from "../../src/settings/index.ts";
import { PUBLIC_BASE_URL_KEY, writeSetting as writeSetupSetting } from "../../src/setup/index.ts";

const N = 20;
const NOW = new Date("2026-10-11T00:00:00.000Z");

describe.each(enabledDbs())("%s", (kind: DbKind) => {
  let t: TestDb;
  let h: DbHandle;
  beforeAll(async () => {
    t = await createTestDb(kind);
    h = await connectNode(t.url);
  });
  afterAll(async () => {
    await h?.close();
    await t?.drop();
  });

  const rowsOf = async (key: string) => {
    const s = h.schema.appSettings;
    return (await h.db.select({ value: s.value }).from(s).where(eq(s.key, key))).map((r: { value: string }) => JSON.parse(r.value));
  };
  const failures = (rs: PromiseSettledResult<unknown>[]) => rs.flatMap((r) => (r.status === "rejected" ? [String((r.reason as Error)?.message ?? r.reason).slice(0, 200)] : []));

  it(`TC-M1.T1.d ${LABEL[kind]}: 같은 키에 쓰기 ${N}건 동시 → 실패 0·행 정확히 1·값은 ${N}개 중 하나 (설정 저장소·설치 쓰기)`, async () => {
    // 설정 저장소: 행이 없는 키에 동시에 처음 쓰기
    const caps = Array.from({ length: N }, (_, i) => i);
    expect(failures(await Promise.allSettled(caps.map((v) => writeSetting(h, "daily_signup_cap", v, "admin-1", NOW)))), "writeSetting 실패").toEqual([]);
    const cap = await rowsOf("daily_signup_cap");
    expect(cap).toHaveLength(1);
    expect(caps).toContain(cap[0]);

    // 설치의 설정 쓰기: 이미 있는 public_base_url 을 동시에 바꾸기. 지우고 넣기면 넣기끼리 기본 키가 부딪힌다
    await writeSetupSetting(h, PUBLIC_BASE_URL_KEY, "https://first.example", "admin-1");
    const urls = Array.from({ length: N }, (_, i) => `https://llm-${i}.example`);
    expect(failures(await Promise.allSettled(urls.map((u) => writeSetupSetting(h, PUBLIC_BASE_URL_KEY, u, "admin-1")))), "설치 writeSetting 실패").toEqual([]);
    const url = await rowsOf(PUBLIC_BASE_URL_KEY);
    expect(url).toHaveLength(1);
    expect(urls).toContain(url[0]);
  });
});
