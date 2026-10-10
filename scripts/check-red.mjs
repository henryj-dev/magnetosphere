#!/usr/bin/env node
// 재현 빨강 확인 (2단계 실행판 0절 「재현 빨강」, K0.T14).
//
//   node scripts/check-red.mjs --check <검사 ID> --since seal:<단계>|<ref> [--root <dir>]
//
// 행동을 바꾸는 작업은 재현 테스트만 넣은 커밋(꼬리줄 `Red: <TC ID>`)을 고침보다 먼저 둔다. 이 스크립트는
//   1. 지금 설정(gates/gates.config.mjs)에서 검사를 찾아 그 명령과 desc 의 첫 TC ID 를 읽는다
//   2. <since>..HEAD 에서 꼬리줄 `Red: <그 TC>` 를 가진 커밋을 찾는다 (없으면 실패)
//   3. 그 커밋마다 작업 트리를 따로 꺼내(git worktree add --detach, 잠금 파일이 있으면 pnpm install --frozen-lockfile)
//      같은 명령을 돌린다. 실패(빨강)해야 통과다. test 검사는 expectPassed 를 못 채운 것도 빨강으로 본다.
// 판정(명령 실행·통과 수 세기)은 gate.mjs 의 것을 그대로 쓴다.
//
// 종료코드: 0 모든 Red 커밋에서 빨강 · 1 Red 커밋 없음, Red 커밋에서 초록, 설치 실패 · 2 인자·설정 오류

import { spawnSync } from "node:child_process";
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
const problems = [];
for (const { sha } of reds) {
  const short = sha.slice(0, 7);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-red-"));
  git(root, ["worktree", "add", "--detach", "--quiet", dir, sha]);
  try {
    if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) {
      const inst = run(dir, "pnpm install --frozen-lockfile");
      if (inst.code !== 0) {
        problems.push(`${short}: 설치 실패 (pnpm install --frozen-lockfile 종료코드 ${inst.code}) — 빨강을 확인하지 못했다\n${inst.output.split("\n").slice(-20).join("\n")}`);
        continue;
      }
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
    spawnSync("git", ["worktree", "remove", "--force", dir], { cwd: root });
  }
}

if (problems.length) {
  for (const p of problems) console.error(`check-red: ${checkId} ${p}`);
  process.exit(1);
}
console.log(`check-red: ${checkId} (${tc}) Red 커밋 ${reds.length}개 모두 빨강`);
