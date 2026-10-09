# Magnetosphere 1단계 "뼈대" — 실행 목록

계획은 [`../design/omniroute-member-layer.md`](../design/omniroute-member-layer.md) (v5.1) 다. 이 문서는 그 9장 1단계의 순서 · 통과 조건 · 잠금만 적는다. 논거는 계획서 절 번호로 가리킨다.

## 0. 체계

이 절의 정의가 이 문서의 유일한 규칙이다. 여기 없는 표기는 본문에 쓰지 않는다.

**단계와 ID**
- 단계는 `S0`~`S7`. 계획서 9장 "1단계" 하나를 이 문서 안에서 여덟으로 나눈 것이다. 계획서의 단계 번호(0~8)와 섞지 않는다.
- 작업 ID는 `S<n>.T<m>`. 문서가 바뀌어도 같은 작업을 가리킨다. 번호는 재사용하지 않고, 지운 작업은 `(폐기)`로 남긴다.
- 검사 ID는 `G-S<n>.<k>`, 테스트케이스 ID는 `TC-S<n>.T<m>.<소문자>`.
- 계획서 8장 확인 항목은 `V<번호>`로 부른다 (예: `V10`).

**상태 표기**
- 작업: ☐ 미착수 · ◐ 진행 · ☑ 완료
- 단계: 🔒 잠김 · 🔓 열림 · ✅ 봉인 · ⚠ 무효 · ➖ 면제 봉인
- 🔒 단계의 작업은 시작하지 않는다. 🔓은 선행 단계가 모두 ✅(또는 ➖)일 때만 된다. 판정은 `node scripts/gate.mjs --status`가 한다.

**작업 하나의 모양**
- 머리: `선행` (작업 ID) · `산출` (경로) · `되돌리기` (커밋 단위)
- 본문: 【작업】 번호마다 커밋 하나 · 【테스트】 TC 목록 · 【통과】 기계 판정 체크박스

**테스트케이스 규칙**
- 세 줄: 이름 · `단언:` (입력 → 기계로 확인하는 결과) · `검출:` (이 TC가 없으면 놓치는 구체적 결함과 그 결과)
- 검출줄을 못 쓰면 TC를 쓰지 않는다.
- 근거 표시: 저장소에 코드가 아직 없어서, 단언의 숫자·코드는 0단계 실측(`../research/`)에서 가져온다. 실측하지 않은 동작에 기댄 TC는 문서 끝 「실측하지 않은 동작에 기댄 TC 목록」에 올린다.

**GATE와 봉인**
- 장치: `node scripts/gate.mjs`. 검사 정의는 `gates/gates.config.mjs`의 데이터다. 봉인 파일은 `gates/seals/S<n>.json`이고 커밋한다.
- `test` 검사는 종료코드 0이면서 통과한 테스트가 1개 이상이어야 통과다. 이름 패턴이 아무 테스트에도 안 걸리면 실패한다. `node --test`는 `--test-reporter=tap`으로 돌린다 (요약의 pass 수는 파일 단위 항목까지 세서 믿지 않는다).
- 검사가 하나도 정의되지 않은 단계는 실행·봉인을 거부한다.
- 규칙 R1 순서: 선행 봉인이 없으면 그 단계 검사 실행을 거부한다. R2 최신성: 봉인의 `head`가 기준 브랜치(`origin/main`, 없으면 `main`)의 조상이 아니면 그 봉인은 ⚠ 무효다. 기준 브랜치가 없으면 판정을 거부한다. R3 재검: `--seal`은 이전 결과를 읽지 않고 검사를 다시 돌린다.
- 봉인이 유효하려면 모양도 맞아야 한다: `phase`가 그 단계, `head`가 저장소에 있는 40자리 SHA, `checks`의 id 목록이 설정과 같고 모두 `ok`, 면제 봉인은 `waivable` 단계에 사유가 있을 때만. 선행 봉인이 무효면 뒤 봉인도 무효다.
- 손으로 만든 봉인은 모양만으로 다 못 잡는다. `gate --verify-seals --rerun`이 봉인 커밋을 따로 꺼내 검사를 다시 돌린다. CI는 바뀐 봉인마다 이것을 돈다.
- `--assert-order`는 비교 기준 시점에 잠겨 있던 단계의 `needs`·`outputs`·`waivable` 변경과 단계 삭제도 위반으로 본다. 같은 변경 안에서 설정을 고쳐 잠금을 푸는 것을 막는다.
- pre-push 훅은 실제로 보내는 ref마다 검사한다 (`--head <sha>`).
- 기존 장치 없음 (빈 저장소). `S0`이 장치, git 훅, 첫 CI를 만든다. pre-push 훅과 CI가 `--assert-order`를 실행해 잠긴 단계의 산출 경로 변경을 실제로 거부한다.

**확인 결과 파일 (`S1` 전용)**
- `docs/verify/V<번호>.json`: `{ "item", "answer", "evidence", "blocking", "resolved_in" }`
- `blocking: true`면 설계를 고쳐야 한다는 뜻이다. 계획서를 개정하고 `resolved_in`에 개정 버전을 적은 뒤 `blocking: false`로 바꾼다. `G-S1` 검사가 `blocking == false`를 요구하므로, 설계를 막는 결과가 남아 있으면 `S2` 이후가 열리지 않는다.

## 진행 현황

| 단계 | 제목 | 상태 | 게이트 명령 | 봉인 |
|---|---|---|---|---|
| S0 | 저장소와 게이트 장치 | 🔓 | `node scripts/gate.mjs S0` | — |
| S1 | 확인 항목 7개 | 🔒 | `node scripts/gate.mjs S1` | — |
| S2 | DB 계층 (네 DB) | 🔒 | `node scripts/gate.mjs S2` | — |
| S3 | 인증 코어와 메일 | 🔒 | `node scripts/gate.mjs S3` | — |
| S4 | 서버·런타임·화면·최초 설치 | 🔒 | `node scripts/gate.mjs S4` | — |
| S5 | OmniRoute 어댑터·부트스트랩·계약 테스트 | 🔒 | `node scripts/gate.mjs S5` | — |
| S6 | 배포 묶음과 여섯 조합 E2E | 🔒 | `node scripts/gate.mjs S6` | — |
| S7 | 재발 방지와 잔재 회수 | 🔒 | `node scripts/gate.mjs S7` | — |

## 선행 관계

```
S0 ─▶ S1 ─▶ S2 ─▶ S3 ─▶ S4 ─▶ S5 ─▶ S6 ─▶ S7
```
- 전부 직렬이다. 동시 진행 상한 1.
- S4는 S3이 필요하다. 최초 설치(S4.T4)가 S3의 인증 구성 위에서 관리자를 만들기 때문이다. 장치는 단계 단위로만 잠그므로, 작업 하나의 의존 때문에 단계 전체를 직렬로 둔다.
- S5는 S4가 필요하다 (부트스트랩이 최초 설치 흐름과 암호화 유틸 위에서 돈다).

---

# S0 — 저장소와 게이트 장치 🔓 (선행 없음)

**브랜치** `main`에서 시작한다 (초기 저장소). 이후 단계는 `s<n>/<짧은 이름>` 브랜치에서 작업하고 `main`에 합친다.

### ☐ S0.T1 — 저장소 초기화와 모노레포 뼈대
선행 없음 · 산출 `package.json`, `pnpm-workspace.yaml`, `apps/server/`, `apps/web/`, `packages/db/`, `packages/auth/`, `packages/omniroute/`, `packages/runtime/`, `.gitignore`, `.nvmrc`, `LICENSE`, `scripts/check-workspace.mjs` · 되돌리기 커밋 1개

【작업】
1. git 저장소는 문서 커밋으로 이미 만들어져 있다 (`main`). pnpm 워크스페이스, 빈 패키지 여섯 개(`package.json`만), MIT `LICENSE`, Node 버전 고정(`.nvmrc`), `docs/` 그대로 포함. 커밋.

【테스트】
```
TC-S0.T1.a  워크스페이스가 패키지 여섯을 인식한다
  단언:  pnpm -r ls --depth -1 --json → 이름 목록에 server·web·db·auth·omniroute·runtime 여섯이 모두 있다
  검출:  pnpm-workspace.yaml 글롭 누락으로 패키지가 빠져, 이후 단계의 테스트가 그 패키지를 조용히 건너뛰는 것
```

【통과】
- [ ] G-S0.1 통과

### ☐ S0.T2 — 게이트 장치
선행 S0.T1 · 산출 `scripts/gate.mjs`, `gates/gates.config.mjs`, `gates/seals/.gitkeep`, `scripts/gate.test.mjs` · 되돌리기 커밋 1개

【작업】
1. `scripts/gate.mjs`를 의존성 없는 Node 스크립트로 만든다. 계약:
   - `gate <단계>` 검사를 모두 돌려 표로 출력, 하나라도 실패하면 종료코드 1
   - `gate <단계> --seal` 검사를 다시 돌려 모두 통과하면 `gates/seals/<단계>.json` 작성
   - `gate <단계> --explain` 실패한 검사의 측정값과 기준
   - `gate <단계> --seal --waived "<사유>"` 면제 봉인. 사유 없으면 거부. 이 문서에는 면제 가능한 단계가 없으므로 `waivable: false`인 단계는 거부
   - `gate --status` 단계별 🔒/🔓/✅/⚠/➖ 표 (진행 현황 표와 같은 열)
   - `gate --assert-order [--base <ref>]` `<ref>..HEAD` 변경 파일 중 🔒 단계의 `outputs` 글롭에 걸리는 것이 있으면 실패
2. 검사 종류(`how`) 여섯: `lines`(파일 줄 수 ≤ limit), `grep`(정규식 일치 수를 `op`/`limit`과 비교), `test`·`cmd`(명령 종료코드 0), `diff-empty`(지정 경로가 `since` 봉인 이후 변경 없음), `json`(JSON 파일의 경로 값을 `op`/`value`와 비교, 와일드카드 `*` 지원).
3. 봉인 JSON 모양: `{ phase, sealed, head, at, waived, reason, checks: [{ id, ok, measured, limit }] }`.
4. 커밋.

