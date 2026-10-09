// TC-S0.T1.a: 워크스페이스가 패키지 여섯을 모두 인식하는지 검사한다.
import { execFileSync } from "node:child_process";

const EXPECTED = ["server", "web", "db", "auth", "omniroute", "runtime"].map((n) => `@magnetosphere/${n}`);

const out = execFileSync("pnpm", ["-r", "ls", "--depth", "-1", "--json"], { encoding: "utf8" });
const found = new Set(JSON.parse(out).map((p) => p.name));
const missing = EXPECTED.filter((n) => !found.has(n));

if (missing.length > 0) {
  console.error(`워크스페이스에 없는 패키지: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`워크스페이스 패키지 ${EXPECTED.length}개 확인`);
