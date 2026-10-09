// Compose 배포 묶음 TC (실행판 S6.T2). pnpm test:deploy [-t "TC-S6.T2.a"] 로 돈다 (tests/deploy/run.mjs).
// 실제 Compose 묶음(caddy·migrate·app·omniroute)을 띄운다. 묶음은 고른 TC 가 처음 필요로 할 때 띄우고 끝나면 볼륨째 지운다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, describe, test } from "node:test";
import https from "node:https";
import { APP_IMAGE, buildAppImage, createAdmin, createStack, ROOT, signIn, startCaddyProbe } from "./stack.mjs";

const V16 = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/verify/V16.json"), "utf8")).answer;
const HTTP_PORT = 28480;
const WARN_XFF = /신뢰 프록시가 아닌 .* X-Forwarded-For 를 보냈다/g;
const WARN_PASSWORD = /OMNIROUTE_INITIAL_PASSWORD 가 남아 있다/g;
const count = (text, re) => (text.match(re) ?? []).length;

let shared;
let admin;
/** SQLite 기본 묶음 하나를 TC 들이 같이 쓴다 */
function stack() {
  if (!shared) {
    shared = createStack({ httpPort: HTTP_PORT });
    shared.up();
  }
  return shared;
}
/** 공용 묶음에 관리자를 한 번 만든다 */
async function ensureAdmin() {
  const s = stack();
  if (!admin) {
    const r = await createAdmin(s.baseUrl, s.setupToken());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    admin = r;
  }
  return admin;
}
/** 묶음 안의 서비스 컨테이너에서 node 로 fetch 한다 (요청의 출발지가 그 컨테이너가 된다) */
function fetchFrom(s, service, url, init = {}) {
  const script = `fetch(${JSON.stringify(url)}, ${JSON.stringify(init)}).then(async r => { const h = {}; r.headers.forEach((v, k) => { h[k] = k === "set-cookie" ? r.headers.getSetCookie() : v }); console.log(JSON.stringify({ status: r.status, headers: h, body: await r.text() })) })`;
  const r = s.compose("exec", "-T", service, "node", "-e", script);
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out.trim().split("\n").at(-1));
}
/** 서비스 컨테이너의 망별 IP */
function containerIp(s, service, network) {
  const id = s.compose("ps", "-q", service).out.trim();
  const r = spawnSync("docker", ["inspect", id], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout)[0].NetworkSettings.Networks[`${s.project}_${network}`].IPAddress;
}

