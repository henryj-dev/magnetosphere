#!/usr/bin/env node
// 재현 빨강 확인 (2단계 실행판 0절 「재현 빨강」, K0.T14).
//
//   node scripts/check-red.mjs --check <검사 ID> --since seal:<단계>|<ref> [--root <dir>]
//
// 행동을 바꾸는 작업은 재현 테스트만 넣은 커밋(꼬리줄 `Red: <TC ID>`)을 고침보다 먼저 둔다. 이 스크립트는
//   1. 지금 설정(gates/gates.config.mjs)에서 검사를 찾아 그 명령과 desc 의 첫 TC ID 를 읽는다
//   2. <since>..HEAD 에서 꼬리줄 `Red: <그 TC>` 를 가진 커밋을 찾는다 (없으면 실패)
//   3. 그 커밋마다 작업 트리를 따로 꺼내(git worktree add --detach, 잠금 파일이 있으면 pnpm install --frozen-lockfile --prefer-offline)
//      같은 명령을 돌린다. 실패(빨강)해야 통과다. test 검사는 expectPassed 를 못 채운 것도 빨강으로 본다.
// 판정(명령 실행·통과 수 세기)은 gate.mjs 의 것을 그대로 쓴다.
//
// 환경변수 CHECK_RED_CACHE_DIR 가 있으면 작업 트리를 <그 폴더>/<커밋 SHA> 에 두고 다음 실행(다른 검사 ID 의 프로세스)이 다시 쓴다.
// CI 단계 잡은 같은 Red 커밋을 여러 검사가 공유해 설치가 겹치기 때문이다. 다시 쓸 때는 이 저장소의 작업 트리이고 HEAD 가 그 SHA 인지
// 확인한 뒤 git reset --hard 와 git clean -ffdx(node_modules 만 남김)로 앞 시험의 잔재를 지우고 명령을 돈다.
// 설치 표식 node_modules/.check-red-installed 의 내용(pnpm-lock.yaml 의 sha256)이 맞으면 설치를 건너뛴다. 표식이 node_modules 안이라
// node_modules 가 지워지면 표식도 사라져 다시 설치한다. 확인이나 정리가 실패하면 그 폴더를 지우고 새로 꺼낸다.
// 결과는 다시 쓰지 않는다 (명령은 매번 돈다, R3). 캐시 폴더의 작업 트리는 지우지 않는다 (잡이 끝나면 러너와 함께 사라진다).
// 환경변수가 없으면 커밋마다 임시 폴더에 꺼내 돌고 지운다.
//
// 종료코드: 0 모든 Red 커밋에서 빨강 · 1 Red 커밋 없음, Red 커밋에서 초록, 설치 실패 · 2 인자·설정 오류

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { passedCount, run } from "./gate.mjs";

function fail(message, code = 1) {
  console.error(`check-red: ${message}`);
  process.exit(code);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) fail(`--${name} 에 값이 필요하다`, 2);
  return v;
}

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) fail(`git ${args.join(" ")} 실패: ${(r.stderr ?? "").trim()}`, 2);
  return r.stdout.trim();
}

const checkId = arg("check");
const since = arg("since");
if (!checkId || !since) fail("사용법: check-red.mjs --check <검사 ID> --since seal:<단계>|<ref> [--root <dir>]", 2);
const root = path.resolve(arg("root") ?? git(process.cwd(), ["rev-parse", "--show-toplevel"]));

// 1. 검사와 TC
const { GATES } = await import(pathToFileURL(path.join(root, "gates/gates.config.mjs")).href);
const check = Object.values(GATES).flatMap((p) => p.checks ?? []).find((c) => c.id === checkId);
if (!check) fail(`설정에 검사 ${checkId} 가 없다`, 2);
if (!["test", "cmd"].includes(check.how)) fail(`${checkId}: how "${check.how}" 는 명령이 없어 재현 빨강을 볼 수 없다 (test·cmd 만)`, 2);
const tc = /TC-[A-Z][0-9]+\.T[0-9]+\.[a-z]/.exec(check.desc ?? "")?.[0];
if (!tc) fail(`${checkId}: desc 에 TC ID 가 없다 (${JSON.stringify(check.desc)})`, 2);

// 2. 기준과 Red 커밋
let base = since;
const sealRef = /^seal:(.+)$/.exec(since);
if (sealRef) {
  const file = path.join(root, "gates/seals", `${sealRef[1]}.json`);
  if (!fs.existsSync(file)) fail(`${sealRef[1]} 봉인 파일이 없다 (${file})`, 2);
  base = JSON.parse(fs.readFileSync(file, "utf8")).head;
  if (typeof base !== "string" || !/^[0-9a-f]{40}$/.test(base)) fail(`${sealRef[1]} 봉인 head 가 커밋 SHA 가 아니다`, 2);
}
git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
const log = git(root, ["log", "--format=%H%x00%B%x1e", `${base}..HEAD`]);
const reds = log
  .split("\x1e")
  .map((rec) => rec.trim())
  .filter(Boolean)
  .map((rec) => {
    const [sha, body] = rec.split("\x00");
    const tcs = [...(body ?? "").matchAll(/^Red:\s*(.+)$/gm)].flatMap((m) => m[1].split(/[\s,]+/).filter(Boolean));
    return { sha, tcs };
  })
  .filter((c) => c.tcs.includes(tc));