【테스트】 (`scripts/gate.test.mjs`, `node --test`, 임시 git 저장소를 만들어 돌린다)
```
TC-S0.T2.a  선행이 봉인되지 않으면 실행을 거부한다
  단언:  S0 봉인 없이 gate S1 → 종료코드 ≠ 0, 출력에 "S0 봉인 필요"
  검출:  순서 강제가 실제로는 안 걸리는 것 — 실행판 전체의 전제가 무너진다
TC-S0.T2.b  봉인 후 그 단계를 되돌리면 봉인이 무효가 된다
  단언:  봉인 커밋을 git reset --hard HEAD~1 로 버린 뒤 gate --status → 그 단계 "⚠"
  검출:  R2 미구현 — 되돌린 작업이 봉인된 것으로 남아 다음 단계가 열린 채 유지
TC-S0.T2.c  --seal 은 검사를 다시 돌린다
  단언:  한 번 통과한 검사 대상 파일을 깨뜨린 뒤 --seal → 봉인 파일이 쓰이지 않고 종료코드 ≠ 0
  검출:  R3 미구현 — 옛 초록 결과로 봉인
TC-S0.T2.d  검사 종류마다 이빨이 있다
  단언:  lines·grep·test·cmd·diff-empty·json 각각에 대해 위반 상태를 만든 픽스처 → 그 검사만 실패
  검출:  검출력 0 인 검사 종류 — 그 종류로 쓴 모든 GATE 가 항상 초록
TC-S0.T2.e  면제는 사유와 허용 표시가 둘 다 있어야 한다
  단언:  --waived 없이 사유만, 또는 waivable:false 단계에 --waived → 종료코드 ≠ 0, 봉인 없음
  검출:  필수 단계를 면제 봉인으로 건너뛰는 것
TC-S0.T2.f  --assert-order 는 잠긴 단계 산출 변경을 잡는다
  단언:  S1 미봉인 상태에서 S2 outputs 경로(packages/db/**)에 파일 추가 커밋 → gate --assert-order 종료코드 ≠ 0
  검출:  순서를 건너뛴 작업이 push 까지 가는 것
TC-S0.T2.g  위조·복사한 봉인은 무효다
  단언:  S0 봉인 복사, head 에 ref 이름·짧은 SHA·없는 커밋, 검사 목록 불일치, 실패 검사 포함, 면제 불가 단계 면제, 최소 필드만
         → 여덟 경우 모두 S1 "⚠", S2 "🔒", gate S2·--verify-seals 실패
  검출:  봉인 파일 한 줄 편집으로 단계를 건너뛰는 것 (설계 검토 치명 1)
TC-S0.T2.h  구조가 맞는 위조 봉인은 --verify-seals --rerun 이 잡는다
  단언:  검사가 실패하는 커밋을 가리키며 결과는 통과라고 적은 봉인 → 상태는 ✅, --verify-seals --rerun 은 실패
  검출:  모양만 맞춘 위조 봉인이 CI 까지 통과하는 것
TC-S0.T2.i  잠긴 단계의 설정을 같은 변경 안에서 고쳐 순서를 피할 수 없다
  단언:  needs 비우기, outputs 지우기, 단계 삭제, waivable 켜기 각각 + 잠긴 산출 추가 → --assert-order --base 실패
  검출:  gates.config.mjs 를 고친 커밋 하나로 잠금이 풀리는 것 (리뷰 치명 2)
TC-S0.T2.j  --assert-order --head 는 지정한 커밋을 본다
  단언:  main 은 깨끗하고 evil 브랜치에만 위반 → --head evil 이면 실패, 생략하면 통과
  검출:  훅이 체크아웃한 브랜치만 검사해 다른 브랜치 push 로 우회하는 것의 장치 쪽 원인
```
TC-S0.T2.d 에는 다음 하위 단언도 들어간다: `test` 검사는 통과 0개·todo·skip 만 있으면 실패, `grep` 검사는 `in` 경로가 없으면 실패, `diff-empty` 는 기준 봉인 head 가 이상하면 실패, 검사가 빈 단계는 실행 거부.

【통과】
- [ ] G-S0.2 ~ G-S0.7 통과

### ☐ S0.T3 — 실제로 거부하는 장치 연결 (훅과 첫 CI)
선행 S0.T2 · 산출 `.githooks/pre-push`, `package.json`의 `prepare` 스크립트, `.github/workflows/gate.yml`, `scripts/hook.test.mjs` · 되돌리기 커밋 1개

【작업】
1. `.githooks/pre-push`: stdin으로 받은 ref마다 `gate --assert-order --base <원격 sha 또는 원격 main> --head <로컬 sha>`. 원격이 비어 있으면 전체 이력을 본다. `prepare`에서 `git config core.hooksPath .githooks`.
2. `.github/workflows/gate.yml`: push·PR마다 `node --test "scripts/*.test.mjs"`, `gate --assert-order`(PR은 대상 브랜치, push는 직전 커밋 기준), 바뀐 봉인에 대한 `gate --verify-seals --rerun`. 원격 저장소는 아직 없다 (계획서 8장). 파일만 둔다.
3. 커밋.

【테스트】
```
TC-S0.T3.a  pre-push 훅이 잠긴 단계 변경 push 를 막는다
  단언:  임시 bare 원격에 push, S1 미봉인 상태에서 packages/db/x 추가 후 git push → 종료코드 ≠ 0
  검출:  훅이 설치되지 않거나(core.hooksPath 누락) 실행 권한이 없어 순서 강제가 문서에만 남는 것
TC-S0.T3.b  현재 브랜치가 아닌 브랜치를 push 해도 훅이 그 브랜치를 검사한다
  단언:  main 체크아웃 상태에서 위반이 든 evil 브랜치 push → 거부, 원격에 refs/heads/evil 없음
  검출:  훅이 stdin 의 ref 를 무시해 git push origin evil 로 우회하는 것 (리뷰 높음 3)
```

【통과】
- [ ] G-S0.8 통과

## 🚪 GATE S0

| id | 검사 | 명령 | 통과 기준 |
|---|---|---|---|
| G-S0.1 | TC-S0.T1.a | `node scripts/check-workspace.mjs` | 종료코드 0 |
| G-S0.2 | TC-S0.T2.a | `node --test --test-name-pattern="TC-S0.T2.a" scripts/gate.test.mjs` | 종료코드 0 |
| G-S0.3 | TC-S0.T2.b | 같은 방식 `.b` | 종료코드 0 |
| G-S0.4 | TC-S0.T2.c | 같은 방식 `.c` | 종료코드 0 |
| G-S0.5 | TC-S0.T2.d | 같은 방식 `.d` | 종료코드 0 |
| G-S0.6 | TC-S0.T2.e | 같은 방식 `.e` | 종료코드 0 |
| G-S0.7 | TC-S0.T2.f | 같은 방식 `.f` | 종료코드 0 |
| G-S0.8 | TC-S0.T3.a | `node --test --test-reporter=tap --test-name-pattern="TC-S0.T3.a" scripts/hook.test.mjs` | 종료코드 0 |
| G-S0.10 | TC-S0.T2.g | `node --test --test-reporter=tap --test-name-pattern="TC-S0.T2.g" scripts/gate.test.mjs` | 종료코드 0 |
| G-S0.11 | TC-S0.T2.h | 같은 방식 `.h` | 종료코드 0 |
| G-S0.12 | TC-S0.T2.i | 같은 방식 `.i` | 종료코드 0 |
| G-S0.13 | TC-S0.T2.j | 같은 방식 `.j` | 종료코드 0 |
| G-S0.14 | TC-S0.T3.b | `node --test --test-reporter=tap --test-name-pattern="TC-S0.T3.b" scripts/hook.test.mjs` | 종료코드 0 |
| G-S0.15 | CI 테스트 명령이 실제로 돈다 | `node --test --test-reporter=tap "scripts/*.test.mjs"` | 종료코드 0 |
| G-S0.9 | 봉인 디렉터리가 무시되지 않음 | `git check-ignore gates/seals/S0.json` | 종료코드 1 (무시 안 됨) |

`node scripts/gate.mjs S0 --seal`

가장 중요한 검사는 G-S0.2(TC-S0.T2.a)다. 순서 거부가 실제로 동작하지 않으면 이 문서의 나머지 잠금이 모두 산문이 된다.

---

# S1 — 확인 항목 7개 🔒 (S0 필요)

**브랜치** `s1/verify`. 작업 코드는 `spikes/` 아래에만 둔다. `spikes/`는 S7에서 지운다.
**환경** 0단계와 같은 방식: `diegosouzapw/omniroute:3.8.51` 별도 인스턴스(호스트 포트 20140), 가짜 상위 서버(`docs/research/phase0-assets/mock-upstream.mjs`). 사용자가 쓰는 `localhost:20128` 인스턴스는 건드리지 않는다.

### ☐ S1.T1 — V10 관리 토큰 최소 범위와 자동 발급 흐름
선행 없음(단계 안) · 산출 `spikes/v10/`, `docs/verify/V10.json` · 되돌리기 커밋 1개

【작업】
1. `INITIAL_PASSWORD` 로그인 → 접근 토큰 생성 API를 찾아 호출하는 스크립트. `read`·`write`·`admin` 범위마다 키 생성·키 목록·키 PATCH·키 삭제·예산 설정·분석·호출 로그 호출의 상태 코드를 표로 남긴다. 최소 범위를 `answer.minScope`에 적는다. 커밋.

【테스트】
```
TC-S1.T1.a  최소 범위 토큰으로 1단계·2단계에 쓸 관리 호출이 모두 된다
  단언:  answer.minScope 토큰으로 7개 호출 → 모두 2xx (spikes/v10/run.mjs 출력 JSON)
  검출:  범위를 낮게 잡아 S5 부트스트랩 뒤 키 발급이 403 으로 막히는 것
TC-S1.T1.b  더 낮은 범위는 실패한다
  단언:  minScope 보다 한 단계 낮은 범위 토큰 → 7개 중 1개 이상 403
  검출:  "최소"가 실제로는 과한 범위라 회원 앱 탈취 시 피해가 커지는 것 (계획서 5.8)
```

