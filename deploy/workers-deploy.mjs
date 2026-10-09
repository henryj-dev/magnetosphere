#!/usr/bin/env node
// Workers 배포 (실행판 S6.T3 4번). 마이그레이션을 먼저 적용하고 그다음 배포한다. 새 코드만 올라가고 스키마가 그대로면 첫 요청이 500 이다.
//
//   node deploy/workers-deploy.mjs --env d1|mysql|pg [--dry-run] [--local --persist-to <폴더>]
//
//   d1     : wrangler d1 migrations apply DB --remote --env d1  →  wrangler deploy --env d1
//   mysql·pg: MIGRATE_DATABASE_URL(Hyperdrive 가 가리키는 DB 의 직접 주소)로 apps/server/src/migrate.ts  →  wrangler deploy --env <환경>
//   --dry-run : 실행하지 않고 단계를 순서대로 출력한다 (한 줄에 하나, "[step] " 로 시작)
//   --local   : 로컬 개발 상태(wrangler dev 의 --persist-to)에 마이그레이션만 적용하고 배포는 하지 않는다 (D1 은 --local, 나머지는 MIGRATE_DATABASE_URL)
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "apps/server");
const ENVS = ["d1", "mysql", "pg"];

export function plan({ env, local = false, persistTo = null }) {
  if (!ENVS.includes(env)) throw new Error(`--env 는 ${ENVS.join("|")} 중 하나다 (받은 값: ${env ?? "없음"})`);
  const steps = [];
  if (env === "d1") {
    const where = local ? ["--local", ...(persistTo ? ["--persist-to", persistTo] : [])] : ["--remote"];
    steps.push({ kind: "migrate", cmd: "pnpm", args: ["exec", "wrangler", "d1", "migrations", "apply", "DB", ...where, "--env", "d1"], cwd: SERVER });
  } else {
    steps.push({ kind: "migrate", cmd: process.execPath, args: [path.join(SERVER, "src/migrate.ts")], cwd: ROOT, needs: "MIGRATE_DATABASE_URL" });
  }
  if (!local) steps.push({ kind: "deploy", cmd: "pnpm", args: ["exec", "wrangler", "deploy", "--env", env], cwd: SERVER });
  return steps;
}

const show = (s) => `[step] ${s.kind}: ${s.needs ? `DATABASE_URL=$${s.needs} ` : ""}${s.cmd === process.execPath ? "node" : s.cmd} ${s.args.map((a) => path.isAbsolute(a) ? path.relative(ROOT, a) || "." : a).join(" ")}`;

function main(argv) {
  const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
  let steps;
  try {
    steps = plan({ env: opt("--env"), local: argv.includes("--local"), persistTo: opt("--persist-to") ?? null });
  } catch (e) {
    console.error(`workers-deploy: ${e.message}`);
    return 2;
  }
  for (const s of steps) {
    console.log(show(s));
    if (argv.includes("--dry-run")) continue;
    const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" };
    if (s.needs) {
      if (!process.env[s.needs]) {
        console.error(`workers-deploy: ${s.needs} 가 없다 (Hyperdrive 가 가리키는 DB 의 직접 주소)`);
        return 2;
      }
      env.DATABASE_URL = process.env[s.needs];
    }
    const r = spawnSync(s.cmd, s.args, { cwd: s.cwd, stdio: "inherit", env });
    if (r.status !== 0) {
      console.error(`workers-deploy: ${s.kind} 단계 실패 (종료코드 ${r.status}). 뒤 단계는 하지 않는다.`);
      return r.status ?? 1;
    }
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
