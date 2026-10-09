// V16 허용 목록 검사. 의존성 없음.
//   node spikes/v16/check.mjs covers [--log <file>] [--allow-extra <pattern>]...
//     수집 로그의 /v1 경로가 모두 answer.allow 패턴 중 하나에 맞으면 종료코드 0.
//     /v1 밖 경로(예: Claude Code 의 HEAD /api/hello 예열)는 Caddy 가 회원 앱으로 보내므로
//     허용 목록 대상이 아니다. 목록에 찍어만 두고 판정에서 뺀다.
//   node spikes/v16/check.mjs deny [--allow-extra <pattern>]...
//     answer.deny 의 경로가 answer.allow 어느 패턴에도 맞지 않으면 종료코드 0.
// 글롭 규칙은 scripts/gate.mjs 의 globToRegExp 와 같다 (`*` 한 구간, `**` 여러 구간).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") {
      re += "[^/]*";
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

const [cmd, ...rest] = process.argv.slice(2);
let logFile = path.join(here, "paths.log");
const extra = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--log") logFile = path.resolve(rest[++i]);
  else if (rest[i] === "--allow-extra") extra.push(rest[++i]);
  else { console.error(`알 수 없는 옵션: ${rest[i]}`); process.exit(2); }
}

const verify = JSON.parse(fs.readFileSync(path.join(root, "docs/verify/V16.json"), "utf8"));
const allow = [...verify.answer.allow, ...extra];
const allowRe = allow.map((g) => ({ g, re: globToRegExp(g) }));
const matchOf = (p) => allowRe.find(({ re }) => re.test(p))?.g;

if (cmd === "covers") {
  if (!fs.existsSync(logFile)) { console.error(`로그 없음: ${logFile}`); process.exit(2); }
  const lines = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (lines.length === 0) { console.error("로그가 비어 있음"); process.exit(1); }
  const paths = [...new Set(lines.map((l) => l.path))].sort();
  const inScope = paths.filter((p) => p === "/v1" || p.startsWith("/v1/"));
  const outScope = paths.filter((p) => !inScope.includes(p));
  if (inScope.length === 0) { console.error("/v1 경로가 하나도 없음"); process.exit(1); }
  let bad = 0;
  for (const p of inScope) {
    const m = matchOf(p);
    console.log(`${m ? "ok  " : "MISS"} ${p}${m ? `  ← ${m}` : ""}`);
    if (!m) bad++;
  }
  for (const p of outScope) console.log(`skip ${p}  (/v1 밖 → 회원 앱)`);
  console.log(bad ? `실패: 허용 목록이 덮지 못한 경로 ${bad}개` : `통과: /v1 경로 ${inScope.length}개 모두 허용 목록에 있음`);
  process.exit(bad ? 1 : 0);
} else if (cmd === "deny") {
  let bad = 0;
  for (const p of verify.answer.deny) {
    const m = matchOf(p);
    if (m) { console.log(`LEAK ${p}  ← ${m}`); bad++; }
  }
  console.log(bad ? `실패: 허용 목록에 걸린 관리 경로 ${bad}개` : `통과: 관리 경로 ${verify.answer.deny.length}개 모두 막힘`);
  process.exit(bad ? 1 : 0);
} else {
  console.error("사용법: check.mjs covers|deny [--log <file>] [--allow-extra <pattern>]");
  process.exit(2);
}