【통과】
- [ ] G-S1.1, G-S1.2 통과

### ☐ S1.T2 — V11 키 끄기의 즉시성
선행 없음 · 산출 `spikes/v11/`, `docs/verify/V11.json` · 되돌리기 커밋 1개

【작업】
1. 키로 요청 → `PATCH isActive=false` → 즉시(지연 0ms, 1s, 5s) 같은 키로 요청. 상태 코드와 응답 코드를 기록. 커밋.

【테스트】
```
TC-S1.T2.a  끈 직후 요청이 거부된다
  단언:  PATCH 응답 직후 첫 요청 → 4xx (2xx 아님). answer.delayMs 에 처음 거부된 시점
  검출:  OmniRoute 가 키 상태를 캐시해 정지한 회원이 캐시 만료까지 계속 쓰는 것 — 계획서 5.7 "정지는 반영 후 완료" 전제 붕괴
```

【통과】
- [ ] G-S1.3 통과

### ☐ S1.T3 — V16 Caddy 허용 목록 경로
선행 없음 · 산출 `spikes/v16/`, `docs/verify/V16.json` · 되돌리기 커밋 1개

【작업】
1. 경로를 기록하는 얇은 로깅 프록시를 OmniRoute 앞에 두고 Claude Code CLI(`claude -p`)와 Codex CLI(`codex exec`)를 한 번씩 실행해 실제 요청 경로를 모은다. Cursor는 자동화할 수 없어 사람이 한 번 실행해 같은 로그에 남긴다 (이 부분은 통과 조건에 넣지 않는다). 커밋.
2. 수집한 경로 + OpenAPI의 루트 `/v1/*` 추론 경로에서 허용 목록 `answer.allow`를 정한다. `/v1/management/`, `/v1/session-leases`, `/v1/ws` 등 관리 별칭은 `answer.deny`. 커밋.

【테스트】
```
TC-S1.T3.a  허용 목록이 실제 도구 요청을 모두 덮는다
  단언:  수집 로그의 모든 경로가 answer.allow 패턴 중 하나에 일치 (스크립트 비교)
  검출:  count_tokens·models 같은 보조 경로가 빠져 Claude Code 가 Caddy 404 로 일부 기능 실패
TC-S1.T3.b  관리 별칭은 허용 목록에 없다
  단언:  answer.deny 의 각 경로가 answer.allow 어느 패턴에도 일치하지 않음
  검출:  /v1/management/… 가 열려 manage 권한 키 하나로 외부에서 관리 API 접근 (0단계 실측: 별칭 존재)
```

【통과】
- [ ] G-S1.4, G-S1.5 통과

### ☐ S1.T4 — V17 권한 칼럼 입력 차단
선행 없음 · 산출 `spikes/v17/`, `docs/verify/V17.json` · 되돌리기 커밋 1개

【작업】
1. `better-auth@1.7.7` + SQLite 최소 앱. `additionalFields` 다섯(`role`, `status`, `monthly_limit_usd`, `max_keys`, `is_bootstrap_admin`)을 `input: false`로. 가입(`/sign-up/email`)과 회원정보 수정(`/update-user`)에 다섯 값을 넣어 보낸다. 대조군으로 `input` 미지정 버전도 돌린다. 커밋.

【테스트】
```
TC-S1.T4.a  input:false 면 가입·수정 본문의 권한 값이 무시되거나 거부된다
  단언:  가입 후 DB user.role = 'member', update-user 후에도 'member' (다섯 칼럼 모두 기본값 유지)
  검출:  role=admin 가입으로 아무나 관리자가 되는 것 (계획서 4.6)
TC-S1.T4.b  대조군: input 미지정이면 값이 들어간다
  단언:  input 미지정 버전에서 같은 요청 → user.role = 'admin'
  검출:  a 가 우연히 통과(필드 이름 오타 등)해 실제로는 보호가 검증되지 않은 것
```

【통과】
- [ ] G-S1.6, G-S1.7 통과

### ☐ S1.T5 — V21 OmniRoute 운영 필수 비밀 값
선행 없음 · 산출 `spikes/v21/`, `docs/verify/V21.json` · 되돌리기 커밋 1개

【작업】
1. OmniRoute 3.8.51의 `.env.example`과 시작 검사 코드에서 운영 모드 필수 비밀 값 목록을 뽑아 `answer.secrets`에 적는다. 운영 모드(`NODE_ENV=production`)로 목록의 값을 모두 넣어 띄우고, 하나씩 빼서 띄워 본다. 커밋.

【테스트】
```
TC-S1.T5.a  목록의 값을 모두 넣으면 운영 모드로 뜬다
  단언:  docker run (모든 secrets) → /livez 200 이 60초 안에
  검출:  목록 누락으로 설치 스크립트가 만든 .env 로는 OmniRoute 가 안 뜨는 것
TC-S1.T5.b  목록의 각 값은 실제로 필수다
  단언:  하나씩 빼고 띄울 때마다 시작 실패 또는 경고 로그 (answer.secrets[*].required 와 일치)
  검출:  필요 없는 값까지 "필수"로 적어 설치 문서가 부풀거나, 필수인데 선택으로 적는 것
```

【통과】
- [ ] G-S1.8, G-S1.9 통과

### ☐ S1.T6 — V26 Better Auth + SSO 플러그인의 MySQL·MariaDB·Postgres 동작
선행 S1.T4 · 산출 `spikes/v26/`, `docs/verify/V26.json` · 되돌리기 커밋 1개

【작업】
1. `better-auth@1.7.7` + `@better-auth/sso@1.7.7` + Drizzle 어댑터로 SQLite·MySQL 8.0·MariaDB 10.11·Postgres 14 각각: 테이블 생성, 가입, 로그인, 세션 시각 저장 왕복, `resolveUser`가 트랜잭션 안에서 실행되는지(일부러 예외를 던져 롤백 확인). Keycloak OIDC 로그인 1회. 커밋.

【테스트】
```
TC-S1.T6.a  네 DB 에서 가입·로그인·세션이 같은 결과를 낸다
  단언:  DB 넷 × (가입 200, 로그인 200, 세션 expiresAt 왕복 오차 < 1s)
  검출:  MySQL DATETIME 정밀도·시간대 차이로 세션이 즉시 만료되거나 영원히 남는 것
TC-S1.T6.b  resolveUser 안 예외는 사용자 생성을 되돌린다
  단언:  resolveUser 가 throw → 네 DB 모두 user·account 행 증가 0
  검출:  트랜잭션이 안 걸려 도메인 검사 거부 후에도 계정이 남는 것 (계획서 4.4 통제 무력화)
TC-S1.T6.c  대소문자만 다른 이메일 중복이 네 DB 에서 같게 처리된다
  단언:  "A@x.test" 가입 후 "a@x.test" 가입 → 네 DB 모두 두 번째 실패
  검출:  MySQL 기본 정렬은 대소문자 무시, Postgres 는 구분이라 DB 마다 계정 중복 여부가 달라지는 것
```

【통과】
- [ ] G-S1.10 ~ G-S1.12 통과

### ☐ S1.T7 — V27 Workers + MySQL(Hyperdrive) Drizzle 동작
선행 없음 · 산출 `spikes/v27/`, `docs/verify/V27.json` · 되돌리기 커밋 1개

【작업】
1. 최소 Worker + Drizzle MySQL 드라이버. `wrangler dev`에서 Hyperdrive `localConnectionString`으로 로컬 MySQL 8.0에 연결해 쓰기·읽기·트랜잭션. 같은 방식으로 Postgres도 1회 (대조). 커밋.

【테스트】
```
TC-S1.T7.a  Worker 에서 MySQL 쓰기·읽기·트랜잭션이 된다
  단언:  GET /probe → { write: true, read: true, txRollback: true }
  검출:  Workers 런타임에서 MySQL 드라이버가 net/tls 의존으로 로드되지 않아 Workers+MySQL 조합이 원천적으로 불가능한 것
```

【통과】
- [ ] G-S1.13 통과

## 🚪 GATE S1

| id | 검사 | 명령 | 통과 기준 |
|---|---|---|---|
| G-S1.1 | TC-S1.T1.a | `node spikes/v10/run.mjs --assert min` | 종료코드 0 |
| G-S1.2 | TC-S1.T1.b | `node spikes/v10/run.mjs --assert lower-fails` | 종료코드 0 |
| G-S1.3 | TC-S1.T2.a | `node spikes/v11/run.mjs --assert` | 종료코드 0 |
| G-S1.4 | TC-S1.T3.a | `node spikes/v16/check.mjs covers` | 종료코드 0 |
| G-S1.5 | TC-S1.T3.b | `node spikes/v16/check.mjs deny` | 종료코드 0 |
| G-S1.6 | TC-S1.T4.a | `pnpm -C spikes/v17 test -t "TC-S1.T4.a"` | 종료코드 0 |
| G-S1.7 | TC-S1.T4.b | `pnpm -C spikes/v17 test -t "TC-S1.T4.b"` | 종료코드 0 |
| G-S1.8 | TC-S1.T5.a | `node spikes/v21/run.mjs all` | 종료코드 0 |
| G-S1.9 | TC-S1.T5.b | `node spikes/v21/run.mjs each` | 종료코드 0 |
| G-S1.10 | TC-S1.T6.a | `pnpm -C spikes/v26 test -t "TC-S1.T6.a"` | 종료코드 0 |
| G-S1.11 | TC-S1.T6.b | `pnpm -C spikes/v26 test -t "TC-S1.T6.b"` | 종료코드 0 |
| G-S1.12 | TC-S1.T6.c | `pnpm -C spikes/v26 test -t "TC-S1.T6.c"` | 종료코드 0 |
| G-S1.13 | TC-S1.T7.a | `node spikes/v27/probe.mjs` | 종료코드 0 |
| G-S1.14 | 확인 파일 7개 존재 | json `docs/verify/V{10,11,16,17,21,26,27}.json` 각각 `item` | 7개 모두 존재 |
| G-S1.15 | 설계를 막는 결과 없음 | json `docs/verify/*.json` `blocking` | 모두 `false` |
| G-S1.16 | 막았던 결과는 개정 버전을 가리킴 | json `docs/verify/*.json` 중 처음에 `blocking:true` 였던 것의 `resolved_in` | 비어 있지 않음, 계획서 상태 줄의 버전과 같음 |

