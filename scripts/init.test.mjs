// 설치 스크립트 TC (실행판 S6.T1). node --test --test-reporter=tap scripts/init.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INIT = path.join(ROOT, "scripts/init.mjs");
const V21 = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/verify/V21.json"), "utf8"));
const SECRET_NAMES = [...V21.answer.secrets.map((s) => s.name), "APP_ENCRYPTION_KEY", "BETTER_AUTH_SECRET", "MYSQL_ROOT_PASSWORD", "MYSQL_PASSWORD", "POSTGRES_PASSWORD"];

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mg-init-"));
const runInit = (dir, ...args) => spawnSync(process.execPath, [INIT, "--dir", dir, ...args], { encoding: "utf8" });

/** KEY=VALUE 줄만 읽는다 (같은 키가 두 번이면 실패) */
function parseEnv(file) {
  const out = new Map();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    assert.ok(!out.has(m[1]), `${m[1]} 이 두 번 나온다`);
    out.set(m[1], m[2]);
  }
  return out;
}

test("TC-S6.T1.a 필수 값이 모두 들어간다", () => {
  const dir = tmp();
  const r = runInit(dir);
  assert.equal(r.status, 0, r.stderr);
  const env = parseEnv(path.join(dir, ".env"));
  for (const s of V21.answer.secrets) assert.ok(env.get(s.name), `V21 ${s.name} 없음`);
  assert.ok(env.get("JWT_SECRET").length >= 32, "JWT_SECRET 32자 이상");
  assert.ok(env.get("API_KEY_SECRET").length >= 16, "API_KEY_SECRET 16자 이상");
  assert.equal(env.get("STORAGE_ENCRYPTION_KEY_VERSION"), "v1");
  assert.equal(env.get("REQUIRE_API_KEY"), "true");
  assert.equal(env.get("PRICING_SYNC_ENABLED"), "true");
  assert.equal(Buffer.from(env.get("APP_ENCRYPTION_KEY"), "base64").length, 32);
  assert.ok(env.get("BETTER_AUTH_SECRET").length >= 32, "BETTER_AUTH_SECRET 32자 이상");
  assert.match(env.get("DATABASE_URL"), /^file:/);
  // 파일은 소유자만 읽는다
  assert.equal(fs.statSync(path.join(dir, ".env")).mode & 0o077, 0);
  // DB 프로필을 고르면 그 DB 주소와 Compose 프로필이 들어간다
  for (const [db, scheme] of [["mysql", "mysql:"], ["postgres", "postgres:"]]) {
    const d = tmp();
    assert.equal(runInit(d, "--db", db).status, 0);
    const e = parseEnv(path.join(d, ".env"));
    assert.equal(e.get("COMPOSE_PROFILES"), db);
    assert.ok(e.get("DATABASE_URL").startsWith(scheme));
    assert.ok(e.get("DATABASE_URL").includes(e.get(db === "mysql" ? "MYSQL_PASSWORD" : "POSTGRES_PASSWORD")));
  }
});

test("TC-S6.T1.a 인자 검사: http 공개 주소 경고, 값 없는 인자는 사용법과 종료코드 2", () => {
  // 루프백이 아닌 http:// 는 만들되 경고한다. https·localhost 는 경고하지 않는다
  const warned = runInit(tmp(), "--url", "http://llm.example.com");
  assert.equal(warned.status, 0);
  assert.match(warned.stderr, /경고: 공개 주소 http:\/\/llm\.example\.com 가 http:\/\//);
  for (const url of ["https://llm.example.com", "http://localhost:8080", "http://127.0.0.1"]) {
    const r = runInit(tmp(), "--url", url);
    assert.equal(r.status, 0, url);
    assert.doesNotMatch(r.stderr, /경고/, url);
  }
  // --dir 뒤에 값이 없으면 스택 트레이스 대신 사용법, 종료코드 2
  for (const args of [["--dir"], ["--dir", "--db", "mysql"], ["--url"]]) {
    const r = spawnSync(process.execPath, [INIT, ...args], { encoding: "utf8", cwd: tmp() });
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /뒤에 값이 없다/);
    assert.match(r.stderr, /사용법: node scripts\/init\.mjs/);
    assert.doesNotMatch(r.stderr, /\n\s+at /, "스택 트레이스");
  }
});

test("TC-S6.T1.b 두 번 생성한 비밀 값이 서로 다르다", () => {
  const [a, b] = [tmp(), tmp()];
  assert.equal(runInit(a).status, 0);
  assert.equal(runInit(b).status, 0);
  const [ea, eb] = [parseEnv(path.join(a, ".env")), parseEnv(path.join(b, ".env"))];
  const values = [];
  for (const name of SECRET_NAMES) {
    assert.ok(ea.get(name) && eb.get(name), `${name} 없음`);
    assert.notEqual(ea.get(name), eb.get(name), `${name} 가 두 설치본에서 같다`);
    values.push(ea.get(name), eb.get(name));
  }
  // 한 설치본 안에서도 비밀 값끼리 겹치지 않는다
  assert.equal(new Set(values).size, values.length);
});

test("TC-S6.T1.c 기존 .env 를 덮지 않는다", () => {
  const dir = tmp();
  assert.equal(runInit(dir).status, 0);
  const hash = (f) => createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex");
  const before = [hash(".env"), hash(".env.setup")];
  const r = runInit(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /덮지 않는다/);
  assert.deepEqual([hash(".env"), hash(".env.setup")], before);
  // .env 만 있어도 거부한다
  const only = tmp();
  fs.writeFileSync(path.join(only, ".env"), "APP_ENCRYPTION_KEY=keep\n");
  assert.equal(runInit(only).status, 1);
  assert.equal(fs.readFileSync(path.join(only, ".env"), "utf8"), "APP_ENCRYPTION_KEY=keep\n");
  assert.equal(fs.existsSync(path.join(only, ".env.setup")), false);
});

test("TC-S6.T1.d OmniRoute 비밀번호는 설치 뒤 지울 파일에만 들어간다", () => {
  const dir = tmp();
  const r = runInit(dir);
  assert.equal(r.status, 0);
  const envText = fs.readFileSync(path.join(dir, ".env"), "utf8");
  const env = parseEnv(path.join(dir, ".env"));
  const setup = parseEnv(path.join(dir, ".env.setup"));
  assert.equal(envText.match(/^OMNIROUTE_INITIAL_PASSWORD=/gm), null, ".env 에 OMNIROUTE_INITIAL_PASSWORD 가 있다");
  assert.equal(fs.readFileSync(path.join(dir, ".env.setup"), "utf8").match(/^OMNIROUTE_INITIAL_PASSWORD=/gm)?.length, 1);
  assert.equal(setup.get("OMNIROUTE_INITIAL_PASSWORD"), env.get("INITIAL_PASSWORD"));
  assert.deepEqual([...setup.keys()], ["OMNIROUTE_INITIAL_PASSWORD"]);
  assert.equal(fs.statSync(path.join(dir, ".env.setup")).mode & 0o077, 0);
  // 설치 뒤 .env.setup 을 지우라는 안내가 init 출력과 운영 문서에 있다
  assert.match(r.stdout, /rm \.env\.setup/);
  const readme = fs.readFileSync(path.join(ROOT, "deploy/README.md"), "utf8");
  assert.match(readme, /rm \.env\.setup/);
  assert.match(readme, /\.env\.setup[^\n]*지우/);
});
