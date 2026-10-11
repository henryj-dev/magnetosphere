// 가입 정책 (M2) — Node 네 DB (pnpm test:db). 서버 앱 전체(app.ts 앞 판정 + Better Auth 훅)로 가입을 보낸다.
// D1 판은 signup.workers.test.ts (같은 단언, checks.ts).
import { afterAll, beforeAll, describe, it } from "vitest";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../../../../packages/runtime/test/dbs.ts";
import { tcM2T1a, tcM2T3a, tcM2T5d, tcM2T5e, tcM2T8a, tcM2T8b, tcM2T8c } from "./checks.ts";
import { serverRig, type ServerRig } from "./env.ts";

describe.each(enabledDbs())("%s", (kind: DbKind) => {
  let t: TestDb;
  let rig: ServerRig;
  beforeAll(async () => {
    t = await createTestDb(kind);
    rig = await serverRig(LABEL[kind], { url: t.url });
  });
  afterAll(async () => {
    await rig?.close();
    await t?.drop();
  });

  it(`TC-M2.T1.a ${LABEL[kind]}: 정책 다섯 × 경로 둘 표 — open·domain_allowlist 만 공개 가입이 회원을 만든다, 행 수로 판정 (Q3·Q19 의존)`, () => tcM2T1a(rig));
});

describe.each(enabledDbs())("%s 하루 상한·설정 API", (kind: DbKind) => {
  let t: TestDb;
  let a: ServerRig;
  // 같은 DB 의 두 번째 인스턴스 (연결 풀 따로)
  let b: ServerRig;
  beforeAll(async () => {
    t = await createTestDb(kind);
    a = await serverRig(LABEL[kind], { url: t.url });
    b = await serverRig(LABEL[kind], { url: t.url });
  });
  afterAll(async () => {
    await a?.close();
    await b?.close();
    await t?.drop();
  });

  it(`TC-M2.T3.a ${LABEL[kind]}: 상한 3 — 차례 4건 +3·4번째 403 signup_cap·알림 1행, 인스턴스 둘 동시 10건은 센 값 == 생긴 공개 가입 수·500 0, 실패한 가입은 세지 않음, 초대는 상한 뒤에도 +1 (Q13 의존)`, () =>
    tcM2T3a(a, b, { atomicSignup: true }));
  it(`TC-M2.T5.d ${LABEL[kind]}: 감사 기록 문장이 실패한 PATCH → 500·설정 그대로·감사 0, 정상 PATCH → 설정과 감사 1행 (M1 리뷰)`, () => tcM2T5d(a));
  it(`TC-M2.T5.e ${LABEL[kind]}: 같은 updatedAt 으로 두 관리자가 같은 키 PATCH → 200 하나·409 stale_setting 하나, 다른 키는 둘 다 200 (M1 리뷰)`, () => tcM2T5e(a));
});

describe.each(enabledDbs())("%s 미인증 계정 선점", (kind: DbKind) => {
  let t: TestDb;
  let rig: ServerRig;
  beforeAll(async () => {
    t = await createTestDb(kind);
    rig = await serverRig(LABEL[kind], { url: t.url });
  });
  afterAll(async () => {
    await rig?.close();
    await t?.drop();
  });

  it(`TC-M2.T8.a ${LABEL[kind]}: 선점 → 피해자 가입 → 피해자 인증 → 공격자 비밀번호 로그인 401·세션 0, 재설정 뒤 피해자 로그인 200 (보안 리뷰 H1)`, () => tcM2T8a(rig));
  it(`TC-M2.T8.b ${LABEL[kind]}: 다툼 없는 정상 가입 → 인증 → 원래 비밀번호 로그인 200·재설정 메일 없음 (보안 리뷰 H1 대조)`, () => tcM2T8b(rig));
  it(`TC-M2.T8.c ${LABEL[kind]}: 재설정은 다른 세션을 모두 끊고 emailVerified 를 true 로 한다 (보안 리뷰 H1)`, () => tcM2T8c(rig));
});
