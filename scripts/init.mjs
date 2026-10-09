#!/usr/bin/env node
// 설치 스크립트 (실행판 S6.T1, 계획서 4.7). Compose 설치에 쓸 .env 와 .env.setup 을 만든다.
//
//   node scripts/init.mjs [--dir <폴더>] [--db sqlite|mysql|postgres] [--url <공개 주소>]
//
// - .env: OmniRoute 운영 비밀 값 전부(V21)와 회원 앱 비밀 값을 무작위로 만들어 고정한다. 자동 생성에 맡기면 볼륨을 잃거나
//   다른 STORAGE_ENCRYPTION_KEY 를 넣었을 때 OmniRoute 가 시작을 거부한다 (V21). REQUIRE_API_KEY=true 를 명시한다
//   (OmniRoute .env.example 은 false 다).
// - .env.setup: 회원 앱이 OmniRoute 부트스트랩에 쓰는 OMNIROUTE_INITIAL_PASSWORD 만 담는다 (S5 보안 리뷰 M2).
//   이 비밀번호로는 admin 접근 토큰도 만들 수 있다. 최초 설치가 끝나면 지우고 app 을 다시 띄운다.
// - 이미 .env(또는 .env.setup)가 있으면 아무것도 쓰지 않고 종료코드 1. 다시 만들면 APP_ENCRYPTION_KEY 가 바뀌어
//   DB 에 암호화해 둔 값을 영영 못 읽는다.
// 값 목록과 뜻은 저장소 최상위 .env.example 에 있다.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DBS = {
  sqlite: { profile: "", url: () => "file:/data/magnetosphere.sqlite" },
  mysql: { profile: "mysql", url: (s) => `mysql://magnetosphere:${s.MYSQL_PASSWORD}@mysql:3306/magnetosphere` },
  postgres: { profile: "postgres", url: (s) => `postgres://magnetosphere:${s.POSTGRES_PASSWORD}@postgres:5432/magnetosphere` },
};

const hex = (n) => randomBytes(n).toString("hex");
const b64 = (n) => randomBytes(n).toString("base64");
const b64url = (n) => randomBytes(n).toString("base64url");

/** .env 와 .env.setup 의 내용을 만든다. 비밀 값은 부를 때마다 새로 뽑는다 */
export function render({ db = "sqlite", url = "http://localhost" } = {}) {
  const d = DBS[db];
  if (!d) throw new Error(`--db 는 ${Object.keys(DBS).join("|")} 중 하나다 (받은 값: ${db})`);
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`--url 은 http(s) 주소다 (받은 값: ${url})`);
  // URL 에 넣는 비밀번호는 base64url·hex 만 써서 따로 이스케이프하지 않는다
  const s = {
    // OmniRoute (V21). 길이 규칙: JWT_SECRET 32자 이상, API_KEY_SECRET 16자 이상
    INITIAL_PASSWORD: hex(24),
    JWT_SECRET: b64(48),
    API_KEY_SECRET: hex(32),
    STORAGE_ENCRYPTION_KEY: hex(32),
    OMNIROUTE_WS_BRIDGE_SECRET: b64(32),
    // 회원 앱
    APP_ENCRYPTION_KEY: b64(32),
    BETTER_AUTH_SECRET: b64url(48),
    MYSQL_ROOT_PASSWORD: b64url(24),
    MYSQL_PASSWORD: b64url(24),
    POSTGRES_PASSWORD: b64url(24),
  };
  const env = [
    "# node scripts/init.mjs 가 만든 파일이다. 저장소에 올리지 않는다. 뜻은 .env.example 에 있다.",
    "# 다시 만들지 않는다: APP_ENCRYPTION_KEY·STORAGE_ENCRYPTION_KEY 가 바뀌면 저장된 비밀 값을 못 읽는다.",
    "",
    "# Compose",
    `COMPOSE_PROFILES=${d.profile}`,
    `SITE_ADDRESS=${parsed.protocol === "https:" ? parsed.host : ":80"}`,
    "",
    "# OmniRoute (V21)",
    `INITIAL_PASSWORD=${s.INITIAL_PASSWORD}`,
    `JWT_SECRET=${s.JWT_SECRET}`,
    `API_KEY_SECRET=${s.API_KEY_SECRET}`,
    `STORAGE_ENCRYPTION_KEY=${s.STORAGE_ENCRYPTION_KEY}`,
    "STORAGE_ENCRYPTION_KEY_VERSION=v1",
    `OMNIROUTE_WS_BRIDGE_SECRET=${s.OMNIROUTE_WS_BRIDGE_SECRET}`,
    "REQUIRE_API_KEY=true",
    "PRICING_SYNC_ENABLED=true",
    "",
    "# 회원 앱",
    `BETTER_AUTH_URL=${parsed.origin}`,
    `BETTER_AUTH_SECRET=${s.BETTER_AUTH_SECRET}`,
    `APP_ENCRYPTION_KEY=${s.APP_ENCRYPTION_KEY}`,
    `DATABASE_URL=${d.url(s)}`,
    "",
    "# DB 프로필 (mysql·postgres 를 쓸 때만 읽는다)",
    `MYSQL_ROOT_PASSWORD=${s.MYSQL_ROOT_PASSWORD}`,
    `MYSQL_PASSWORD=${s.MYSQL_PASSWORD}`,
    `POSTGRES_PASSWORD=${s.POSTGRES_PASSWORD}`,
    "",
  ].join("\n");
  const setup = [
    "# 최초 설치(관리자 생성·OmniRoute 연결) 때만 회원 앱에 넘기는 값이다 (docker-compose.yml 의 env_file, required: false).",
    "# 설치가 끝나면 이 파일을 지우고 docker compose up -d app 으로 app 을 다시 띄운다.",
    `OMNIROUTE_INITIAL_PASSWORD=${s.INITIAL_PASSWORD}`,
    "",
  ].join("\n");
  return { env, setup };
}

