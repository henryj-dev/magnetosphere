// p3-m3 의 추가 단계 전용. TC-M3.T1.j·k 는 기존 M3 선택자(TC-M3.T1.[ghi])에 없다.
// MySQL·MariaDB 각 2개, 합계 4개 통과와 실행기 종료코드 0 을 함께 요구한다.
import { passedCount, run } from "./gate.mjs";

const r = run(".", 'pnpm -C apps/server test:db -t "TC-M3.T1.[jk]" --db mysql,mariadb');
process.stdout.write(r.output);
const n = passedCount(r.output);
if (r.code !== 0 || n !== 4) {
  console.error(`재초대 이메일 정확 비교 종료코드 ${r.code}, 통과 ${n ?? "읽지 못함"} / 기대 4`);
  process.exit(1);
}