`node scripts/gate.mjs S1 --seal`

가장 중요한 검사는 G-S1.15다. V10·V11·V26 중 하나라도 계획서 전제(최소 범위 토큰, 즉시 차단, 트랜잭션)를 깨면 S2 이후 구현이 잘못된 설계 위에 쌓인다. 이 검사가 설계 개정을 강제한다.

---

# S2 — DB 계층 (네 DB) 🔒 (S1 필요)

**브랜치** `s2/db`. 계획서 3.2 "DB 지원 원칙", 5.9 데이터 모델.

### ☐ S2.T1 — 공통 스키마 정의와 DB별 세 벌 생성
선행 없음 · 산출 `packages/db/src/schema/common.ts`, `packages/db/src/schema/{sqlite,mysql,pg}.ts`, `packages/db/scripts/gen-schema.mjs`, `scripts/schema-lint.mjs` · 되돌리기 커밋 2개

【작업】
1. 공통 정의(테이블·칼럼·의미) 하나에서 `sqlite`·`mysql`·`pg` Drizzle 스키마 세 벌을 생성하는 스크립트. D1은 `sqlite`를 공유. 테이블: Better Auth 다섯 + `app_settings`, `sso_provider_settings`, `invites`, `api_keys`, `omniroute_jobs`, `job_leases`, `audit_log`. 커밋.
2. `scripts/schema-lint.mjs`: 생성된 세 벌에서 규칙 위반을 센다 — 길이 없는 문자열 기본 키·고유 키, `VARCHAR(36)`이 아닌 id, `DECIMAL(12,6)`이 아닌 금액 칼럼(`*_usd`), DB 전용 JSON 칼럼 타입. 커밋.

【테스트】
```
TC-S2.T1.a  생성물이 공통 정의와 어긋나지 않는다
  단언:  gen-schema 재실행 → git diff --exit-code packages/db/src/schema/
  검출:  한 벌만 손으로 고쳐 DB 마다 칼럼이 달라지는 것
TC-S2.T1.b  스키마 규칙 위반 0
  단언:  node scripts/schema-lint.mjs → 위반 0
  검출:  MySQL 에서 TEXT 기본 키로 마이그레이션 실패, 금액 REAL 로 반올림 오차
TC-S2.T1.c  린트에 이빨이 있다 (음성 대조)
  단언:  픽스처 스키마(TEXT 기본 키, REAL 금액, JSON 칼럼 각 1개) → 위반 3
  검출:  린트가 아무것도 안 잡는데 b 가 늘 초록인 것
```

【통과】
- [ ] G-S2.1 ~ G-S2.3 통과

### ☐ S2.T2 — 권한 칼럼과 기본 설정값
선행 S2.T1 · 산출 `packages/db/src/seed.ts` · 되돌리기 커밋 1개

【작업】
1. `user` 추가 칼럼 다섯과 기본값(`role='member'`, `status='active'`, `is_bootstrap_admin=0`). `app_settings` 기본값 시드: `signup_mode='invite_only'`, `default_limit_usd=5`, `default_max_keys=2`, `daily_signup_cap=20`, `signup_requires_approval=true`. 커밋.

【테스트】
```
TC-S2.T2.a  시드 기본값이 계획서 숫자와 같다
  단언:  빈 DB 에 시드 → app_settings 다섯 값이 invite_only / 5 / 2 / 20 / true
  검출:  기본 가입 정책이 open 으로 시드돼 설치 직후 아무나 가입하는 것 (계획서 4.2)
TC-S2.T2.b  시드는 두 번 돌려도 운영자 값을 덮지 않는다
  단언:  시드 → default_limit_usd=10 으로 수정 → 시드 재실행 → 10 유지
  검출:  업그레이드 때 시드가 운영자 설정을 초기화하는 것
```

【통과】
- [ ] G-S2.4, G-S2.5 통과

### ☐ S2.T3 — DB별 마이그레이션과 적용 테스트
선행 S2.T2 · 산출 `packages/db/migrations/{sqlite,mysql,pg}/`, `packages/db/test/migrate.test.ts`, `docker-compose.test.yml` · 되돌리기 커밋 2개

【작업】
1. drizzle-kit으로 DB별 마이그레이션 생성, 저장소에 커밋. 커밋.
2. 테스트용 Compose: `mysql:8.0`, `mariadb:10.11`, `postgres:14`. D1은 `wrangler d1 migrations apply --local`. 빈 DB 다섯(SQLite, MySQL, MariaDB, Postgres, D1)에 적용·시드·테이블 목록 비교. 커밋.

【테스트】
```
TC-S2.T3.a  다섯 DB 에서 빈 상태 → 최신 마이그레이션이 성공한다
  단언:  DB 다섯 × migrate 종료코드 0, 테이블 12개 존재
  검출:  한 DB 에서만 문법 오류로 설치가 실패하는 것 (MariaDB 의 JSON·DEFAULT 표현 차이 등)
TC-S2.T3.b  마이그레이션과 스키마가 어긋나지 않는다
  단언:  drizzle-kit generate --dry → 세 벌 모두 "변경 없음"
  검출:  스키마만 고치고 마이그레이션을 안 만들어 운영 DB 와 코드가 어긋나는 것
TC-S2.T3.c  이메일은 소문자로 저장되고 대소문자 중복이 막힌다
  단언:  DB 다섯 × 저장 계층에 "A@x.test" 저장 → 저장값 "a@x.test", 이어서 "a@x.test" 저장 → 고유 제약 오류
  검출:  V26 c 의 DB 간 정렬 차이를 저장 계층이 흡수하지 못하는 것
```

【통과】
- [ ] G-S2.6 ~ G-S2.8 통과

## 🚪 GATE S2

| id | 검사 | 명령 | 통과 기준 |
|---|---|---|---|
| G-S2.1 | TC-S2.T1.a | `pnpm -C packages/db gen && git diff --exit-code packages/db/src/schema/` | 종료코드 0 |
| G-S2.2 | TC-S2.T1.b | `node scripts/schema-lint.mjs` | 위반 0 |
| G-S2.3 | TC-S2.T1.c | `node scripts/schema-lint.mjs --fixture test/fixtures/bad-schema.ts --expect 3` | 종료코드 0 |
| G-S2.4 | TC-S2.T2.a | `pnpm -C packages/db test -t "TC-S2.T2.a"` | 종료코드 0 |
| G-S2.5 | TC-S2.T2.b | `pnpm -C packages/db test -t "TC-S2.T2.b"` | 종료코드 0 |
| G-S2.6 | TC-S2.T3.a | `pnpm -C packages/db test:migrate --db sqlite,mysql,mariadb,pg,d1` | 종료코드 0 |
| G-S2.7 | TC-S2.T3.b | `pnpm -C packages/db check:drift` | 종료코드 0 |
| G-S2.8 | TC-S2.T3.c | `pnpm -C packages/db test:migrate -t "TC-S2.T3.c"` | 종료코드 0 |
| G-S2.9 | id 길이 | grep `varchar\("id", \{ length: 36` in `packages/db/src/schema/mysql.ts` | ≥ 4 (`invites`, `api_keys`, `omniroute_jobs`, `audit_log`) |
| G-S2.10 | 지원 DB 최소 버전 고정 | grep `mysql:8.0\|mariadb:10.11\|postgres:14` in `docker-compose.test.yml` | 3 |

`node scripts/gate.mjs S2 --seal`

가장 중요한 검사는 G-S2.6이다. 계획서가 약속한 네 DB(+MariaDB) 중 하나라도 빈 DB 설치가 실패하면 "광범위 지원"이 첫 단계에서 깨진다.

---

# S3 — 인증 코어와 메일 🔒 (S2 필요)

**브랜치** `s3/auth`. 계획서 4.2, 4.6, 4.8, 7장 "인증", "요청 수 제한". SSO는 이 단계에서 다루지 않는다 (계획서 9장 5·6단계).

### ☐ S3.T1 — Better Auth 구성
선행 없음 · 산출 `packages/auth/src/index.ts`, `packages/auth/test/` · 되돌리기 커밋 1개

【작업】
1. `better-auth@1.7.7` 버전 고정. 이메일·비밀번호, `requireEmailVerification: true`, 추가 칼럼 다섯 `input: false`, 세션 쿠키 `HttpOnly`·`Secure`·`SameSite=Lax`, 가입 전 이메일 소문자화. `@better-auth/sso`는 이 단계에서 설치하지 않는다. 커밋.

【테스트】
```
TC-S3.T1.a  가입·수정 요청의 권한 칼럼 값이 무시된다 (V17 를 실제 코드로)
  단언:  /sign-up/email 본문에 role:"admin", status:"active", monthly_limit_usd:null, max_keys:999, is_bootstrap_admin:1
         → 생성된 user 의 다섯 값이 모두 기본값. /update-user 동일
  검출:  계획서 4.6 위반 — 가입만으로 관리자
TC-S3.T1.b  이메일 인증 전에는 로그인되지 않는다
  단언:  가입 직후 /sign-in/email → 403 (EMAIL_NOT_VERIFIED)
  검출:  인증 없이 로그인돼 4.2 "인증 후 키 발급" 전제가 깨지는 것
TC-S3.T1.c  세션 쿠키 속성
  단언:  로그인 응답 set-cookie 에 HttpOnly, Secure, SameSite=Lax 셋 다
  검출:  XSS 로 세션 탈취 가능한 쿠키
TC-S3.T1.d  SSO 플러그인이 설치되면 공개 관리 경로 차단 목록이 비어 있지 않아야 한다 (음성 대조 포함)
  단언:  package.json 에 @better-auth/sso 가 없으면 통과. 있으면 disabledPaths 에 "/sso/register" 포함 필수.
         픽스처(플러그인 있음, disabledPaths 없음) → 검사 실패
  검출:  이후 단계에서 플러그인만 먼저 설치돼 일반 사용자가 IdP 를 등록하는 창이 열리는 것 (0단계 실측 계정 탈취)
```