/** 경로를 정리하지 않고 그대로 보낸다 (curl --path-as-is 처럼). fetch 는 ./.. 와 // 를 정리한다 */
function rawRequest(baseUrl, rawPath, { method = "GET", headers = {}, body } = {}) {
  const u = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method, path: rawPath, headers: { host: u.host, ...headers }, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

after(() => shared?.down());

test("TC-S6.T2.a Caddy 를 거친 키 없는 /v1 은 401", async () => {
  const s = stack();
  const res = await fetch(`${s.baseUrl}/v1/models`);
  assert.equal(res.status, 401);
  // OmniRoute 가 답했다 (회원 앱의 404 JSON 이 아니다)
  assert.match(await res.text(), /AUTH_00\d/);
  // 본문 상한 (S6 보안 리뷰 L2): /v1 은 10MB. 1MB 대화는 OmniRoute 에 닿고(키가 없어 401), 11MB 는 Caddy 가 413
  const post = (bytes) => fetch(`${s.baseUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(bytes) });
  assert.equal((await post(1_000_000)).status, 401);
  assert.equal((await post(11_000_000)).status, 413);
});

test("TC-S6.T2.b 허용 목록 밖 /v1 경로는 Caddy 에서 404", async () => {
  const s = stack();
  // 허용 목록 우회 탐침 (S6 보안 리뷰 L1): 인코딩한 /·.., 겹 /, 대문자, 빈 구간, 경로 매개변수(;)
  const probes = [
    "/v1/models/a%2F..%2F..%2Fregistered-keys",
    "//v1/registered-keys",
    "/V1/registered-keys",
    "/v1/responses/%2e%2e/registered-keys",
    "/v1/models/",
    "/v1/responses/x;/../../registered-keys",
  ];
  for (const p of probes) {
    for (const method of ["GET", "POST"]) {
      const res = await rawRequest(s.baseUrl, p, { method });
      assert.equal(res.status, 404, `${method} ${p} (경로 그대로) → ${res.status}`);
      assert.doesNotMatch(res.body, /AUTH_00\d/, `${method} ${p} 본문에 OmniRoute 오류 코드`);
    }
  }
  const paths = ["/v1/management/proxy-subscriptions", "/v1/session-leases", ...V16.deny, "/v1/models/mko/mock-gpt", "/v1/responses/x/y", "/v1/zzz"];
  for (const p of new Set(paths)) {
    for (const method of ["GET", "POST"]) {
      const res = await fetch(`${s.baseUrl}${p}`, { method });
      const body = await res.text();
      assert.equal(res.status, 404, `${method} ${p} → ${res.status}`);
      assert.doesNotMatch(body, /AUTH_00\d/, `${method} ${p} 본문에 OmniRoute 오류 코드`);
    }
  }
  // 대조: 허용 목록은 OmniRoute 에 닿는다 (키가 없어 401)
  for (const p of V16.allow.map((a) => a.replace("*", "x"))) {
    const res = await fetch(`${s.baseUrl}${p}`, { method: "POST" });
    assert.notEqual(res.status, 404, `허용 경로 ${p} 가 404`);
    assert.match(await res.text(), /AUTH_00\d|error/, p);
  }
});

test("TC-S6.T2.c /api/* 는 OmniRoute 가 아니라 회원 앱으로 간다", async () => {
  const s = stack();
  for (const p of ["/api/keys", "/api/usage/analytics", "/api/cli/whoami"]) {
    const res = await fetch(`${s.baseUrl}${p}`);
    assert.equal(res.status, 404, p);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = await res.text();
    assert.deepEqual(JSON.parse(body), { error: "not_found" }, p);
    assert.doesNotMatch(body, /Invalid management token/);
  }
  // 회원 앱 자신의 /api 는 그대로 닿는다
  const ok = await fetch(`${s.baseUrl}/api/auth/ok`);
  assert.deepEqual(await ok.json(), { ok: true });
  // 본문 상한 (S6 보안 리뷰 L2): 회원 앱 쪽은 64KiB. 앱이 본문을 보지 않는 경로(POST /)도 Caddy 가 413
  assert.equal((await fetch(`${s.baseUrl}/`, { method: "POST", body: "x".repeat(70 * 1024) })).status, 413);
  assert.notEqual((await fetch(`${s.baseUrl}/`, { method: "POST", body: "x".repeat(1024) })).status, 413);

  // 클라이언트가 지어낸 IP 헤더는 뒤로 넘기지 않는다 (S6 보안 리뷰 L2). Caddy 단독 + 메아리 서버로 넘어간 헤더를 본다
  const probe = startCaddyProbe({ siteAddress: ":80", httpPort: HTTP_PORT + 20, httpsPort: HTTP_PORT + 21 });
  try {
    const seen = await echoed(`http://127.0.0.1:${HTTP_PORT + 20}`, "/api/whatever", { "x-real-ip": "203.0.113.7", "cf-connecting-ip": "203.0.113.8", "x-other": "kept" });
    assert.equal(seen.headers["x-real-ip"], undefined);
    assert.equal(seen.headers["cf-connecting-ip"], undefined);
    assert.equal(seen.headers["x-other"], "kept", "대조: 다른 헤더는 넘어간다");
    const v1 = await echoed(`http://127.0.0.1:${HTTP_PORT + 20}`, "/v1/models", { "x-real-ip": "203.0.113.7", "cf-connecting-ip": "203.0.113.8" });
    assert.equal(v1.path, "/v1/models");
    assert.equal(v1.headers["x-real-ip"], undefined);
    assert.equal(v1.headers["cf-connecting-ip"], undefined);
  } finally {
    probe.stop();
  }
});

/** 메아리 서버가 받은 요청 (Caddy 가 뜰 때까지 기다린다) */
async function echoed(base, p, headers) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(`${base}${p}`, { headers });
      if (res.ok) return await res.json();
    } catch {
      // 아직 안 떴다
    }
    if (i > 100) throw new Error(`${base}${p} 가 응답하지 않는다`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** 자체 서명 인증서를 받아들이고 HTTPS 응답 헤더 하나를 읽는다 (Caddy 가 뜰 때까지 기다린다) */
async function httpsHeader(port, p, name) {
  for (let i = 0; ; i++) {
    try {
      return await new Promise((resolve, reject) => {
        const req = https.request({ host: "127.0.0.1", port, path: p, servername: "localhost", headers: { host: "localhost" }, rejectUnauthorized: false, agent: false }, (res) => {
          res.resume();
          resolve(res.headers[name] ?? null);
        });
        req.on("error", reject);
        req.end();
      });
    } catch (e) {
      if (i > 100) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

test("TC-S6.T2.d OmniRoute 포트는 루프백에만 열린다", async () => {
  // 시험 덧씌우기 없이 운영 설정 그대로 본다. 묶음은 띄우지 않는다
  const s = createStack({ httpPort: HTTP_PORT, label: "config" });
  try {
    const r = s.composeBase("config", "--format", "json");
    assert.equal(r.code, 0, r.err);
    const cfg = JSON.parse(r.out);
    const ports = cfg.services.omniroute.ports ?? [];
    assert.ok(ports.length >= 1, "대시보드 포트 정의가 없다");
    for (const p of ports) assert.equal(p.host_ip, "127.0.0.1", JSON.stringify(p));
    assert.deepEqual(ports.map((p) => `${p.host_ip}:${p.published}:${p.target}`), ["127.0.0.1:20128:20128"]);
    // app·migrate·DB 는 호스트에 포트를 열지 않는다. 공개 포트는 caddy 뿐이다
    for (const [name, svc] of Object.entries(cfg.services)) {
      if (name === "caddy" || name === "omniroute") continue;
      assert.equal((svc.ports ?? []).length, 0, `${name} 가 호스트 포트를 연다`);
    }
    // app·migrate 권한 축소 (S6 보안 리뷰 L4)
    for (const name of ["app", "migrate"]) {
      const svc = cfg.services[name];
      assert.deepEqual(svc.cap_drop, ["ALL"], `${name}.cap_drop`);
      assert.ok((svc.security_opt ?? []).some((o) => /^no-new-privileges(:true)?$/.test(o)), `${name}.security_opt`);
      assert.equal(svc.read_only, true, `${name}.read_only`);
    }
    // DB 이미지는 digest 로 고정한다
    const all = JSON.parse(s.composeBase("--profile", "mysql", "--profile", "postgres", "config", "--format", "json").out);
    for (const name of ["mysql", "postgres"]) assert.match(all.services[name]?.image ?? "", /@sha256:[0-9a-f]{64}$/, `${name}.image`);

    // .dev.vars(wrangler 로컬 비밀 값)는 이미지에 들어가지 않는다. 없으면 시험용으로 하나 두고 이미지를 다시 만든다
    const devVars = path.join(ROOT, "apps/server/.dev.vars");
    const made = !fs.existsSync(devVars);
    if (made) fs.writeFileSync(devVars, "SETUP_TOKEN=must-not-be-in-image\n");
    try {
      buildAppImage();
      const found = spawnSync("docker", ["run", "--rm", APP_IMAGE, "sh", "-c", "find /repo -name '.dev.vars*' -not -path '*/node_modules/*'"], { encoding: "utf8" });
      assert.equal(found.status, 0, found.stderr);
      assert.equal(found.stdout.trim(), "", `이미지 안에 .dev.vars: ${found.stdout}`);
    } finally {
      if (made) fs.rmSync(devVars);
    }

    // HTTPS 로 받을 때 Caddy 가 HSTS 를 단다 (S6 보안 리뷰 L2). 뒤가 메아리 서버라 이 헤더는 Caddy 가 단 것이다
    // (회원 앱도 보안 헤더로 HSTS 를 달지만 OmniRoute /v1 응답에는 없다). 도메인 대신 localhost 로 Caddy 내부 인증서를 받는다
    const probe = startCaddyProbe({ siteAddress: "localhost", httpPort: HTTP_PORT + 20, httpsPort: HTTP_PORT + 21 });
    try {
      const hsts = await httpsHeader(HTTP_PORT + 21, "/v1/models", "strict-transport-security");
      assert.match(hsts ?? "", /max-age=\d{7,}/, `HTTPS 응답의 HSTS: ${hsts}`);
    } finally {
      probe.stop();
    }
  } finally {
    s.down();
  }
});

describe("TC-S6.T2.e Caddy 뒤에서 클라이언트별로 세고, 프록시 설정 누락은 경고로 드러난다", () => {
  test("TC-S6.T2.e 설정 기본값·클라이언트별 세션 IP·비신뢰 X-Forwarded-For 경고 1줄", async () => {
    const s = stack();
    const cfg = JSON.parse(s.composeBase("config", "--format", "json").out);
    const trusted = cfg.services.app.environment.TRUSTED_PROXIES;
    assert.ok(trusted && trusted.trim(), "app.environment.TRUSTED_PROXIES 가 비어 있다");

    const a = await ensureAdmin();
    // 출발지 둘: 호스트(공개 포트) · omniroute 컨테이너(내부망). 둘 다 Caddy 를 거치고, Caddy 가 서로 다른 X-Forwarded-For 를 단다
    const fromHost = await signIn(s.baseUrl, a.email, a.password);
    assert.equal(fromHost.status, 200);
    const inner = fetchFrom(s, "omniroute", "http://caddy:80/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: s.baseUrl },
      body: JSON.stringify({ email: a.email, password: a.password }),
    });
    assert.equal(inner.status, 200, inner.body);
    const sessions = await (await fetch(`${s.baseUrl}/api/auth/list-sessions`, { headers: { cookie: fromHost.cookie, origin: s.baseUrl } })).json();
    const ips = sessions.map((x) => x.ipAddress);
    const caddyEdge = containerIp(s, "caddy", "edge");
    const omniInternal = containerIp(s, "omniroute", "internal");
    assert.ok(ips.includes(omniInternal), `내부망 출발지 IP ${omniInternal} 가 세션에 없다: ${ips}`);
    const hostIp = ips.find((ip) => ip !== omniInternal);
    assert.ok(hostIp, `호스트 출발지 세션이 없다: ${ips}`);
    assert.ok(!ips.includes(caddyEdge), `세션 IP 가 Caddy 주소 ${caddyEdge} 로 묶였다: ${ips}`);
    assert.equal(count(s.logs("app"), WARN_XFF), 0, "Caddy 만 거친 요청에 경고가 났다");

    // 신뢰 목록 밖(내부망의 omniroute 컨테이너)이 app 에 바로 X-Forwarded-For 를 보낸다 → 경고 정확히 1줄
    for (let i = 0; i < 3; i++) {
      const r = fetchFrom(s, "omniroute", "http://app:3000/api/auth/ok", { headers: { "x-forwarded-for": `198.51.100.${i + 1}` } });
      assert.equal(r.status, 200);
    }
    const logs = s.logs("app");
    assert.equal(count(logs, WARN_XFF), 1, logs.slice(-2000));
    assert.doesNotMatch(logs, /198\.51\.100\./, "지어낸 헤더 값이 로그에 찍혔다");
  });
});

test("TC-S6.T2.f 빈 DB 에서 Compose 를 띄우면 마이그레이션이 먼저 적용된다", async () => {
  const committed = (dialect) => JSON.parse(fs.readFileSync(path.join(ROOT, `packages/db/migrations/${dialect}/meta/_journal.json`), "utf8")).entries.length;
  const rows = {
    sqlite: (s) =>
      s.compose("exec", "-T", "-w", "/repo/packages/db", "app", "node", "-e",
        "const c=require('@libsql/client').createClient({url:process.env.DATABASE_URL});c.execute('select count(*) as n from __drizzle_migrations').then(r=>console.log(r.rows[0].n))"),
    mysql: (s) => s.compose("exec", "-T", "mysql", "sh", "-c", 'mysql -N -umagnetosphere -p"$MYSQL_PASSWORD" magnetosphere -e "select count(*) from __drizzle_migrations"'),
    postgres: (s) => s.compose("exec", "-T", "postgres", "psql", "-At", "-Umagnetosphere", "-dmagnetosphere", "-c", "select count(*) from drizzle.__drizzle_migrations"),
  };
  const dialect = { sqlite: "sqlite", mysql: "mysql", postgres: "pg" };
  // 공용 묶음이 떠 있으면 내려 메모리를 비운다. 뒤 TC 가 필요하면 새로 띄운다
  shared?.down();
  shared = admin = undefined;
  for (const db of ["sqlite", "mysql", "postgres"]) {
    const s = createStack({ db, httpPort: HTTP_PORT + 10, label: "migrate" });
    try {
      s.up();
      const res = await fetch(`${s.baseUrl}/api/setup`);
      assert.equal(res.status, 200, db);
      assert.deepEqual(await res.json(), { needed: true }, db);
      const r = rows[db](s);
      assert.equal(r.code, 0, `${db}: ${r.err}`);
      assert.equal(Number(r.out.trim().split("\n").at(-1)), committed(dialect[db]), `${db} 마이그레이션 기록 수`);
      // migrate 는 끝난 일회성 서비스다 (종료코드 0)
      const ps = JSON.parse(`[${s.compose("ps", "-a", "--format", "json", "migrate").out.trim().split("\n").join(",")}]`);
      assert.equal(ps[0]?.ExitCode, 0, `${db} migrate 종료코드`);
    } finally {
      s.down();
    }
  }
});

test("TC-S6.T2.g 설치가 끝났는데 OmniRoute 비밀번호가 남아 있으면 경고하고, 파일을 지우면 사라진다", async () => {
  const s = stack();
  const password = s.env.INITIAL_PASSWORD;
  // 관리자 없음 + 변수 있음 → 경고 0줄
  assert.equal(count(s.logs("app"), WARN_PASSWORD), 0);
  await ensureAdmin();
  // 관리자 있음 + 변수 있음 → 다시 시작할 때 경고 정확히 1줄, 값은 찍지 않는다
  assert.equal(s.compose("restart", "app").code, 0);
  assert.equal(s.compose("up", "-d", "--wait", "--no-build", "app").code, 0);
  let logs = s.logs("app");
  assert.equal(count(logs, WARN_PASSWORD), 1, logs.slice(-2000));
  assert.ok(!logs.includes(password), "비밀번호 값이 로그에 있다");
  // .env.setup 을 지우고 app 을 다시 띄우면 변수가 사라지고 경고도 없다
  fs.rmSync(path.join(s.dir, ".env.setup"));
  const up = s.compose("up", "-d", "--wait", "--no-build", "app");
  assert.equal(up.code, 0, up.err);
  const env = s.compose("exec", "-T", "app", "env");
  assert.equal(env.code, 0, env.err);
  assert.equal(env.out.match(/^OMNIROUTE_INITIAL_PASSWORD=/m), null, "컨테이너 환경에 OMNIROUTE_INITIAL_PASSWORD 가 남았다");
  logs = s.logs("app");
  assert.equal(count(logs, WARN_PASSWORD), 0, "변수를 지운 뒤에도 경고가 났다");
});