if (!reds.length) fail(`${checkId}: ${since}..HEAD 에 "Red: ${tc}" 커밋 없음`);

// 3. Red 커밋마다 빨강인지
const INSTALL = "pnpm install --frozen-lockfile --prefer-offline";
// 표식은 node_modules 안에 둔다. 앞 검사가 node_modules 를 지우면 표식도 함께 사라져 다시 설치한다 (표식만 남아 설치를 건너뛰지 않게)
const MARK = path.join("node_modules", ".check-red-installed");
const cacheRoot = process.env.CHECK_RED_CACHE_DIR ? path.resolve(process.env.CHECK_RED_CACHE_DIR) : null;

function tryGit(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function lockHash(dir) {
  const file = path.join(dir, "pnpm-lock.yaml");
  return fs.existsSync(file) ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null;
}

// 캐시를 쓸 때만 본다 (--path-format 은 git 2.31 이상)
const commonDir = cacheRoot ? real(git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) : null;

// 캐시 폴더를 그대로 쓸 수 있으면 잔재를 지우고 true. 이 저장소의 작업 트리가 아니거나(최상위가 그 폴더 자신이어야 한다),
// HEAD 가 sha 가 아니거나, 정리가 실패하면 false
function reuse(dir, sha) {
  if (!fs.existsSync(dir)) return false;
  if (real(tryGit(dir, ["rev-parse", "--show-toplevel"]) ?? "") !== real(dir)) return false;
  if (real(tryGit(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) ?? "") !== commonDir) return false;
  if (tryGit(dir, ["rev-parse", "HEAD"]) !== sha) return false;
  if (tryGit(dir, ["reset", "--hard", "--quiet", "HEAD"]) === null) return false;
  return tryGit(dir, ["clean", "-ffdxq", "-e", "node_modules"]) !== null;
}

const problems = [];
for (const { sha } of reds) {
  const short = sha.slice(0, 7);
  let dir;
  let reused = false;
  if (cacheRoot) {
    dir = path.join(cacheRoot, sha);
    reused = reuse(dir, sha);
    if (!reused) {
      spawnSync("git", ["worktree", "remove", "--force", dir], { cwd: root });
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(cacheRoot, { recursive: true });
      // 저장소 전체 prune 대신 -f 로 이 경로의 낡은 등록만 덮어쓴다 (다른 작업 트리 정보를 건드리지 않는다)
      git(root, ["worktree", "add", "-f", "--detach", "--quiet", dir, sha]);
    }
  } else {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-red-"));
    git(root, ["worktree", "add", "--detach", "--quiet", dir, sha]);
  }
  try {
    const lock = lockHash(dir);
    const markFile = path.join(dir, MARK);
    if (lock && reused && fs.existsSync(markFile) && fs.readFileSync(markFile, "utf8") === lock) {
      console.log(`설치 생략  ${short} (같은 잠금 파일로 설치한 작업 트리 재사용, ${dir})`);
    } else if (lock) {
      if (cacheRoot) fs.rmSync(markFile, { force: true });
      const inst = run(dir, INSTALL);
      if (inst.code !== 0) {
        problems.push(`${short}: 설치 실패 (${INSTALL} 종료코드 ${inst.code}) — 빨강을 확인하지 못했다\n${inst.output.split("\n").slice(-20).join("\n")}`);
        continue;
      }
      if (cacheRoot) fs.writeFileSync(markFile, lock);
    }
    const { code, output } = run(dir, check.cmd);
    let green = code === (check.expectExit ?? 0);
    let measured = `종료코드 ${code}`;
    if (green && check.how === "test") {
      const passed = passedCount(output);
      green = passed !== null && (Number.isInteger(check.expectPassed) ? passed === check.expectPassed : passed >= 1);
      measured += `, 통과 ${passed ?? "?"}${Number.isInteger(check.expectPassed) ? ` / 기대 ${check.expectPassed}` : ""}`;
    }
    if (green) problems.push(`${short}: Red 커밋에서 통과 (${measured}) — 재현 테스트가 고치기 전에도 초록이다`);
    else console.log(`빨강  ${short} ${tc} (${measured})`);
  } finally {
    if (!cacheRoot) spawnSync("git", ["worktree", "remove", "--force", dir], { cwd: root });
  }
}

if (problems.length) {
  for (const p of problems) console.error(`check-red: ${checkId} ${p}`);
  process.exit(1);
}
console.log(`check-red: ${checkId} (${tc}) Red 커밋 ${reds.length}개 모두 빨강`);