【통과】
- [ ] G-S3.1 ~ G-S3.4 통과

### ☐ S3.T2 — 메일 어댑터 네 종류
선행 S3.T1 · 산출 `packages/auth/src/mail/{smtp,resend,cloudflare,console}.ts` · 되돌리기 커밋 1개

【작업】
1. 공통 인터페이스 `send({to, subject, text, html})`. SMTP(nodemailer, Node 전용), Resend(fetch), Cloudflare Email Service(Workers 바인딩/REST), 콘솔. 인증 메일·비밀번호 재설정 메일 연결. 커밋.

【테스트】
```
TC-S3.T2.a  콘솔 어댑터로 받은 인증 링크가 실제로 인증을 끝낸다
  단언:  가입 → 콘솔 출력에서 URL 추출 → GET → 이후 로그인 200
  검출:  링크의 기준 주소(BETTER_AUTH_URL)가 틀려 운영에서 인증 메일이 깨진 링크가 되는 것
TC-S3.T2.b  SMTP 어댑터가 실제 SMTP 서버로 보낸다
  단언:  mailpit 컨테이너 → 가입 → mailpit API 에 수신 1건, 제목에 인증 문구
  검출:  TLS·인증 옵션 처리 오류로 운영 SMTP 에서만 실패하는 것
TC-S3.T2.c  Resend·Cloudflare 어댑터가 올바른 요청을 만든다
  단언:  fetch 가로채기 → 엔드포인트·인증 헤더·수신자가 기대값과 일치, 비 2xx 응답이면 예외
  검출:  공급자 오류 응답을 삼켜 메일이 안 갔는데 성공으로 처리하는 것
TC-S3.T2.d  비밀번호 재설정 메일의 토큰은 한 번만 쓰인다
  단언:  재설정 링크로 변경 성공 → 같은 링크 재사용 → 실패(4xx)
  검출:  유출된 재설정 링크로 비밀번호를 다시 바꾸는 것
```

【통과】
- [ ] G-S3.5 ~ G-S3.8 통과

### ☐ S3.T3 — 인증 경로 요청 수 제한과 클라이언트 IP
선행 S3.T1 · 산출 `packages/auth/src/rate-limit.ts` · 되돌리기 커밋 1개

【작업】
1. 로그인·가입·비밀번호 재설정에 요청 수 제한. 클라이언트 IP는 런타임 어댑터의 `clientIp()`에서 받는다 (S4.T2와 인터페이스만 맞추고, 여기서는 가짜 어댑터로 테스트). 신뢰할 프록시에서 온 요청만 `X-Forwarded-For`를 믿는다. 커밋.

【테스트】
```
TC-S3.T3.a  같은 IP 의 반복 로그인 실패는 429 가 된다
  단언:  같은 IP 로 틀린 비밀번호 N+1 회 → 마지막 429
  검출:  비밀번호 대입 공격 무방비
TC-S3.T3.b  신뢰하지 않는 출처의 X-Forwarded-For 는 무시된다
  단언:  신뢰 목록 밖 출처에서 X-Forwarded-For 를 매번 바꿔 N+1 회 → 429 (헤더 위조로 우회 불가)
  검출:  헤더만 바꿔 요청 수 제한을 무한히 우회하는 것
TC-S3.T3.c  신뢰 프록시 뒤에서는 실제 클라이언트별로 센다
  단언:  신뢰 프록시 출처 + 서로 다른 X-Forwarded-For 두 개 → 각자 N 회까지 허용
  검출:  Caddy IP 하나로 모두 묶여 한 사람 때문에 전원이 막히는 것 (계획서 7장)
```

【통과】
- [ ] G-S3.9 ~ G-S3.11 통과

## 🚪 GATE S3

| id | 검사 | 명령 | 통과 기준 |
|---|---|---|---|
| G-S3.1 | TC-S3.T1.a | `pnpm -C packages/auth test -t "TC-S3.T1.a"` | 종료코드 0 |
| G-S3.2 | TC-S3.T1.b | `pnpm -C packages/auth test -t "TC-S3.T1.b"` | 종료코드 0 |
| G-S3.3 | TC-S3.T1.c | `pnpm -C packages/auth test -t "TC-S3.T1.c"` | 종료코드 0 |
| G-S3.4 | TC-S3.T1.d | `node scripts/check-sso-paths.mjs && node scripts/check-sso-paths.mjs --fixture test/fixtures/sso-unguarded --expect-fail` | 종료코드 0 |
| G-S3.5 | TC-S3.T2.a | `pnpm -C packages/auth test -t "TC-S3.T2.a"` | 종료코드 0 |
| G-S3.6 | TC-S3.T2.b | `pnpm -C packages/auth test:smtp` | 종료코드 0 |
| G-S3.7 | TC-S3.T2.c | `pnpm -C packages/auth test -t "TC-S3.T2.c"` | 종료코드 0 |
| G-S3.8 | TC-S3.T2.d | `pnpm -C packages/auth test -t "TC-S3.T2.d"` | 종료코드 0 |
| G-S3.9 | TC-S3.T3.a | `pnpm -C packages/auth test -t "TC-S3.T3.a"` | 종료코드 0 |
| G-S3.10 | TC-S3.T3.b | `pnpm -C packages/auth test -t "TC-S3.T3.b"` | 종료코드 0 |
| G-S3.11 | TC-S3.T3.c | `pnpm -C packages/auth test -t "TC-S3.T3.c"` | 종료코드 0 |
| G-S3.12 | Better Auth 버전 고정 | json `packages/auth/package.json` `dependencies.better-auth` | `"1.7.7"` (범위 기호 없음) |
| G-S3.13 | `input: false` 다섯 칼럼 | grep `input:\s*false` in `packages/auth/src/index.ts` | ≥ 5 |

`node scripts/gate.mjs S3 --seal`

가장 중요한 검사는 G-S3.1이다. 외부 가입을 받는 오픈소스에서 가입만으로 관리자가 되면 다른 모든 통제가 의미를 잃는다.

---

# S4 — 서버·런타임·화면·최초 설치 🔒 (S3 필요)

**브랜치** `s4/server`. 계획서 3.1, 3.2, 4.7(1·2·4·5번), 7장 "비밀 값".

### ☐ S4.T1 — 런타임 어댑터 두 벌
선행 없음 · 산출 `packages/runtime/src/{types,node,workers}.ts` · 되돌리기 커밋 1개

【작업】
1. 인터페이스: `db()`, `schedule(name, cron, fn)`(Node는 프로세스 안 + `job_leases` 임대, Workers는 Cron Trigger 연결), `rateLimitStore()`(Node 단일=메모리, 여러 인스턴스=DB, Workers=KV), `secret(name)`, `clientIp(req)`(Workers는 `CF-Connecting-IP`). 커밋.

【테스트】
```
TC-S4.T1.a  job_leases 임대는 동시에 한 인스턴스만 잡는다
  단언:  MySQL·Postgres 각각 두 연결이 같은 이름을 동시에 임대 시도 → 정확히 하나 성공
  검출:  여러 인스턴스에서 5분 정합성 점검·1분 예산 조정이 중복 실행돼 OmniRoute 호출이 두 배가 되는 것 (계획서 3.2)
TC-S4.T1.b  임대 만료 후에는 다른 인스턴스가 잡는다
  단언:  locked_until 이 지난 임대 → 다른 holder 가 성공
  검출:  인스턴스가 죽으면 주기 작업이 영원히 멈추는 것
TC-S4.T1.c  Workers clientIp 는 CF-Connecting-IP 를 쓰고 X-Forwarded-For 를 무시한다
  단언:  두 헤더가 다른 요청 → CF-Connecting-IP 값
  검출:  Workers 에서 헤더 위조로 요청 수 제한 우회
```

【통과】
- [ ] G-S4.1 ~ G-S4.3 통과

### ☐ S4.T2 — 암호화 유틸
선행 없음 · 산출 `packages/runtime/src/crypto.ts` · 되돌리기 커밋 1개

【작업】
1. WebCrypto AES-256-GCM, 키는 `APP_ENCRYPTION_KEY`(32바이트 base64). 출력 형식에 버전 접두사(`v1:`). Node·Workers 같은 코드. 커밋.

【테스트】
```
TC-S4.T2.a  Node 에서 암호화한 값을 Workers 에서 복호화한다 (반대도)
  단언:  고정 벡터 파일 → 양쪽 런타임 테스트에서 같은 평문
  검출:  런타임별 인코딩 차이로 Docker→Workers 이전 시 저장된 비밀 값을 못 읽는 것
TC-S4.T2.b  변조된 암호문은 복호화에 실패한다
  단언:  암호문 1바이트 변경 → 예외
  검출:  인증 태그 검증 누락 — 변조된 토큰을 그대로 사용
TC-S4.T2.c  키가 32바이트가 아니면 시작을 거부한다
  단언:  16바이트 키로 초기화 → 예외
  검출:  약한 키로 조용히 운영되는 것
```

【통과】
- [ ] G-S4.4 ~ G-S4.6 통과

### ☐ S4.T3 — Hono 서버와 SvelteKit SPA
선행 S4.T1 · 산출 `apps/server/src/`, `apps/web/` · 되돌리기 커밋 2개

