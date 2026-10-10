// 런타임 어댑터 TC 가운데 DB 서버가 필요 없는 것 (pnpm test). 임대가 필요한 주기 작업은 SQLite 파일 DB 를 쓴다.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { connectNode, createNodeRuntime, listen } from "../src/node.ts";
import { assertClientIp, cronIntervalMinutes } from "../src/types.ts";
import { createWorkersRuntime } from "../src/workers.ts";
import { createTestDb } from "./dbs.ts";

const ok = () => new Response("ok");

describe("TC-S4.T1.c Workers clientIp 는 CF-Connecting-IP 를 쓰고 X-Forwarded-For 를 무시한다", () => {
  const rt = createWorkersRuntime({});
  it("두 헤더가 다른 요청 → CF-Connecting-IP 값", async () => {
    const req = new Request("https://app.example/api/auth/sign-in/email", {
      headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1, 10.0.0.1" },
    });
    expect(await rt.clientIp(req)).toBe("203.0.113.7");
  });
  it("CF-Connecting-IP 가 없으면 X-Forwarded-For 가 있어도 null", async () => {
    const req = new Request("https://app.example/", { headers: { "x-forwarded-for": "198.51.100.1" } });
    expect(await rt.clientIp(req)).toBeNull();
  });
});

describe("TC-S4.T1.e clientIp 어댑터가 IP 를 못 정하면 서버가 시작을 거부한다", () => {
  it("TCP 로 열면 시작 확인 요청의 소켓 주소로 IP 를 정해 시작한다", async () => {
    const rt = createNodeRuntime({ env: {} });
    const s = await listen(rt, ok, { port: 0, hostname: "127.0.0.1" });
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/`);
      expect(await res.text()).toBe("ok");
    } finally {
      await s.close();
    }
  });

  it("소켓 주소가 없는 연결(유닉스 소켓)로 열면 clientIp 가 null 이라 시작 예외, 서버는 닫힌다", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mg-rt-sock-"));
    const sock = path.join(dir, "app.sock");
    try {
      const rt = createNodeRuntime({ env: {} });
      await expect(listen(rt, ok, { path: sock })).rejects.toThrow(/클라이언트 IP 를 정하지 못한다/);
      // 닫혔으므로 같은 경로로 다시 열 수 있다 (예외 뒤에 서버가 남지 않는다)
      const again = createNodeRuntime({ env: {} });
      await expect(listen(again, ok, { path: sock })).rejects.toThrow(/클라이언트 IP/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("신뢰 프록시 오설정은 어댑터를 만들 때 거부한다", () => {
    expect(() => createNodeRuntime({ env: {}, trustedProxies: ["caddy"] })).toThrow(/신뢰 프록시 설정이 잘못됐다/);
    expect(() => createNodeRuntime({ env: {}, trustedProxies: ["10.0.0.0/33"] })).toThrow(/신뢰 프록시/);
    expect(() => createNodeRuntime({ env: {}, trustedProxies: ["172.16.0.0/12", "127.0.0.1"] })).not.toThrow();
  });

  it("assertClientIp: null 이면 예외, IP 면 그 값", async () => {
    const req = new Request("http://probe.invalid/");
    await expect(assertClientIp(() => null, req)).rejects.toThrow(/클라이언트 IP/);
    await expect(assertClientIp(() => "127.0.0.1", req)).resolves.toBe("127.0.0.1");
  });
});

describe("런타임 어댑터 공통", () => {
  it("cron 은 매분·N분마다 모양만 받는다", () => {
    expect(cronIntervalMinutes("* * * * *")).toBe(1);
    expect(cronIntervalMinutes("*/5 * * * *")).toBe(5);
    expect(() => cronIntervalMinutes("*/7 * * * *")).toThrow();
    expect(() => cronIntervalMinutes("0 3 * * *")).toThrow();
  });

  it("Node clientIp: 신뢰 프록시가 아닌 상대의 X-Forwarded-For 는 보지 않는다", async () => {
    const rt = createNodeRuntime({ env: {}, trustedProxies: ["10.0.0.2"] });
    const direct = new Request("http://app/", { headers: { "x-forwarded-for": "198.51.100.9" } });
    rt.bindPeer(direct, "203.0.113.5");
    expect(await rt.clientIp(direct)).toBe("203.0.113.5");
    const proxied = new Request("http://app/", { headers: { "x-forwarded-for": "198.51.100.9" } });
    rt.bindPeer(proxied, "10.0.0.2");
    expect(await rt.clientIp(proxied)).toBe("198.51.100.9");
    // 상대 주소를 묶지 않은 요청은 정할 수 없다
    expect(await rt.clientIp(new Request("http://app/"))).toBeNull();
  });

  it("Workers 주기 작업: 등록한 cron 의 작업만 돌고, 실패는 모아서 드러낸다", async () => {
    // 작업은 임대 아래에서 돈다 (K1.T2). workerd 없이 SQLite 연결을 넘긴다
    const db = await createTestDb("sqlite");
    const rt = createWorkersRuntime({}, { connect: () => connectNode(db.url) });
    onTestFinished(async () => {
      await rt.close();
      await db.drop();
    });
    const ran: string[] = [];
    rt.schedule("rebalance", "* * * * *", async () => void ran.push("rebalance"));
    rt.schedule("reconcile", "*/5 * * * *", async () => void ran.push("reconcile"));
    rt.schedule("broken", "*/5 * * * *", async () => {
      throw new Error("x");
    });
    await rt.runScheduled("* * * * *", Date.UTC(2026, 9, 1, 0, 5));
    expect(ran).toEqual(["rebalance"]);
    await expect(rt.runScheduled("*/5 * * * *", Date.UTC(2026, 9, 1, 0, 5))).rejects.toThrow(/1개 실패/);
    expect(ran).toEqual(["rebalance", "reconcile"]);
  });

  it("비밀 값과 요청 수 제한 저장소", () => {
    const node = createNodeRuntime({ env: { APP_ENCRYPTION_KEY: "k" } });
    const workers = createWorkersRuntime({ APP_ENCRYPTION_KEY: "k", NOT_STRING: 1 });
    expect(node.secret("APP_ENCRYPTION_KEY")).toBe("k");
    expect(workers.secret("APP_ENCRYPTION_KEY")).toBe("k");
    expect(workers.secret("NOT_STRING")).toBeUndefined();
    expect(node.rateLimitStore()).toEqual({ storage: "database" });
    expect(workers.rateLimitStore()).toEqual({ storage: "database" });
  });
});
