// S3.T3: 인증 경로 요청 수 제한과 클라이언트 IP. 저장소가 DB(rate_limit)라 네 DB 에서 돈다.
// clientIp 는 런타임 어댑터 대신 가짜를 쓴다: 소켓 상대 주소를 테스트 전용 헤더 x-test-peer 로 넘기고,
// 실제 Node 어댑터(S4.T1)가 쓸 resolveClientIp 로 신뢰 프록시·X-Forwarded-For 를 판정한다.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { betterAuth } from "better-auth";
import { authOptions, CLIENT_IP_HEADER, RATE_LIMIT_RULES, resolveClientIp, type ClientIp } from "../src/index.ts";
import { client, email } from "./client.ts";
import { ALL_DBS, OPEN, type TestDb } from "./db.ts";
import { makeAuth, makeAuthConfig } from "./helpers.ts";

const N = RATE_LIMIT_RULES["/sign-in/*"].max;
const TRUSTED = ["10.0.0.0/8"];

/** 가짜 런타임 어댑터. 상대 주소는 x-test-peer 헤더 (실제 어댑터는 소켓에서 읽는다) */
const fakeAdapter =
  (trustedProxies: string[]): ClientIp =>
  (req) =>
    resolveClientIp(req.headers.get("x-test-peer"), req.headers.get("x-forwarded-for"), trustedProxies);

let seq = 0;
const randomPublicIp = () => `203.0.113.${(seq++ % 250) + 1}`;

describe.each(ALL_DBS)("요청 수 제한 — %s", (kind) => {
  let h: TestDb;
  beforeAll(async () => {
    h = await OPEN[kind]();
  });
  afterAll(async () => {
    await h?.close();
  });

  /** 틀린 비밀번호 로그인 한 번 */
  const wrongLogin = (app: ReturnType<typeof makeAuth>, target: string, headers: Record<string, string>) =>
    client(app.handler).post("/sign-in/email", { email: target, password: "wrong-password-0000" }, headers);

  test("TC-S3.T3.a 같은 IP 의 반복 로그인 실패는 N+1 번째에 429", async () => {
    const app = makeAuth(h, { clientIp: fakeAdapter([]) });
    const target = email("brute");
    const peer = { "x-test-peer": "192.0.2.10" };
    for (let i = 1; i <= N; i++) expect((await wrongLogin(app, target, peer)).status, `${i}번째`).toBe(401);
    const last = await wrongLogin(app, target, peer);
    expect(last.status).toBe(429);
    // 한도는 DB(rate_limit)에 센다 (여러 인스턴스가 함께 센다, 계획서 3.2)
    const rows = await h.db.select().from((h.schema as any).rateLimit);
    expect(rows.find((r: any) => r.key === "192.0.2.10|/sign-in/email")?.count).toBe(N);
    // 대조: 다른 IP 는 따로 센다
    expect((await wrongLogin(app, target, { "x-test-peer": "192.0.2.11" })).status).toBe(401);
  });

  test("TC-S3.T3.b 신뢰하지 않는 출처의 X-Forwarded-For 는 무시된다", async () => {
    const app = makeAuth(h, { clientIp: fakeAdapter(TRUSTED) });
    const target = email("spoof");
    const statuses: number[] = [];
    for (let i = 0; i <= N; i++) {
      // 직접 붙은 공격자가 X-Forwarded-For 와 우리 내부 헤더를 매번 바꿔 보낸다
      const r = await wrongLogin(app, target, { "x-test-peer": "198.51.100.9", "x-forwarded-for": randomPublicIp(), [CLIENT_IP_HEADER]: randomPublicIp() });
      statuses.push(r.status);
    }
    expect(statuses).toEqual([...Array(N).fill(401), 429]);
  });

  test("TC-S3.T3.c 신뢰 프록시 뒤에서는 실제 클라이언트별로 센다", async () => {
    const app = makeAuth(h, { clientIp: fakeAdapter(TRUSTED) });
    const target = email("proxy");
    const viaProxy = (xff: string) => ({ "x-test-peer": "10.0.0.2", "x-forwarded-for": xff });
    for (const c of ["192.0.2.21", "192.0.2.22"]) {
      for (let i = 1; i <= N; i++) expect((await wrongLogin(app, target, viaProxy(c))).status, `${c} ${i}번째`).toBe(401);
    }
    // 한도를 다 쓴 클라이언트가 왼쪽에 다른 주소를 지어 넣어도 프록시가 덧붙인 실제 주소로 센다
    expect((await wrongLogin(app, target, viaProxy("1.2.3.4, 192.0.2.21"))).status).toBe(429);
    expect((await wrongLogin(app, target, viaProxy("192.0.2.22"))).status).toBe(429);
  });
});