【작업】
1. Hono 앱: `/api/auth/*`에 S3의 Better Auth 연결, `/api/*` 그 밖은 JSON 404, `/healthz`. Node 진입점과 Workers 진입점. 커밋.
2. `apps/web`: SvelteKit, `adapter-static`, 루트 `+layout.ts`에 `ssr = false`, `fallback: 'index.html'`. 빌드 결과를 Node는 Hono 정적 제공, Workers는 정적 자산으로. 커밋.

【테스트】
```
TC-S4.T3.a  깊은 주소는 SPA 로, /api 는 JSON 으로 간다
  단언:  GET /keys → 200 text/html (index.html), GET /api/nope → 404 application/json
  검출:  모르는 API 경로가 index.html 200 을 돌려 클라이언트가 오류를 성공으로 오인하는 것
TC-S4.T3.b  Node 와 Workers 가 같은 빌드 결과를 제공한다
  단언:  두 진입점에서 GET / 의 본문 해시가 같다
  검출:  런타임별로 다른 빌드가 배포돼 Workers 에서만 화면이 깨지는 것
TC-S4.T3.c  SPA 빌드에 서버 렌더링 산출이 없다
  단언:  apps/web/build 에 server 디렉터리 없음, 모든 라우트가 정적 파일
  검출:  ssr=false 누락으로 adapter-static 빌드가 실패하거나 Hono 와 서버 역할이 겹치는 것
```

【통과】
- [ ] G-S4.7 ~ G-S4.9 통과

### ☐ S4.T4 — 최초 설치 흐름
선행 S4.T2, S4.T3 · 산출 `apps/server/src/setup/`, `apps/web/src/routes/setup/` · 되돌리기 커밋 1개

【작업】
1. 관리자가 없으면 시작 시 일회용 설치 토큰을 생성해 콘솔에 한 번 출력하고 해시만 저장. `/setup`에서 토큰 + 이메일·비밀번호 → 최초 관리자(`role=admin`, `is_bootstrap_admin=1`, 이메일 인증 완료 처리) 생성. 공개 주소 입력. OmniRoute 단계는 S5에서 붙인다. 커밋.

【테스트】
```
TC-S4.T4.a  설치 토큰은 한 번만 쓰인다
  단언:  관리자 생성 성공 → 같은 토큰으로 다시 /setup → 409
  검출:  설치 후에도 /setup 이 열려 있어 토큰을 본 사람이 관리자를 추가하는 것
TC-S4.T4.b  틀린 토큰은 거부된다
  단언:  틀린 토큰 → 401, user 행 증가 0
  검출:  토큰 검사 누락 — 설치 직후 먼저 접속한 아무나 관리자
TC-S4.T4.c  토큰 원문이 DB 에 없다
  단언:  DB 전체 덤프에서 토큰 원문 문자열 검색 → 0건
  검출:  DB 유출 시 설치 토큰 재사용 (계획서 7장 "해시만 저장" 원칙)
TC-S4.T4.d  관리자가 있으면 설치 토큰을 만들지 않는다
  단언:  관리자 존재 상태로 재시작 → 콘솔에 토큰 출력 없음, /setup → 409
  검출:  재시작할 때마다 새 설치 토큰이 생겨 로그에 남는 것
```

【통과】
- [ ] G-S4.10 ~ G-S4.13 통과

## 🚪 GATE S4

| id | 검사 | 명령 | 통과 기준 |
|---|---|---|---|
| G-S4.1 | TC-S4.T1.a | `pnpm -C packages/runtime test:db -t "TC-S4.T1.a" --db mysql,pg` | 종료코드 0 |
| G-S4.2 | TC-S4.T1.b | `pnpm -C packages/runtime test:db -t "TC-S4.T1.b" --db mysql,pg` | 종료코드 0 |
| G-S4.3 | TC-S4.T1.c | `pnpm -C packages/runtime test -t "TC-S4.T1.c"` | 종료코드 0 |
| G-S4.4 | TC-S4.T2.a | `pnpm -C packages/runtime test:cross-runtime` | 종료코드 0 |
| G-S4.5 | TC-S4.T2.b | `pnpm -C packages/runtime test -t "TC-S4.T2.b"` | 종료코드 0 |
| G-S4.6 | TC-S4.T2.c | `pnpm -C packages/runtime test -t "TC-S4.T2.c"` | 종료코드 0 |
| G-S4.7 | TC-S4.T3.a | `pnpm -C apps/server test -t "TC-S4.T3.a"` | 종료코드 0 |
| G-S4.8 | TC-S4.T3.b | `pnpm -C apps/server test:both-runtimes -t "TC-S4.T3.b"` | 종료코드 0 |
| G-S4.9 | TC-S4.T3.c | `pnpm -C apps/web build && test ! -d apps/web/build/server` | 종료코드 0 |
| G-S4.10 | TC-S4.T4.a | `pnpm -C apps/server test -t "TC-S4.T4.a"` | 종료코드 0 |
| G-S4.11 | TC-S4.T4.b | `pnpm -C apps/server test -t "TC-S4.T4.b"` | 종료코드 0 |
| G-S4.12 | TC-S4.T4.c | `pnpm -C apps/server test -t "TC-S4.T4.c"` | 종료코드 0 |
| G-S4.13 | TC-S4.T4.d | `pnpm -C apps/server test -t "TC-S4.T4.d"` | 종료코드 0 |
| G-S4.14 | SPA 모드 고정 | grep `export const ssr = false` in `apps/web/src/routes/+layout.ts` | 1 |

`node scripts/gate.mjs S4 --seal`

가장 중요한 검사는 G-S4.10이다. 오픈소스 설치본은 공개 인터넷에 바로 뜨는 경우가 많아, `/setup`이 닫히지 않으면 첫 방문자가 관리자를 가져간다.

---

# S5 — OmniRoute 어댑터·부트스트랩·계약 테스트 🔒 (S4 필요)

**브랜치** `s5/omniroute`. 계획서 3.3, 4.7(3번), 5.6, 5.8.

### ☐ S5.T1 — 계약 테스트 환경
선행 없음 · 산출 `tests/contract/docker-compose.yml`, `tests/contract/mock-upstream.mjs`, `tests/contract/setup.mjs` · 되돌리기 커밋 1개

【작업】
1. `docs/research/phase0-assets/mock-upstream.mjs`를 `tests/contract/`로 옮겨 쓴다. Compose: `diegosouzapw/omniroute:3.8.51`(digest 고정, `REQUIRE_API_KEY=true`), 가짜 상위 서버. `setup.mjs`가 0단계와 같은 방식으로 제공자 노드 둘(OpenAI 호환·Anthropic 호환)과 연결, 가격(입력 10, 출력 50, 캐시 읽기 1, 캐시 쓰기 12.5 / 백만 토큰)을 등록. 커밋.

【테스트】
```
TC-S5.T1.a  계약 환경이 0단계 실측값을 재현한다
  단언:  비스트리밍 OpenAI 요청 → X-OmniRoute-Tokens-In 111, Tokens-Out 22, Response-Cost 0.0022100000
  검출:  환경 구성이 달라(가격 미등록 등) 이후 계약 테스트의 비용 단언이 엉뚱한 이유로 통과·실패하는 것
```

【통과】
- [ ] G-S5.1 통과

### ☐ S5.T2 — OmniRoute 어댑터
선행 S5.T1 · 산출 `packages/omniroute/src/` · 되돌리기 커밋 1개

【작업】
1. 함수: `loginWithPassword`, `createAccessToken(scope)`, `listKeys`, `createKey`, `setKeyActive`, `deleteKey`, `setBudget`, `getAnalytics({apiKeyIds, startDate, endDate})`, `getCallLogs`. 쓰는 응답 필드만 zod로 검사. 쿠키 인증 변경 요청에는 `Origin` 헤더를 붙인다. OmniRoute 호출은 이 패키지 밖에서 하지 않는다. 커밋.

【테스트】
```
TC-S5.T2.a  키 없는 /v1 요청은 401 이다
  단언:  /v1/models, /v1/chat/completions 키 없이 → 둘 다 401
  검출:  REQUIRE_API_KEY 가 꺼진 이미지·설정으로 바뀌어 익명 사용이 열리는 것 (설계 검토 치명 1)
TC-S5.T2.b  생성 → 끄기 → 예산 → 켜기 → 요청 순서가 동작한다
  단언:  createKey → setKeyActive(false) → setBudget(monthly 1.0) → setKeyActive(true) → 요청 200
  검출:  2단계 발급 순서(계획서 5.2)가 OmniRoute 에서 실제로 성립하지 않는 것
TC-S5.T2.c  끈 키는 거부된다
  단언:  setKeyActive(false) 직후 요청 → 4xx (V11 결과의 지연 이내)
  검출:  정지 회원이 계속 쓰는 것
TC-S5.T2.d  예산을 넘으면 429 BUDGET_EXCEEDED
  단언:  예산 0.01, 요청 3건(0.00221 + 0.0062115 × 2 = 0.014633) 후 → 429, code "BUDGET_EXCEEDED"
  검출:  OmniRoute 업데이트로 예산 차단 동작·코드가 바뀌어 회원 한도가 무력화되는 것
TC-S5.T2.e  분석이 키별 비용을 정확히 낸다 (스트리밍 포함)
  단언:  위 3건(스트리밍 1건 포함) 뒤 getAnalytics(apiKeyIds=[그 키]) → summary.totalCost = 0.014633 (오차 1e-9)
  검출:  분석 응답 형식·계산이 바뀌어 사용량 화면과 2단계 한도 분배가 틀린 값을 쓰는 것
TC-S5.T2.f  응답 형식이 바뀌면 조용히 넘어가지 않고 오류를 낸다
  단언:  getAnalytics 응답에서 summary.totalCost 를 문자열로 바꾼 가짜 응답 → 어댑터가 예외
  검출:  형식 변화가 NaN·0 으로 흘러 한도가 무제한처럼 동작하는 것
TC-S5.T2.g  쿠키 인증 변경 요청에 Origin 이 붙는다
  단언:  Origin 없이 보낸 대조 요청 → AUTH_001, 어댑터 경유 → 2xx
  검출:  0단계 실측대로 Origin 없는 변경 요청이 거부돼 부트스트랩이 실패하는 것
TC-S5.T2.h  어댑터 밖에서 OmniRoute 를 직접 부르지 않는다
  단언:  grep "/api/keys\|/api/usage" in apps/ packages/ (packages/omniroute 제외) → 0
  검출:  호출이 흩어져 OmniRoute 버전 변경 영향 범위를 못 잡는 것 (계획서 5.6)
```

