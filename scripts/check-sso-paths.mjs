#!/usr/bin/env node
// SSO 플러그인이 들어간 인증 구성이 공개 SSO 관리 경로를 모두 disabledPaths 로 막는지 본다 (TC-S3.T1.d, 계획서 4.3).
//
//   node scripts/check-sso-paths.mjs                                       packages/auth 검사. 위반 0 이어야 통과
//   node scripts/check-sso-paths.mjs --fixture <dir> --expect-fail         <dir> 검사가 실패해야 통과 (음성 대조)
//
// 판정: 대상의 src/index.ts 를 실제로 불러 authOptions(가짜 설정) 결과를 본다 (문자열 검색이 아니다, S3 보안 리뷰 L5).
//   1. plugins 에 id "sso" 가 없으면 통과.
//   2. 있으면 disabledPaths 가 막을 경로 전부를 담아야 한다.
//      막을 경로 = 아래 MUST_DISABLE ∪ 설치된 @better-auth/sso 가 여는 /sso/* 경로 중 PUBLIC_FLOW 가 아닌 것.
//      버전이 올라 관리 경로가 늘면 2번째 집합이 잡는다.
// Node 의 TypeScript 타입 지우기로 .ts 를 바로 불러온다 (Node 24+).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUTH_PKG = path.join(ROOT, "packages/auth");

// @better-auth/sso 1.7.7 dist/index.mjs 의 관리 엔드포인트 (등록·수정·삭제·도메인 검증·조회)
const MUST_DISABLE = [
  "/sso/register",
  "/sso/update-provider",
  "/sso/delete-provider",
  "/sso/request-domain-verification",
  "/sso/verify-domain",
  "/sso/providers",
  "/sso/get-provider",
];
// 로그인 흐름에 필요한 공개 경로. 이것만 열어 둔다.
const PUBLIC_FLOW = new Set([
  "/sign-in/sso",
  "/sso/callback",
  "/sso/callback/:providerId",
  "/sso/saml2/sp/acs/:providerId",
  "/sso/saml2/sp/slo/:providerId",
  "/sso/saml2/sp/metadata",
  "/sso/saml2/logout/:providerId",
]);

function args() {
  const a = process.argv.slice(2);
  const i = a.indexOf("--fixture");
  return { dir: i >= 0 ? path.resolve(ROOT, a[i + 1] ?? "") : AUTH_PKG, expectFail: a.includes("--expect-fail") };
}

// 설치된 @better-auth/sso 가 여는 /sso/* 경로 (packages/auth 의 node_modules 기준)
function installedSsoPaths() {
  try {
    const entry = createRequire(path.join(AUTH_PKG, "package.json")).resolve("@better-auth/sso");
    const src = fs.readFileSync(entry, "utf8");
    return [...new Set([...src.matchAll(/createAuthEndpoint\("([^"]+)"/g)].map((m) => m[1]))];
  } catch {
    return null;
  }
}

// authOptions 에 넘기는 가짜 설정. DB 연결 없이 옵션 객체만 만든다.
const FAKE_CONFIG = {
  database: { db: {}, provider: "sqlite", schema: {} },
  baseURL: "http://localhost:3000",
  secret: "check-sso-paths-check-sso-paths-check",
  mailer: { send: async () => {} },
  clientIp: () => null,
  waitUntil: () => {},
  onMailError: () => {},
};

async function check(dir) {
  const entry = path.join(dir, "src/index.ts");
  if (!fs.existsSync(entry)) return [`${path.relative(ROOT, entry)} 없음`];
  const mod = await import(pathToFileURL(entry).href);
  if (typeof mod.authOptions !== "function") return [`${path.relative(ROOT, entry)} 가 authOptions 를 내보내지 않는다`];
  const options = mod.authOptions(FAKE_CONFIG);
  if (!(options.plugins ?? []).some((p) => p?.id === "sso")) {
    console.log("[sso-paths] sso 플러그인이 없다. 검사할 것 없음");
    return [];
  }
  const problems = [];
  const installed = installedSsoPaths();
  if (!installed) problems.push("@better-auth/sso 소스를 찾지 못해 열리는 경로를 셀 수 없다 (pnpm install 확인)");
  const mustDisable = new Set([...MUST_DISABLE, ...(installed ?? []).filter((p) => p.startsWith("/sso/") && !PUBLIC_FLOW.has(p))]);
  const disabled = new Set(Array.isArray(options.disabledPaths) ? options.disabledPaths : []);
  if (!Array.isArray(options.disabledPaths)) problems.push("SSO 플러그인이 있는데 disabledPaths 가 없다");
  for (const p of mustDisable) if (!disabled.has(p)) problems.push(`disabledPaths 에 ${p} 없음`);
  return problems;
}

const { dir, expectFail } = args();
const problems = await check(dir);
for (const p of problems) console.error(`[sso-paths] ${path.relative(ROOT, dir) || "."}: ${p}`);
if (expectFail) {
  if (problems.length === 0) {
    console.error("[sso-paths] 음성 대조 실패: 막지 않은 픽스처가 통과했다");
    process.exit(1);
  }
  console.log(`[sso-paths] 음성 대조 통과: 위반 ${problems.length}개를 잡았다`);
  process.exit(0);
}
if (problems.length) process.exit(1);
console.log("[sso-paths] 공개 SSO 관리 경로가 모두 disabledPaths 에 있다");