export const NEXT_STEPS = [
  "[init] .env 와 .env.setup 을 만들었다.",
  "[init] 1. docker compose up -d --wait",
  "[init] 2. docker compose logs app 에서 최초 설치 토큰을 찾아 /setup 에서 첫 관리자를 만든다 (OmniRoute 는 자동 연결된다).",
  "[init] 3. 최초 설치가 끝나면 .env.setup 을 지우고 app 을 다시 띄운다: rm .env.setup && docker compose up -d app",
  "[init]    .env.setup 의 OmniRoute 비밀번호로는 관리 토큰도 만들 수 있어 회원 앱 환경에 남겨 두지 않는다.",
].join("\n");

export const USAGE = "사용법: node scripts/init.mjs [--dir <폴더>] [--db sqlite|mysql|postgres] [--url <공개 주소>]";

/** 루프백이 아닌 http:// 공개 주소. 세션 쿠키·비밀번호가 평문으로 오간다 */
export function insecureUrl(url) {
  const u = new URL(url);
  return u.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

function parseArgs(argv) {
  const out = { dir: process.cwd(), db: "sqlite", url: "http://localhost" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (["--dir", "--db", "--url"].includes(k) && (v === undefined || v.startsWith("--"))) throw new Error(`${k} 뒤에 값이 없다`);
    if (k === "--dir") out.dir = v;
    else if (k === "--db") out.db = v;
    else if (k === "--url") out.url = v;
    else throw new Error(`모르는 인자: ${k}`);
    i++;
  }
  return out;
}

export function main(argv) {
  let args;
  let files;
  try {
    args = parseArgs(argv);
    files = render(args);
  } catch (e) {
    console.error(`init: ${e.message}\n${USAGE}`);
    return 2;
  }
  const envPath = path.join(args.dir, ".env");
  const setupPath = path.join(args.dir, ".env.setup");
  const existing = [envPath, setupPath].filter((p) => fs.existsSync(p));
  if (existing.length) {
    console.error(`init: ${existing.join(", ")} 이 이미 있다. 덮지 않는다 (APP_ENCRYPTION_KEY 가 바뀌면 저장된 비밀 값을 못 읽는다).`);
    return 1;
  }
  // 두 파일 모두 소유자만 읽는다. wx: 그사이 생긴 파일도 덮지 않는다
  fs.writeFileSync(envPath, files.env, { mode: 0o600, flag: "wx" });
  fs.writeFileSync(setupPath, files.setup, { mode: 0o600, flag: "wx" });
  console.log(NEXT_STEPS);
  if (insecureUrl(args.url)) {
    console.error(`[init] 경고: 공개 주소 ${new URL(args.url).origin} 가 http:// 다. 세션 쿠키·비밀번호가 평문으로 오간다. 도메인을 정해 https:// 로 쓴다 (--url https://<도메인>).`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