【통과】
- [ ] G-S5.2 ~ G-S5.9 통과

### ☐ S5.T3 — OmniRoute 부트스트랩
선행 S5.T2 · 산출 `apps/server/src/setup/omniroute.ts` · 되돌리기 커밋 1개

【작업】
1. 최초 설치 3단계: `INITIAL_PASSWORD`로 로그인해 V10의 최소 범위 토큰을 만들고 `crypto.ts`로 암호화해 `app_settings`에 저장. 자동 발급이 안 되는 환경은 토큰 붙여 넣기 입력. 저장 뒤 키 목록 호출로 연결 확인. 커밋.

【테스트】
```
TC-S5.T3.a  설치가 끝나면 최소 범위 토큰이 암호화되어 저장된다
  단언:  /setup 완료 → app_settings 의 토큰 값이 "v1:" 로 시작, DB 덤프에 "oma_live_" 0건, 복호화 값으로 listKeys 200
  검출:  관리 토큰이 평문 저장돼 DB 유출이 곧 제공자 키 유출이 되는 것
TC-S5.T3.b  저장된 토큰의 범위가 V10 최소 범위와 같다
  단언:  OmniRoute 접근 토큰 목록에서 그 토큰의 scope == docs/verify/V10.json answer.minScope
  검출:  편의상 admin 범위로 발급돼 회원 앱 탈취 시 피해가 커지는 것
TC-S5.T3.c  INITIAL_PASSWORD 가 틀리면 설치가 그 단계에서 멈추고 붙여 넣기 입력을 연다
  단언:  틀린 비밀번호 → 설치 응답에 omniroute: "manual_required", 관리자 계정은 생성됨
  검출:  OmniRoute 연결 실패가 설치 전체를 깨뜨려 관리자도 못 만드는 것
```

【통과】
- [ ] G-S5.10 ~ G-S5.12 통과

## 🚪 GATE S5

| id | 검사 | 명령 | 통과 기준 |
|---|---|---|---|
| G-S5.1 | TC-S5.T1.a | `pnpm test:contract -t "TC-S5.T1.a"` | 종료코드 0 |
| G-S5.2 ~ G-S5.8 | TC-S5.T2.a ~ g | `pnpm test:contract -t "TC-S5.T2.<x>"` (7개 각각) | 종료코드 0 |
| G-S5.9 | TC-S5.T2.h | grep `/api/(keys\|usage)` in `apps/ packages/` 제외 `packages/omniroute` | 0 |
| G-S5.10 ~ G-S5.12 | TC-S5.T3.a ~ c | `pnpm test:contract -t "TC-S5.T3.<x>"` (3개 각각) | 종료코드 0 |
| G-S5.13 | OmniRoute 버전 고정 | grep `diegosouzapw/omniroute:3\.8\.51@sha256:` in `tests/contract/docker-compose.yml` | 1 |

`node scripts/gate.mjs S5 --seal`

가장 중요한 검사는 G-S5.5(TC-S5.T2.d)다. A안은 회원 한도의 실제 차단을 OmniRoute에 맡긴다. 이 동작이 OmniRoute 버전 변화로 사라지면 우리 코드는 아무 경고 없이 한도를 잃는다.

---

# S6 — 배포 묶음과 여섯 조합 E2E 🔒 (S5 필요)

**브랜치** `s6/deploy`. 계획서 3.2 표, 4.7, 7장 "OmniRoute 노출".

### ☐ S6.T1 — 설치 스크립트
선행 없음 · 산출 `scripts/init.mjs`, `.env.example` · 되돌리기 커밋 1개

【작업】
1. `node scripts/init.mjs` (나중에 `npx magnetosphere init`): `.env` 생성. 무작위 값: `INITIAL_PASSWORD`, V21 목록 전부, `APP_ENCRYPTION_KEY`(32바이트), `BETTER_AUTH_SECRET`. 고정 값: `REQUIRE_API_KEY=true`, `PRICING_SYNC_ENABLED=true`. 기존 `.env`가 있으면 덮지 않고 종료코드 1. 커밋.

【테스트】
```
TC-S6.T1.a  필수 값이 모두 들어간다
  단언:  생성된 .env 에 V21.answer.secrets 전부 + REQUIRE_API_KEY=true + PRICING_SYNC_ENABLED=true + APP_ENCRYPTION_KEY(디코드 32바이트)
  검출:  설치 직후 OmniRoute 가 운영 모드로 안 뜨거나 익명 /v1 이 열리는 것
TC-S6.T1.b  두 번 생성한 비밀 값이 서로 다르다
  단언:  임시 폴더 두 곳에서 init → 비밀 값 전부 서로 다름
  검출:  고정 기본값이 섞여 모든 설치본이 같은 비밀번호를 갖는 것
TC-S6.T1.c  기존 .env 를 덮지 않는다
  단언:  .env 있는 상태에서 init → 종료코드 1, 파일 해시 불변
  검출:  재실행으로 APP_ENCRYPTION_KEY 가 바뀌어 저장된 비밀 값을 영영 못 읽는 것
```

【통과】
- [ ] G-S6.1 ~ G-S6.3 통과

### ☐ S6.T2 — Docker Compose와 Caddy
선행 S6.T1 · 산출 `docker-compose.yml`, `deploy/Caddyfile`, `apps/server/Dockerfile` · 되돌리기 커밋 1개

【작업】
1. 서비스: `caddy`, `app`, `omniroute`(3.8.51 digest 고정), 프로필 `mysql`(8.0), `postgres`(14). OmniRoute 대시보드는 `127.0.0.1:20128`에만 묶고 그 밖의 OmniRoute 포트는 호스트에 열지 않는다. Caddy: V16 `answer.allow`만 OmniRoute로, 그 밖의 `/v1/*`는 404, 나머지는 `app`으로. 커밋.

【테스트】
```
TC-S6.T2.a  Caddy 를 거친 키 없는 /v1 은 401
  단언:  Caddy 주소로 /v1/models 키 없이 → 401
  검출:  Caddy 가 인증 헤더를 떨어뜨리거나 다른 백엔드로 보내 결과가 달라지는 것
TC-S6.T2.b  허용 목록 밖 /v1 경로는 Caddy 에서 404
  단언:  /v1/management/proxy-subscriptions, /v1/session-leases → 404, 응답 본문에 OmniRoute 오류 코드(AUTH_00x) 없음
  검출:  관리 별칭이 접두사 규칙으로 열려 OmniRoute 에 닿는 것 (0단계 실측: 별칭 존재)
TC-S6.T2.c  /api/* 는 OmniRoute 가 아니라 회원 앱으로 간다
  단언:  Caddy 주소 /api/keys → 회원 앱 JSON 404, 본문에 "Invalid management token" 없음
  검출:  OmniRoute 관리 API 가 공개 주소로 노출되는 것
TC-S6.T2.d  OmniRoute 포트는 루프백에만 열린다
  단언:  docker compose config --format json → omniroute.ports 의 모든 host_ip == "127.0.0.1"
  검출:  대시보드가 0.0.0.0 으로 열려 인터넷에서 관리 화면 접근
```

【통과】
- [ ] G-S6.4 ~ G-S6.7 통과

### ☐ S6.T3 — Workers 설정
선행 없음 · 산출 `apps/server/wrangler.toml` (환경 `d1`, `mysql`, `pg`) · 되돌리기 커밋 1개

【작업】
1. 환경별 바인딩: D1, Hyperdrive(MySQL), Hyperdrive(Postgres), KV(요청 수 제한), Cron Trigger, 정적 자산(`apps/web/build`). `nodejs_compat`. 커밋.

【테스트】
```
TC-S6.T3.a  세 환경 모두 번들이 만들어진다
  단언:  wrangler deploy --dry-run --env d1|mysql|pg → 셋 다 종료코드 0
  검출:  Node 전용 모듈(nodemailer 등)이 Workers 번들에 섞여 배포가 실패하는 것
```

【통과】
- [ ] G-S6.8 통과

### ☐ S6.T4 — 여섯 조합 E2E
선행 S6.T2, S6.T3 · 산출 `tests/e2e/`, `package.json`의 `e2e` 스크립트 · 되돌리기 커밋 1개

【작업】
1. `pnpm e2e --combo <이름>`: 띄우기 → 로그에서 설치 토큰 추출 → `/setup`으로 관리자 생성 → OmniRoute 부트스트랩 확인 → 로그아웃 → 로그인. 조합 여섯: `docker-sqlite`, `docker-mysql`, `docker-pg`, `workers-d1`, `workers-mysql`, `workers-pg`. Workers 조합은 `wrangler dev`(D1 로컬, Hyperdrive `localConnectionString`)로 돌리고 OmniRoute는 로컬 주소로 직접 연결한다 (Workers 운영 연결 방식은 V24, 계획서 9장 8단계). 커밋.

【테스트】
```
TC-S6.T4.a ~ f  조합마다 설치 → 관리자 → 부트스트랩 → 로그인이 된다
  단언:  조합 하나당 setup 201, omniroute 연결 "ok", 로그인 200, 세션 쿠키 존재
  검출:  특정 런타임·DB 조합에서만 설치가 깨지는 것 — 1단계 완료 기준 "여섯 조합" 위반
```

【통과】
- [ ] G-S6.9 ~ G-S6.14 통과

## 🚪 GATE S6