describe("resolveClientIp", () => {
  test("TC-S3.T3.b 신뢰하지 않는 상대의 X-Forwarded-For 는 보지 않는다", () => {
    expect(resolveClientIp("198.51.100.9", "192.0.2.1", TRUSTED)).toBe("198.51.100.9");
    expect(resolveClientIp("198.51.100.9", "192.0.2.1", [])).toBe("198.51.100.9");
    expect(resolveClientIp("not-an-ip", "192.0.2.1", TRUSTED)).toBeNull();
  });

  test("TC-S3.T3.c 신뢰 프록시 뒤에서는 오른쪽부터 첫 비신뢰 주소", () => {
    expect(resolveClientIp("10.0.0.2", "192.0.2.1", TRUSTED)).toBe("192.0.2.1");
    expect(resolveClientIp("10.0.0.2", "1.2.3.4, 192.0.2.1, 10.0.0.9", TRUSTED)).toBe("192.0.2.1");
    expect(resolveClientIp("10.0.0.2", null, TRUSTED)).toBe("10.0.0.2");
  });
});

describe("감싼 handler 만 내보낸다 (SQLite)", () => {
  let h: TestDb;
  beforeAll(async () => {
    h = await OPEN.sqlite();
  });
  afterAll(async () => {
    await h?.close();
  });

  test("TC-S3.T3.d HTTP 요청을 받는 함수는 감싼 handler 하나뿐이고 위조 헤더로 우회되지 않는다", async () => {
    // 패키지 진입점(".")이 내보내는 것과 createAuth 의 반환값
    const pkg = await import("../src/index.ts");
    expect(Object.keys(pkg).sort()).toEqual(["CLIENT_IP_HEADER", "RATE_LIMIT_RULES", "SSO_DISABLED_PATHS", "authOptions", "createAuth", "resolveClientIp"]);
    const cfg = { clientIp: fakeAdapter([]) };
    const app = makeAuth(h, cfg);
    expect(Object.keys(app).filter((k) => !["outbox", "mailErrors", "settle"].includes(k)).sort()).toEqual(["api", "handler"]);
    expect("handler" in app.api).toBe(false);

    const spoof = () => ({ "x-test-peer": "192.0.2.50", [CLIENT_IP_HEADER]: randomPublicIp() });
    const target = email("spoof-hdr");
    const login = (handler: (r: Request) => Promise<Response>) =>
      client(handler).post("/sign-in/email", { email: target, password: "wrong-password-0000" }, spoof());
    const wrapped: number[] = [];
    for (let i = 0; i <= N; i++) wrapped.push((await login(app.handler)).status);
    expect(wrapped).toEqual([...Array(N).fill(401), 429]);

    // 대조: 감싸지 않은 Better Auth handler 는 같은 위조로 우회된다
    const raw = betterAuth(authOptions({ ...makeAuthConfig(h), ...cfg }));
    const unwrapped: number[] = [];
    for (let i = 0; i <= N; i++) unwrapped.push((await login(raw.handler)).status);
    expect(unwrapped).not.toContain(429);
  });
});