| id | 검사 | 명령 | 통과 기준 |
|---|---|---|---|
| G-S6.1 ~ G-S6.3 | TC-S6.T1.a ~ c | `node --test --test-name-pattern="TC-S6.T1.<x>" scripts/init.test.mjs` | 종료코드 0 |
| G-S6.4 ~ G-S6.7 | TC-S6.T2.a ~ d | `pnpm test:deploy -t "TC-S6.T2.<x>"` | 종료코드 0 |
| G-S6.8 | TC-S6.T3.a | `pnpm -C apps/server dry-run:all` | 종료코드 0 |
| G-S6.9 ~ G-S6.14 | TC-S6.T4.a ~ f | `pnpm e2e --combo <조합>` (6개 각각) | 종료코드 0 |
| G-S6.15 | Compose OmniRoute 버전 고정 | grep `diegosouzapw/omniroute:3\.8\.51@sha256:` in `docker-compose.yml` | 1 |
| G-S6.16 | `REQUIRE_API_KEY=true` 명시 | grep `REQUIRE_API_KEY=true` in `.env.example` | 1 |
| G-S6.17 | DB 최소 버전 | grep `mysql:8.0\|postgres:14` in `docker-compose.yml` | 2 |
| G-S6.18 | 대시보드 포트 루프백 고정 | grep `"127\.0\.0\.1:20128:20128"` in `docker-compose.yml` | 1 |

`node scripts/gate.mjs S6 --seal`

가장 중요한 검사는 G-S6.9~G-S6.14다. 이 여섯이 1단계 전체의 최종 판정이다 (아래 최종 목표표).

---

# S7 — 재발 방지와 잔재 회수 🔒 (S6 필요)

**브랜치** `s7/guard`.

### ☐ S7.T1 — CI 매트릭스
선행 없음 · 산출 `.github/workflows/ci.yml` · 되돌리기 커밋 1개

【작업】
1. 잡: 단위(`node --test scripts/`, 각 패키지 test), 스키마(G-S2 전부), 계약(G-S5 전부), E2E 매트릭스 여섯 조합, `gate --assert-order`. 원격이 정해지면 필수 검사로 지정한다 (원격 미정, 계획서 8장). 커밋.

【테스트】
```
TC-S7.T1.a  CI 매트릭스가 여섯 조합을 모두 돈다
  단언:  ci.yml 의 e2e matrix.combo 목록 == 여섯 이름 (스크립트로 YAML 파싱)
  검출:  조합 하나가 CI 에서 빠져 그 조합이 깨져도 아무도 모르는 것
TC-S7.T1.b  매트릭스 검사에 이빨이 있다 (음성 대조)
  단언:  조합 다섯만 있는 픽스처 YAML → 검사 실패
  검출:  검사가 YAML 을 못 읽고 늘 통과하는 것
```

【통과】
- [ ] G-S7.1 통과

### ☐ S7.T2 — 확인용 코드 회수
선행 없음 · 산출 `spikes/` 삭제, `docs/verify/` 유지 · 되돌리기 커밋 1개

【작업】
1. `spikes/` 전체 삭제. 확인 결과 JSON과 근거는 `docs/verify/`에 남긴다. 가짜 상위 서버는 `tests/contract/`만 남기고 `docs/research/phase0-assets/`는 기록용으로 둔다. 커밋.

【테스트】
```
TC-S7.T2.a  확인용 코드가 남지 않는다
  단언:  test ! -e spikes, grep "spikes/" in apps/ packages/ scripts/ tests/ → 0
  검출:  확인용 코드가 제품 코드에 import 된 채 남는 것
```

【통과】
- [ ] G-S7.2 통과

### ☐ S7.T3 — 가짜 완료 표식 0
선행 없음 · 산출 없음 (검사만) · 되돌리기 해당 없음

【작업】
1. 제품 코드에 남은 `.only(`, `.skip(`, `TODO`, `FIXME`, `not implemented`를 없앤다. 필요한 것은 계획서 2차 항목으로 옮기고 지운다. 커밋.

【테스트】
```
TC-S7.T3.a  건너뛴 테스트와 미구현 표식이 없다
  단언:  grep -E "\.(only|skip)\(|TODO|FIXME|not implemented" in apps/ packages/ tests/ → 0
  검출:  .skip 으로 꺼진 계약 테스트 때문에 G-S5 가 초록으로 보이는 것
```

【통과】
- [ ] G-S7.3 통과

## 🚪 GATE S7

| id | 검사 | 명령 | 통과 기준 |
|---|---|---|---|
| G-S7.1 | TC-S7.T1.a | `node scripts/check-ci-matrix.mjs --expect 6 && node scripts/check-ci-matrix.mjs --fixture test/fixtures/ci-5combos.yml --expect 6 --expect-fail` | 종료코드 0 |
| G-S7.2 | TC-S7.T2.a | `test ! -e spikes && ! grep -r "spikes/" apps packages scripts tests` | 종료코드 0 |
| G-S7.3 | TC-S7.T3.a | grep `\.(only\|skip)\(\|TODO\|FIXME\|not implemented` in `apps/ packages/ tests/` | 0 |
| G-S7.4 | 앞 단계 봉인 모두 유효 | `node scripts/gate.mjs --status --json` | S0~S6 모두 ✅ (⚠ 0) |
| G-S7.5 | 순서 위반 없음 | `node scripts/gate.mjs --assert-order --base $(git rev-list --max-parents=0 HEAD)` | 종료코드 0 |

`node scripts/gate.mjs S7 --seal`

가장 중요한 검사는 G-S7.3이다. 이 문서의 모든 통과가 테스트 종료코드에 기대므로, 꺼진 테스트 하나가 단계 전체를 거짓 초록으로 만든다.

---

## 최종 목표표

계획서 9장 1단계 완료 기준을 옮긴 것이다.

| 지표 | 목표 | 검사 |
|---|---|---|
| **여섯 조합 설치·관리자 생성·로그인 E2E 통과 수** | **6 / 6** | G-S6.9 ~ G-S6.14 |
| 다섯 DB 빈 상태 마이그레이션 (SQLite, MySQL 8.0, MariaDB 10.11, Postgres 14, D1) | 5 / 5 | G-S2.6 |
| 계약 테스트 | 전부 통과 | G-S5.1 ~ G-S5.12 |
| 키 없는 `/v1` | 401 | G-S5.2, G-S6.4 |
| 허용 목록 밖 `/v1` | 404 (Caddy) | G-S6.5 |
| 확인 항목 | 7 / 7, 설계 막음 0 | G-S1.14, G-S1.15 |
| 권한 칼럼 입력 차단 | 5 / 5 칼럼 | G-S3.1, G-S3.13 |

최종 판정은 **여섯 조합 E2E 6/6**이다. 계획서가 1단계 완료를 "여섯 조합(3.2) 모두에서 마이그레이션·설치·관리자 생성·로그인 성공"으로 정의했고, 나머지 지표는 모두 이 E2E가 지나가는 길 위에 있다.

## 막혔을 때

- **게이트가 빨간데 원인을 모름**: `node scripts/gate.mjs <단계> --explain`으로 측정값과 기준을 본다. 테스트 검사면 그 TC 하나만 `-t "TC-…"`로 돌린다.
- **봉인 뒤 회귀**: 봉인을 고치지 않는다. 고친 커밋을 올린 뒤 `--seal`을 다시 돌린다 (R3). 봉인 커밋을 되돌렸다면 `--status`가 ⚠로 보여주고 다음 단계는 다시 잠긴다 (R2).
- **확인 결과가 설계와 다름 (S1)**: 해당 `V*.json`을 `blocking: true`로 두고 계획서를 개정한다. 개정 버전을 `resolved_in`에 적고 `blocking: false`로 바꾼다. 설계를 고치지 않고 결과만 바꾸지 않는다.
- **특정 조합만 E2E 실패 (S6)**: 그 조합의 DB를 S2 마이그레이션 테스트(G-S2.6)로, 런타임을 S4 교차 테스트(G-S4.4, G-S4.8)로 먼저 좁힌다.
- **OmniRoute 계약 테스트가 갑자기 실패**: 이미지 digest가 바뀌었는지 먼저 본다 (G-S5.13). 고정이 맞는데 실패하면 OmniRoute 쪽 외부 의존(가격 동기화 등)을 의심하고 `PRICING_SYNC_ENABLED=false`로 계약 환경을 격리한다.
- **일정 부족**: 단계를 건너뛰지 않는다. 이 문서에는 면제 가능한 단계가 없다. 범위를 줄이려면 계획서를 개정하고 이 문서에서 해당 작업을 `(폐기)`로 표시한다.
- **사용자 OmniRoute(`localhost:20128`)와 충돌**: 모든 확인·계약 테스트는 별도 인스턴스(호스트 포트 20140 등)에서 돈다. 20128을 쓰는 검사가 보이면 그 검사가 잘못된 것이다.

## 실측하지 않은 동작에 기댄 TC 목록

저장소가 비어 있어 코드 근거가 없는 대신, 아래는 0단계에서도 실측하지 않은 동작을 단언한다. S1 또는 해당 작업에서 처음 확인된다.

| TC | 기대는 동작 | 처음 확인되는 곳 |
|---|---|---|
| TC-S1.T1.a·b | 접근 토큰 범위별 관리 API 권한 | S1.T1 |
| TC-S1.T2.a | 키 끄기 즉시 반영 | S1.T2 |
| TC-S1.T6.b | Drizzle 어댑터에서 `resolveUser` 트랜잭션 롤백 (MySQL·Postgres) | S1.T6 |
| TC-S1.T7.a | Workers에서 MySQL 드라이버 동작 | S1.T7 |
| TC-S3.T1.b | 미인증 로그인 거부 응답이 403 `EMAIL_NOT_VERIFIED` | S3.T1 |
| TC-S5.T3.b | 접근 토큰 목록에서 범위를 읽을 수 있음 | S1.T1 |
| TC-S6.T4.d·e·f | `wrangler dev` + Hyperdrive 로컬 연결로 E2E 가능 | S1.T7 |
