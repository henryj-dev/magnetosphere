# Magnetosphere 2단계 "키·한도" — 실행 목록

계획은 [`../design/omniroute-member-layer.md`](../design/omniroute-member-layer.md) (v5.5) 다. 이 문서는 그 9장 2단계의 순서 · 통과 조건 · 잠금만 적는다. 논거는 계획서 절 번호로 가리킨다.

## 0. 체계

이 절의 정의가 이 문서의 유일한 규칙이다. 여기 없는 표기는 본문에 쓰지 않는다.

**단계와 ID**
- 단계는 `K0`~`K6`. 계획서 9장 "2단계" 하나를 이 문서 안에서 일곱으로 나눈 것이다. 계획서의 단계 번호(0~8)와 섞지 않는다.
- 작업 ID는 `K<n>.T<m>`. 문서가 바뀌어도 같은 작업을 가리킨다. 번호는 재사용하지 않고, 지운 작업은 `(폐기)`로 남긴다.
- 검사 ID는 `G-K<n>.<k>`, 테스트케이스 ID는 `TC-K<n>.T<m>.<소문자>`.
- 계획서 8장 확인 항목은 `V<번호>`로 부른다 (예: `V12`).
- 계획서가 정하지 않아 이 단계가 막히는 빈칸은 설계 공백 `Q<번호>`로 부른다. 공백은 계획서를 개정해서만 닫는다 (K0.T12).
- 1단계 실행판([`phase1-todo.md`](phase1-todo.md))의 ID(`S<n>`, `G-S…`, `TC-S…`)는 그 문서의 것을 그대로 가리킨다. 이 문서는 그 ID 를 새로 정의하지 않는다.

**상태 표기**
- 작업: ☐ 미착수 · ◐ 진행 · ☑ 완료
- 단계: 🔒 잠김 · 🔓 열림 · ✅ 봉인 · ⚠ 무효 · ➖ 면제 봉인
- 🔒 단계의 작업은 시작하지 않는다. 🔓은 선행 단계가 모두 ✅(또는 ➖)일 때만 된다. 판정은 `node scripts/gate.mjs --status`가 한다.

**작업 하나의 모양**
- 머리: `선행` (작업 ID) · `산출` (경로) · `되돌리기` (커밋 단위) · `장치 요구` (행동 변경이면 `Red:` 커밋, 아래)
- 본문: 【작업】 번호마다 커밋 하나 · 【테스트】 TC 목록 · 【통과】 기계 판정 체크박스
- 사람이 판단할 일(설계 선택, 계획서 문장, 저장소 설정)은 【작업】에만 적고 【통과】에는 그 결과를 기계가 읽는 검사만 둔다.
- `(사용자/메인 세션)` 표시가 붙은 작업 번호는 이 저장소 밖의 설정이라 작업자 에이전트가 할 수 없다. 그 결과는 검사가 확인한다.

**테스트케이스 규칙**
- 세 줄: 이름 · `단언:` (입력 → 기계로 확인하는 결과) · `검출:` (이 TC가 없으면 놓치는 구체적 결함과 그 결과)
- 검출줄을 못 쓰면 TC를 쓰지 않는다. 검출줄에는 코드의 사실(함수 이름, 상태코드, 예외 종류, 상수)을 쓴다.
- `(V<n> 의존)`·`(Q<n> 의존)`: 단언의 값이 확인 항목 `V<n>`의 결과 또는 설계 공백 `Q<n>`의 결정(계획서 v5.6)으로 정해지는 TC. 그 결과·결정이 바뀌면 TC 단언도 같이 바뀐다. 목록은 문서 끝 「확인 결과에 기댄 TC 목록」.
- `(코드 미확인)`: 기대는 코드가 아직 저장소에 없어 열어 보지 못한 TC. 목록은 문서 끝 「코드 미확인 TC 목록」.

**GATE와 봉인 (장치가 실제로 강제하는 제약)**
- 장치: `node scripts/gate.mjs`. 검사 정의는 `gates/gates.config.mjs`의 데이터다 (1단계와 같은 파일, 2단계 단계는 `K0`부터 이어 붙였다). 봉인 파일은 `gates/seals/K<n>.json`이고 커밋한다.
- 명령: `gate <단계>` 실행 · `--seal` 봉인 · `--explain` 실패 측정값 · `--seal --waived "<사유>"` 면제 · `--status` 상태 표 · `--assert-order` 순서 위반 검사 · `--verify-seals --rerun` 봉인 커밋 재검 · `--skip-requires <태그>`·`--skip-ids <id,…>` 건너뛰기(건너뛴 실행으로는 봉인 안 됨).
- 규칙 R1 순서: 선행 봉인이 없으면 그 단계 검사 실행을 거부한다. R2 최신성: 봉인의 `head`가 기준 브랜치(`origin/main`, 없으면 `main`)의 조상이 아니면 ⚠ 무효다. R3 재검: `--seal`은 이전 결과를 읽지 않고 검사를 다시 돌린다.
- 검사가 하나도 없는 단계는 실행·봉인을 거부한다. `K1`~`K6`의 검사는 그 단계를 시작할 때 이 문서 GATE 표대로 `gates.config.mjs`에 채운다.
- `--assert-order`는 기준 시점에 잠겨 있던 단계의 `needs`·`outputs`·`waivable` 변경, 단계 삭제, 잠긴 단계 `outputs`에 걸리는 파일 변경을 거부한다. pre-push 훅(`.githooks/pre-push`)과 CI(`gate.yml`, `ci.yml`의 `order` 잡)가 이것을 돈다. 그래서 2단계 단계의 `outputs`는 **그 단계가 새로 만드는, 이력에서 한 번도 바뀐 적 없는 경로만** 둔다. 이유 둘: (1) 앞 단계가 고칠 파일을 뒤 단계 `outputs`에 넣으면 앞 단계 작업이 막힌다. (2) `--assert-order`를 처음 커밋부터 도는 검사(ci.yml `order` 잡, 1단계 `G-S7.5`, 새 브랜치 첫 push 의 `gate.yml`)는 **지금 설정**의 잠긴 단계 `outputs`로 이력 전체를 본다. 1단계가 고친 파일(`packages/runtime/src/lease.ts`, `packages/db/src/schema/**`, `packages/db/migrations/**`, `packages/omniroute/src/**` 등)을 잠긴 2단계 단계 `outputs`에 넣으면 그 단계가 열릴 때까지 CI 가 빨갛다 (이 문서의 첫 push 에서 실제로 그랬다). 2단계가 고칠 기존 파일은 어느 단계 `outputs`에도 넣지 않고, 순서는 선행 봉인(R1)이 지킨다.
- `test` 검사 판정: 종료코드 0 이고, 검사에 `expectPassed`가 있으면 통과한 테스트 수가 **그 수와 같아야** 한다 (K0.T1 이후). 2단계 단계는 `strictTests: true`라 `expectPassed`가 없는 `test` 검사는 실패다. GATE 표의 `통과 = n`은 `expectPassed: n`이다. `TC 수 × DB 수`로 적은 것은 TC 하나가 DB마다 테스트 하나씩 도는 경우다.
- `[L]`이 붙은 명령은 `requires: ["local-services"]` 검사다. 이 컴퓨터에 띄운 계약 환경 OmniRoute(`127.0.0.1:20170`, `pnpm test:contract`가 멱등 기동), 시험 DB(MySQL `33306`·MariaDB `33307`·Postgres `35432`), mailpit 이 필요하다. CI 봉인 재검(`gate.yml`)은 이 검사를 건너뛰고, CI 단계 잡이 서비스를 띄워 그대로 돈다. `localhost:20128`(사람이 쓰는 OmniRoute)은 어떤 검사도 쓰지 않는다.
- 1단계 `G-S5.9`(CI `contract` 잡이 매 push 돈다)는 `apps`·`packages`(어댑터 `packages/omniroute` 제외)에서 문자열 `/api/keys`·`/api/usage`가 0 이기를 요구한다. 그래서 회원 키 API 경로는 `/api/me/keys`이고, 시험 코드의 OmniRoute 호출 기록은 경로가 아니라 어댑터 함수 이름(`createKey`, `setKeyActive(false)`, `setBudget`, `deleteKey` 등)으로 적는다. 대시보드 쿠키로 OmniRoute 상태를 바꾸는 시험도 어댑터(`createClient({ credential: { cookie } })`)를 거친다.
- 병합은 **머지 커밋만**. 스쿼시·리베이스는 SHA 를 바꿔 봉인의 `head`가 main 의 조상이 아니게 되고(R2), 그 단계와 뒤 단계 봉인이 모두 ⚠ 가 된다.

**CI 단계 잡 규칙 (장치가 실제로 강제하는 제약)**
- 단계 봉인 파일을 커밋하는 순간부터 `.github/workflows/ci.yml`에 그 단계 게이트를 도는 잡이 있어야 한다. `scripts/check-ci-matrix.mjs`(1단계 `G-S7.1`, CI `guard` 잡)가 봉인 파일이 있는 단계마다 `node scripts/gate.mjs <단계>` 명령 줄을 요구한다 (K0.T2). 명령 줄은 run 줄의 시작에 있고, `--skip-requires`를 쓰지 않으며, `--skip-ids`는 매트릭스가 대신 도는 E2E 검사만, 잡·스텝에 `if`·`continue-on-error`·실패를 삼키는 셸 표현이 없다.
- 그래서 단계 봉인 커밋과 같은 PR 에 그 단계 잡을 넣는다. GATE 마다 "CI 단계 잡" grep 검사가 봉인 전에 잡의 존재를 본다.
- 새 잡 이름은 main ruleset 의 필수 검사 목록에도 넣는다 `(사용자/메인 세션)`. `scripts/check-required-checks.mjs`(K0.T13)가 ruleset 필수 검사 ⊇ CI 잡 이름, 병합 방식 = 머지 커밋만 을 확인한다.

**재현 빨강 (행동 변경 작업)**
- 행동을 바꾸는 작업은 커밋 두 개로 한다: (1) 재현 테스트만 넣은 커밋, 메시지에 꼬리줄 `Red: <TC ID>` (2) 고침.
- `node scripts/check-red.mjs --check <검사 ID> --since seal:<선행 단계>`(K0.T14)가 그 범위에서 `Red: <TC>` 커밋을 찾아 그 커밋 작업 트리에서 검사 명령을 돌리고 **실패**해야 통과다. Red 커밋이 없거나 그 커밋에서 초록이면 실패다.
- 순수 추가(새 모듈·새 API)는 부모 트리에 대상이 없어 재현 빨강을 요구하지 않는다. 기존 코드의 동작을 바꾸는 작업만 `장치 요구` 칸에 `Red:`를 적는다.

**문서 표기**
- `# K<n> — <제목> <단계 상태> (<선행> 필요)`: 단계 머리. `**outputs**` 줄은 `gates.config.mjs`의 그 단계 `outputs` 요약이다.
- `## 🚪 GATE K<n>`: 그 단계 검사 표. 열은 `id · 검사 · 명령 · 통과 기준`. `G-K<n>.a ~ b`처럼 묶은 줄은 같은 명령을 TC 마다 따로 정의한 검사들이다.

**확인 결과 파일 (`K0` 전용)**
- `docs/verify/V<번호>.json`: `{ "item", "question", "answer", "evidence", "blocking", "was_blocking", "resolved_in" }`. 형식은 `scripts/check-verify.mjs`가 검사한다. `was_blocking`은 처음 확인했을 때 설계를 막았는지를 남긴다.
- `blocking: true`면 계획서를 고쳐야 한다는 뜻이다. 계획서를 개정하고 `resolved_in`에 개정 버전을 적은 뒤 `blocking: false`로 바꾼다. `G-K0.14`가 `blocking == false`를, `G-K0.15`가 `resolved_in == 계획서 현재 버전`을 요구하므로 설계를 막는 결과가 남아 있으면 `K1` 이후가 열리지 않는다.
- 확인 결과가 계획서와 달라 뒤 단계의 작업을 바꿔야 하면, 계획서 개정 → 이 문서의 해당 작업을 `(폐기)` + 새 작업 번호로 개정 → `gates.config.mjs`의 그 단계 `checks`만 고친다. 잠긴 단계의 `needs`·`outputs`·`waivable`은 `--assert-order`가 막으므로, `outputs`는 처음부터 어느 결과든 덮게 잡아 두었다 (각 단계 머리에 적음).

**면제**
- 2단계 단계는 모두 `waivable: false`다. 계획서 9장 2단계 완료 기준이 모든 단계의 산출을 지나가기 때문이다. 범위를 줄이려면 계획서를 개정하고 해당 작업을 `(폐기)`로 표시한다.

## 진행 현황

이 표는 사람이 읽기 위한 사본이다. 판정은 항상 `node scripts/gate.mjs --status`가 한다 (1단계 `S0`~`S7`은 모두 ✅).

| 단계 | 제목 | 상태 | 게이트 명령 | 봉인 |
|---|---|---|---|---|
| K0 | 장치 확장과 확인 항목 6개 | 🔓 | `node scripts/gate.mjs K0` | — |
| K1 | 작업 기반: 임대·작업 큐·주기 등록 | 🔒 | `node scripts/gate.mjs K1` | — |
| K2 | 회원 단위 한도 분배 | 🔒 | `node scripts/gate.mjs K2` | — |
| K3 | 키 목표 상태·반영·정합성 점검 | 🔒 | `node scripts/gate.mjs K3` | — |
| K4 | 키 수명주기와 회원 키 API | 🔒 | `node scripts/gate.mjs K4` | — |
| K5 | 2단계 완료 기준 E2E | 🔒 | `node scripts/gate.mjs K5` | — |
| K6 | 재발 방지와 잔재 회수 | 🔒 | `node scripts/gate.mjs K6` | — |

## 선행 관계

```
S7 ─▶ K0 ─▶ K1 ─▶ K2 ─▶ K3 ─▶ K4 ─▶ K5 ─▶ K6
```
- 전부 직렬이다. 동시 진행 상한 1.
- K1 이 K0 을 기다리는 이유: 확인 결과(V12·V15·V18·V19·V20)와 계획서 개정(Q1~Q6)이 작업 큐 재시도·분배 방식·키 매핑을 정한다.
- K3 가 K2 를 기다리는 이유: 키를 켜는 반영(5.7)은 켜기 직전에 예산을 다시 계산한다 (발급 순서 5.2 의 "끄기 → 예산 → 켜기"와 같은 규칙).
- K4 가 K3 을 기다리는 이유: 회원 키 API 의 끄기·켜기·삭제가 K3 의 반영 함수를 부르고, 발급이 K2 의 계산을 부른다.

## 2단계 범위 판단

| 계획서 | 이 문서에서 | 근거 |
|---|---|---|
| 5.2 키 수명주기, 5.3 분배, 5.7 목표 상태, 5.8 범위 감지, 5.9 `api_keys`·`omniroute_jobs`·`job_leases`, 3.2 작업 실행 | 함 (K1~K4) | 9장 2단계 내용 |
| 5.4 사용량 조회 중 한도 계산에 쓰는 분석 호출 | 함 (K2) | 5.3 계산식이 `analytics(...).totalCost` |
| 회원 키 관리 **API** (발급·목록·이름·끄기·켜기·재발급·삭제) | 함 (K4) | 완료 기준 "Claude Code가 발급 키로 동작"에 발급 경로가 필요하다 |
| 관리자 한도·최대 개수 변경 **API** | 함 (K4) | 5.3 "관리자가 한도를 바꾼 직후" 분배, 5.2 "줄였을 때 새 발급만 막는다" |
| 키 관리 **화면** (6장) | 옮김 → 4단계 | 9장 2단계에 화면이 없다. 6장 키 관리 화면의 "키별 이번 달 사용량"은 4단계 사용량 화면과 같은 데이터다 |
| 회원 관리 화면, 알림·실패 작업 화면 | 옮김 → 7단계 | 9장 7단계 "관리 화면". 2단계는 기록(`audit_log`)과 API 까지 |
| 5.4 응답 60초 캐시 | 옮김 → 4단계 | 사용량 화면 응답 캐시다. 분배 작업은 캐시를 쓰지 않는다 (분배가 캐시를 쓰면 한도 반영이 60초 더 늦는다) |
| 새 회원 기본 월 한도 $5 적용 | 옮김 → 3단계 (2단계는 시드값 회귀 검사 G-K4.24) | 5.9: `monthly_limit_usd` NULL 은 무제한. $5 는 가입·초대 때 넣는 값이다 (4.2, 3단계 가입 정책) |
| 정지·탈퇴 API | 옮김 → 3단계 | 9장 3단계 "정지". 2단계는 회원 상태를 DB 에서 바꾼 뒤 반영·정합성 점검이 맞추는 것까지 (K3) |

## 1단계에서 넘어온 백로그

| 항목 | 결정 | 자리·이유 |
|---|---|---|
| gate `test` 판정 "통과 ≥ 1" (S7.T3 백로그 `expectPassed`) | 함 | K0.T1. 2단계는 `-t` 하나가 DB 넷에 걸리는 검사가 많아, 하나가 꺼져도 초록이 되는 구멍이 커진다 |
| `job_leases` 하트비트·펜싱 토큰 (S4 보안 리뷰 L4) | 함 | K1.T2. 1단계 결정 "주기 작업이 생기는 단계에서 작업 길이를 보고 정한다"의 그 단계가 여기다. Node `schedule()`은 임대를 `period − 5_000`ms(1분 작업이면 55초) 한 번 잡고 늘리지 않는다 |
| TC-S3.T2.e 상한 250ms → 150ms (S7 리뷰 L1) | 옮김 → 3단계 | 가입·메일 응답 시간 시험이다. 아래 "가입 응답 DB 쓰기 시간"과 같은 측정 도구로 함께 정한다 |
| `ci.yml` concurrency 가 main 에서 앞 실행을 취소 (S7 리뷰 L5) | 함 | K0.T3. 1단계 결정 "필수 검사 지정과 함께"의 조건이 이제 섰다 (ruleset 필수 검사 16개 지정됨) |
| 가입 응답의 DB 쓰기 시간으로 계정 존재 노출 | 옮김 → 3단계 | 가입 정책·초대·승인을 3단계가 고친다. 응답 시간을 맞추는 일은 그 가입 경로 위에서 한다 |
| OmniRoute `3.8.51@sha256:8bd462c9…` amd64·arm64 빌드 차이 | 일부 함, 나머지 옮김 → 8단계 | 함: K0.T11. 2단계 시험은 예산 차단을 "상태 429 + 예산 사유"로만 판정하는 도우미 하나를 쓰고, 계약 시험이 로컬(arm64)·CI(amd64) 둘 다에서 돈다. 회원 앱 코드는 차단 code 를 읽지 않는다 (차단은 OmniRoute 가 회원 도구에 직접 낸다). 옮김: 아키텍처별 digest 고정 여부는 공개 준비(8단계)에서 정한다 |
| 계약 테스트 TC-S5.T3 시험 토큰 회수 | 옮김 → 2차 (그대로) | CI 는 잡마다 계약 환경을 새로 띄운다 |
| OmniRoute 토큰 붙여 넣기 화면 | 옮김 → 7단계 | 6장 "설정 → 연결" 화면이다. API 는 1단계에 있다 |
| OmniRoute 접근 토큰 갱신 | 옮김 → 7단계 | 교체 흐름을 설정 → 연결 화면과 함께 설계한다 |

---

# K0 — 장치 확장과 확인 항목 6개 🔓 (S7 필요)

**브랜치** `p2/k0`. 이 문서를 넣은 `p2/plan` 이 K0.T2 를 먼저 했다 (CI 를 초록으로 두려면 필요했다).
**outputs** 장치 스크립트·음성 대조, `docs/verify/V12·13·15·18·19·20.json`, `packages/omniroute/test/contract/verify/**`, `tests/bench/**`, 예산 차단 도우미. 확인 결과가 어떻든 이 경로 밖으로 나가지 않는다.

### ☐ K0.T1 — gate `test` 판정에 `expectPassed`
선행 없음 · 산출 `scripts/gate.mjs`, `scripts/gate.test.mjs` · 되돌리기 커밋 2개 · 장치 요구 `Red: TC-K0.T1.a`

【작업】
1. `scripts/gate.test.mjs`에 TC-K0.T1.a~d 를 넣는다. 꼬리줄 `Red: TC-K0.T1.a`. 커밋.
2. `CHECKS.test`: `c.expectPassed`가 있으면 `passed === c.expectPassed`, 없으면 지금처럼 `≥ 1`. `passedCount`는 vitest 요약 `Tests N passed`를 **모두 더한다** (지금은 첫 줄 하나만 읽는다. `pnpm test:contract`는 묶음 둘을, `&&`로 이은 명령은 vitest 를 두 번 돈다). 단계에 `strictTests: true`면 `expectPassed`가 없는 `test` 검사를 `measured: "expectPassed 없음"`으로 실패시킨다. 측정값은 `통과 n / 기대 m`으로 낸다. 커밋.

【테스트】
```
TC-K0.T1.a  통과 수가 expectPassed 와 다르면 실패한다
  단언:  임시 저장소, expectPassed 2 · 테스트 둘 중 하나 { skip: true } → FAIL "통과 1 / 기대 2". 테스트 셋 → FAIL. 둘 → PASS
  검출:  -t "TC-K4.T1" 처럼 여러 TC 에 걸린 검사에서 하나가 skip·이름 변경으로 빠져도 passed >= 1 이라 초록인 것
TC-K0.T1.b  여러 vitest 요약을 합산한다
  단언:  출력에 "Tests  2 passed" 와 "Tests  3 passed" 두 줄을 내는 명령 + expectPassed 5 → PASS, measured "통과 5". expectPassed 2 → FAIL
  검출:  passedCount 의 output.match(/Tests\s+(\d+) passed/) 가 첫 묶음 수만 읽어, 두 번째 묶음(apps/server 계약)이 통째로 빠져도 같은 값인 것
TC-K0.T1.c  strictTests 단계의 expectPassed 없는 test 검사는 실패한다
  단언:  strictTests: true 단계에 expectPassed 없는 test 검사 하나(통과 1) → FAIL "expectPassed 없음", --seal 봉인 파일 없음
  검출:  2단계 검사를 추가하면서 expectPassed 를 빠뜨려 그 검사만 옛 판정(≥ 1)으로 도는 것
TC-K0.T1.d  expectPassed 없는 1단계 검사는 통과 ≥ 1 그대로다
  단언:  strictTests 없는 단계, expectPassed 없는 test 검사(통과 3) → PASS
  검출:  판정을 바꾸며 1단계 검사 정의가 모두 실패로 바뀌어 S0~S7 봉인 재검(gate --verify-seals --rerun, gate.yml)이 깨지는 것
```

【통과】
- [ ] G-K0.6 ~ G-K0.9 통과
- [ ] G-K0.35 통과 (Red 커밋에서 TC-K0.T1.a 실패)

### ☑ K0.T2 — CI 는 봉인된 단계만 단계 잡을 요구한다
선행 없음 · 산출 `scripts/check-ci-matrix.mjs`(`--seal-dir`), `test/check-ci-matrix.test.mjs` · 되돌리기 커밋 1개 (`p2/plan`)

【작업】
1. `check-ci-matrix.mjs`의 단계 목록을 "설정의 모든 단계"에서 "봉인 파일이 있고 면제 봉인이 아닌 단계"로 바꾼다. 봉인 폴더는 `--seal-dir`(기본 `gates/seals`). 음성 대조는 `scripts/*.test.mjs`가 아니라 `test/`에 둔다 (`check-ci-matrix`는 `yaml` 패키지가 필요한데 `gate.yml`의 스크립트 테스트는 설치 없이 돈다). 커밋.
   (실제: `p2/plan` 에서 했다. 2단계 단계 K0~K6 을 설정에 넣자 옛 규칙이 `[stage-missing] K0`~`K6` 7개로 G-S7.1 을 깨뜨렸다 — 부모 트리 빨강을 손으로 확인했다. 재현 빨강 장치(K0.T14)보다 먼저 들어가 `Red:` 커밋이 없다.)

【테스트】
```
TC-K0.T2.a  봉인하지 않은 단계의 잡은 요구하지 않는다
  단언:  ci.yml 에서 2단계(strictTests) 단계 명령 줄을 모두 지운 사본 + 2단계 봉인을 뺀 봉인 폴더 → 종료코드 0, "[stage-missing]" 없음
  검출:  아직 빨강인 단계(검사가 빈 K1~K6 은 gate 가 "검사 정의가 없다"로 거부)의 잡을 CI 에 미리 넣어야 해 main 이 늘 빨강인 것
TC-K0.T2.b  봉인 파일이 생긴 단계의 잡이 없으면 실패한다
  단언:  2단계 단계 P 마다: 같은 사본 + P.json(waived false) → 종료코드 ≠ 0, "[stage-missing] P:". P.json(waived true) → 0
  검출:  봉인한 단계의 게이트가 CI 에서 조용히 빠져, 뒤 단계가 그 단계 산출을 깨도 아무 잡도 빨개지지 않는 것
```

【통과】
- [x] G-K0.10 통과
- [x] G-S7.1 통과 (2단계 단계를 넣은 설정으로)

### ☐ K0.T3 — main 에서 앞 CI 실행을 취소하지 않는다 (S7 리뷰 L5)
선행 K0.T2 · 산출 `.github/workflows/ci.yml`, `scripts/check-ci-matrix.mjs`, `test/fixtures/ci-guard/concurrency-cancel-main.yml` · 되돌리기 커밋 2개 · 장치 요구 `Red: TC-K0.T3.a`

【작업】
1. 픽스처 `test/fixtures/ci-guard/concurrency-cancel-main.yml`(머리 `# expect: concurrency`, `cancel-in-progress: true`)을 넣는다. 꼬리줄 `Red: TC-K0.T3.a`. 커밋. (이 커밋에서 `G-K0.11`이 실패한다. `G-S7.1`의 `--fixture-dir ci-guard`도 실패하므로 이 커밋은 브랜치 중간에만 둔다.)
2. `check-ci-matrix.mjs` 위생 규칙 `[concurrency]`: 최상위 `concurrency.cancel-in-progress`가 `true`면 실패, 식이면 `refs/heads/main`이 들어 있어야 한다. `ci.yml`을 `cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}`로 바꾼다. 커밋.

【테스트】
```
TC-K0.T3.a  main 에서도 앞 실행을 취소하는 concurrency 를 잡는다
  단언:  check-ci-matrix --fixture test/fixtures/ci-guard/concurrency-cancel-main.yml --expect 6 --expect-fail → 종료코드 0 ([concurrency] 잡음)
  검출:  main 에 커밋 둘이 연달아 들어갈 때 앞 커밋의 CI 결과가 취소돼, 봉인 커밋(앞 커밋)의 단계 게이트 결과가 남지 않는 것
TC-K0.T3.b  실제 ci.yml 은 main 에서 취소하지 않는다
  단언:  check-ci-matrix --expect 6 → 종료코드 0 (ci.yml 의 cancel-in-progress 가 refs/heads/main 을 뺀 식)
  검출:  규칙만 넣고 ci.yml 을 그대로 둬 G-S7.1 이 빨개지거나, 반대로 규칙 없이 고쳐 다음 변경에서 되돌아가는 것
```

【통과】
- [ ] G-K0.11 통과
- [ ] G-K0.36 통과 (Red 커밋에서 G-K0.11 실패)

### ☐ K0.T4 — 확인 결과 검사기에 2단계 항목 묶음
선행 없음 · 산출 `scripts/check-verify.mjs`, `scripts/check-verify.test.mjs` · 되돌리기 커밋 1개

【작업】
1. `check-verify.mjs`에 `--set phase1|phase2`를 둔다. `phase1` = `V10 V11 V16 V17 V21 V26 V27`(기본값, 지금 고정 목록), `phase2` = `V12 V13 V15 V18 V19 V20`. 모드 셋(`present`·`unblocked`·`resolved`)은 그대로. 커밋.

【테스트】
```
TC-K0.T4.a  phase2 정상 파일 여섯은 세 모드 모두 통과한다
  단언:  임시 폴더, 여섯 항목 정상 → present·unblocked·resolved --set phase2 모두 0
  검출:  묶음 이름을 잘못 읽어 phase2 가 빈 목록이 되고 "0개 항목 통과"로 늘 초록인 것
TC-K0.T4.b  present 는 빠진 항목과 모양 오류를 잡는다
  단언:  V19 없음 / V12 evidence [] / V13 item "V12" / V15 blocking true·was_blocking false → 각각 ≠ 0
  검출:  확인 하나(예: V19 regenerate)를 안 하고 K1 을 여는 것
TC-K0.T4.c  unblocked 는 설계를 막는 결과가 남아 있으면 실패한다
  단언:  V12 blocking true·was_blocking true → unblocked --set phase2 ≠ 0
  검출:  키 그룹 공동 예산이 있다는 결과(V12)를 두고도 분배 작업(K2)을 그대로 만드는 것
TC-K0.T4.d  resolved 는 막았던 항목이 현재 계획서 버전을 가리켜야 통과한다
  단언:  V20 was_blocking true · resolved_in null → ≠ 0, "v5.5" (옛 버전) → ≠ 0, 계획서 상태 줄과 같은 버전 → 0
  검출:  blocking 만 false 로 내리고 계획서를 고치지 않는 것
TC-K0.T4.e  --set 없이 부르면 1단계 일곱 항목을 본다
  단언:  1단계 일곱 파일만 있는 폴더 → present (인자 없음) 0, present --set phase2 ≠ 0
  검출:  기본 묶음을 바꿔 S1 봉인 커밋 재검(gate --verify-seals --rerun, ci.yml s1-seal)의 G-S1.14~16 이 깨지는 것
```

【통과】
- [ ] G-K0.12 통과
- [ ] `node --test --test-reporter=tap scripts/check-verify.test.mjs` 종료코드 0 (TC-S1.G.a~d 포함, G-K0.33)

### ☐ K0.T5 — V12 키 그룹·쿼터 풀 공동 예산
선행 K0.T4 · 산출 `docs/verify/V12.json`, `packages/omniroute/test/contract/verify/v12.contract.ts` · 되돌리기 커밋 1개

【작업】
1. OmniRoute 3.8.51 이미지 안의 OpenAPI 와 소스에서 키 묶음(그룹·풀·combo 예산 등) 경로를 찾는다. 있으면 계약 환경에서 키 둘을 한 묶음에 넣고 공동 예산을 걸어 본다. `V12.json`: `answer = { exists: bool, mechanism, api, sharedBlocking: bool|null }`. 커밋.
2. 결과가 `exists: true` 이고 둘 이상의 키 지출을 합쳐 막으면 `blocking: true`. 계획서 5.3 을 공동 예산 방식으로 개정(K0.T12 의 같은 개정 버전)하고, 이 문서의 K2 작업을 `(폐기)` + 새 번호로 개정한다. K2 `outputs`(`apps/server/src/limits/**` 등 새 경로)는 두 방식 모두를 덮는다. 결과가 `false`면 5.3 그대로 간다. 두 갈래를 미리 적지 않는다.

【테스트】
```
TC-K0.T5.a  V12 관찰이 V12.json answer 와 같다 (V12 의존)
  단언:  계약 환경에서 answer.api 경로 존재 여부와 sharedBlocking 재현 == V12.json (exists false 면 후보 경로가 404·405)
  검출:  OmniRoute 버전을 올려 공동 예산이 생기거나 없어졌는데 5.3 분배 방식이 그대로 남는 것
```

【통과】
- [ ] G-K0.16 통과
- [ ] G-K0.13 · G-K0.14 · G-K0.15 통과 (V12 포함)

### ☐ K0.T6 — V13 call-logs 를 키로 거르는 쿼리
선행 K0.T4 · 산출 `docs/verify/V13.json`, `packages/omniroute/test/contract/verify/v13.contract.ts` · 되돌리기 커밋 1개

【작업】
1. 키 둘로 요청을 보내고 `GET /api/usage/call-logs`에 후보 파라미터(`apiKeyId`, `apiKeyIds`, `keyId` 등)를 붙여 본다. `answer = { param: string|null, filtersExactly: bool, completedOnly: bool }`. 거르는 파라미터가 없으면 4단계 "최근 요청"이 어댑터에서 거른다는 뜻이라 `blocking: false`로 둔다 (2단계 범위를 막지 않는다). 커밋.

【테스트】
```
TC-K0.T6.a  V13 관찰이 V13.json answer 와 같다 (V13 의존)
  단언:  키 A 요청 2건·키 B 요청 1건 뒤 answer.param=A → 완료 기록 apiKeyId 가 모두 A, 2건 (param null 이면 거르지 않음을 재현)
  검출:  거르기 파라미터를 믿고 4단계가 다른 회원의 최근 요청을 보여 주는 것 — 파라미터를 모르는 값으로 무시하는 OmniRoute 는 전체 목록을 돌려준다
```

【통과】
- [ ] G-K0.17 통과

### ☐ K0.T7 — V15 분석 API 성능 (5.3 이 1분마다 부른다)
선행 K0.T4 · 산출 `docs/verify/V15.json`, `tests/bench/analytics.mjs`, `tests/bench/docker-compose.yml` · 되돌리기 커밋 1개

【작업】
1. 측정용 OmniRoute 를 계약 환경과 따로 띄운다 (`127.0.0.1:20171`, 같은 digest, 데이터 볼륨 없음. 계약 환경의 분석 합계를 오염시키지 않으려고). 키 300개, 완료 기록 300,000건(계획서 "수십만 건, 키 수백 개"의 아래 끝을 고정값으로)을 넣는다. 넣는 방법(요청 / OmniRoute DB 직접 삽입)은 작업에서 정하고 `evidence`에 적되, 넣은 뒤 `analytics` 전체 `totalRequests == 300000`으로 확인한다. 측정 뒤 내린다 (Docker 메모리 4GB).
2. 두 호출을 각각 10번 잰다: 전체 키 한 달(필터 없음, `byApiKey`로 회원 묶음) · 회원 하나(키 2개, 그중 삭제 1개). `answer = { dataset: { records, keys }, fullMonth: { p95Ms, runs }, member: { p95Ms, runs }, arch, decision }`. `decision`은 분배가 쓸 호출 방식(전체 한 번 / 회원마다)이다. 기준을 넘으면 `blocking: true` 로 두고 계획서 5.3 실행 시점을 개정한다. 커밋.
   기준의 근거: 1분 작업의 임대는 55초(`period − 5_000`)이고 지출 기록이 60초 주기다. 전체 호출 p95 5,000ms 는 주기의 1/12 로, 분배 한 번이 예산 쓰기 300번을 더해도 임대 안에 끝난다.

【테스트】
```
TC-K0.T7.a  측정이 재현된다 (V15 의존)
  단언:  node tests/bench/analytics.mjs --assert → 넣은 기록 300,000·키 300 확인, 전체 p95 ≤ 5,000ms, 회원 p95 ≤ 1,000ms, 10회씩. 종료코드 0
  검출:  분석 API 가 기록 수에 비례해 느려져 1분 분배가 다음 경계까지 안 끝나고, 두 인스턴스가 같은 회원 예산을 엇갈려 쓰는 것
```

【통과】
- [ ] G-K0.18 ~ G-K0.23 통과

### ☐ K0.T8 — V18 삭제한 키의 기록이 분석에 남는가
선행 K0.T4 · 산출 `docs/verify/V18.json`, `packages/omniroute/test/contract/verify/v18.contract.ts` · 되돌리기 커밋 1개

【작업】
1. 키 생성 → 요청 3건(합계 0.014633, TC-S5.T2.e 와 같은 요청) → `DELETE /api/keys/{id}` → `analytics(apiKeyIds=[그 id])`와 필터 없는 `byApiKey`. `answer = { deletedKeyCounted: bool, byApiKeyIncludesDeleted: bool, totalCost }`. `deletedKeyCounted: false`면 5.3 "삭제·재발급으로 한도가 초기화되지 않음"의 전제가 무너지므로 `blocking: true`다 (계획서가 대안을 정해야 한다 — 예: 삭제 전 사용액을 우리 DB 에 남기는 칼럼). 커밋.

【테스트】
```
TC-K0.T8.a  삭제한 키의 비용이 그 키 id 분석에 그대로 잡힌다 (V18 의존)
  단언:  위 순서 뒤 getAnalytics(apiKeyIds=[삭제한 id]).totalCost == V18 answer.totalCost (0.014633, 오차 1e-9), 필터 없는 byApiKey 에 그 id 있음 == answer
  검출:  OmniRoute 가 키 삭제 때 기록을 지우거나 apiKeyId 를 비우면 회원이 키를 지우고 다시 받아 한도를 매번 새로 받는 것
```

【통과】
- [ ] G-K0.24 통과

### ☐ K0.T9 — V19 `regenerate`의 id·누적 지출·예산
선행 K0.T4 · 산출 `docs/verify/V19.json`, `packages/omniroute/test/contract/verify/v19.contract.ts` · 되돌리기 커밋 1개

【작업】
1. 키 생성 → 월 예산 0.01 → 요청 3건 → 429 확인 → `POST /api/keys/{id}/regenerate`. `answer = { sameId, spendKept, budgetKept, oldKeyStatus, newKeyStatus, newKeyBlocked }`. `sameId: false` 또는 `spendKept: false`면 K4 재발급이 매핑을 새 id 로 바꾸고 옛 id 사용액을 회원 합계에 계속 넣어야 하므로 `blocking: true`로 계획서 5.2·5.9 를 개정한다 (`api_keys` 칼럼 변경은 K1.T1 이 같은 마이그레이션에 넣는다). 커밋.

【테스트】
```
TC-K0.T9.a  regenerate 뒤 관찰이 V19.json answer 와 같다 (V19 의존)
  단언:  regenerate 응답 id == 원래 id 여부, 옛 원문 키 상태코드, 새 원문 키 상태코드, 새 원문 키의 다음 요청이 예산 차단(K0.T11 도우미)인지 == answer
  검출:  재발급이 새 키 id 로 누적 지출을 0 에서 시작해, 한도를 다 쓴 회원이 재발급만으로 다시 쓰는 것 (7장 회귀 시나리오)
```

【통과】
- [ ] G-K0.25 통과

### ☐ K0.T10 — V20 월 예산 시간대·초기화·달 중간 변경
선행 K0.T4 · 산출 `docs/verify/V20.json`, `packages/omniroute/test/contract/verify/v20.contract.ts` · 되돌리기 커밋 1개

【작업】
1. OmniRoute 소스(이미지 안 빌드)에서 월 예산 기간 시작 계산을 찾아 시간대와 초기화 시점을 적는다. 계약 환경에서 달 중간 변경을 잰다: 차단 뒤 예산을 올리면 다음 요청, 사용액보다 낮추면 다음 요청, 예산 == 사용액이면 다음 요청. `answer = { timezone, resetAt, raiseUnblocks, lowerBlocks, equalBlocks, zeroIsUnlimited }` (`zeroIsUnlimited`는 TC-S5.T2.j 에서 이미 true). 커밋.
2. `equalBlocks: false`면 5.3 계산식 "키별 월 예산 = 키 사용액 + 남은 한도"가 남은 한도 0 에서 키를 막지 못하므로 `blocking: true`다. `timezone`이 UTC 가 아니면 K2 달 경계가 그 시간대를 쓴다 (계획서 5.3 "매달 1일 0시(기준 시간대는 8장 확인 20번)"을 개정해 시간대를 적는다).

【테스트】
```
TC-K0.T10.a  달 중간에 예산을 올리고 내리면 다음 요청부터 바뀐다 (V20 의존)
  단언:  월 예산 0.01·요청 3건(0.014633) 뒤 429 → 예산 1.0 → 다음 요청 == answer.raiseUnblocks ? 200 : 429. 다시 0.01 → == answer.lowerBlocks ? 429 : 200
  검출:  분배가 1분마다 예산을 올려도 OmniRoute 가 이번 달 차단을 풀지 않아, 한도를 올려 준 회원이 다음 달까지 막히는 것
TC-K0.T10.b  예산 == 사용액이면 막히는가 (V20 의존)
  단언:  요청 3건 뒤 그 키 분석 비용 c 를 예산으로 → 다음 요청이 예산 차단인지 == answer.equalBlocks
  검출:  남은 한도 0 인 회원의 키 예산을 "그 키 사용액"으로 걸었는데 OmniRoute 가 '>' 로 비교해 계속 통과시키는 것
TC-K0.T10.c  기간 시작 시각이 answer.timezone 기준이다 (V20 의존, 코드 미확인)
  단언:  OmniRoute 예산 조회 응답(또는 소스에서 찾은 계산 함수를 이미지 안 node 로 부른 값)의 기간 시작 == answer.timezone 의 이번 달 1일 00:00
  검출:  회원 앱이 UTC 로 달을 자르고 OmniRoute 는 다른 시간대로 잘라 매달 첫 몇 시간 동안 예산과 사용액 기간이 어긋나는 것
```

【통과】
- [ ] G-K0.26 통과

### ☐ K0.T11 — 예산 차단 판정 도우미 (amd64·arm64)
선행 없음 · 산출 `tests/contract/budget-block.mjs`, `tests/contract/budget-block.test.mjs` · 되돌리기 커밋 1개

【작업】
1. `isBudgetBlocked(status, body)`: 429 이고 (code `BUDGET_EXCEEDED`) 또는 (code `rate_limit_exceeded` + 메시지가 `budget exceeded`를 담음, 대소문자 무시)일 때만 참. 2단계 계약·E2E 의 예산 차단 단언은 모두 이 함수를 쓴다. TC-S5.T2.d 는 고치지 않는다 (1단계 봉인 시험). 커밋.

【테스트】
```
TC-K0.T11.a  두 빌드의 예산 차단은 참, 일반 요청 수 제한은 거짓
  단언:  (429, {error:{code:"BUDGET_EXCEEDED"}}) → true, (429, {error:{code:"rate_limit_exceeded",message:"Monthly budget exceeded: $0.0146 / $0.01"}}) → true,
         (429, {error:{code:"rate_limit_exceeded",message:"Too many requests"}}) → false, (403, permission_denied) → false
  검출:  2단계 시험이 "429 면 한도 차단"으로 판정해, 분배가 고장 나도 OmniRoute 의 요청 수 제한 429 를 한도 차단으로 오인하는 것
```

【통과】
- [ ] G-K0.27 통과

### ☐ K0.T12 — 계획서 개정 v5.6 (설계 공백 Q1~Q6 과 확인 결과)
선행 K0.T5 ~ K0.T10 · 산출 `docs/design/omniroute-member-layer.md`, 이 문서 · 되돌리기 커밋 1개

설계 공백 (코드를 열어 찾은 것. 계획서가 정하지 않으면 K1~K4 의 TC 단언을 쓸 수 없다)

| ID | 공백 | 코드의 사실 |
|---|---|---|
| Q1 | 남은 한도 0 인 회원의 **사용액 0 인 키**: 5.3 식이 예산 0 을 내는데 OmniRoute 는 0 을 "무제한"으로 본다 | `createClient().setBudget`이 0 이하를 `TypeError`로 거부하고 "막으려면 setKeyActive(false)" 라고 적었다 (S5 보안 리뷰 M1, TC-S5.T2.j). 5.7 은 "한도는 키를 끄지 않고 예산으로 막는다" |
| Q2 | 재시도 10초·30초를 지킬 실행기 | `cronIntervalMinutes`는 1분보다 짧은 주기를 받지 않고 Workers Cron Trigger 도 최소 1분이다 |
| Q3 | 4번째 재시도(10분)도 실패한 뒤의 동작과 "오래 실패" 기준 | 5.7 "오래 실패한 작업은 관리자 화면에 띄운다"에 기준이 없다. `api_keys.sync_state`에 `failed`가 있다 |
| Q4 | 키 발급 요청 수 제한의 숫자 | 7장 "키 발급에 요청 수 제한"에 숫자가 없다. Better Auth `rateLimit`은 `/api/auth/*`에만 걸린다 |
| Q5 | "매달 1일 0시" 재계산의 실행 방식 | `cronIntervalMinutes("0 0 1 * *")`는 예외를 던진다. 1분 분배가 달 경계를 스스로 판단해야 한다 |
| Q6 | "관리자에게 알린다"의 수단 | 알림 저장 위치·형식이 없다. 화면은 7단계다 |

【작업】
1. V12·V13·V15·V18·V19·V20 결과와 Q1~Q6 의 결정을 계획서에 반영한다. 상태 줄을 `v5.6`으로, 변경 이력 맨 위에 `- v5.6: …` 한 줄(Q1~Q6 을 모두 언급). `was_blocking`인 V 파일은 `resolved_in: "v5.6"`. 이 문서의 영향받는 TC 단언(`(V<n> 의존)`, Q1~Q6 을 쓰는 K1~K4 TC)을 결정에 맞춰 고치고 문서 머리의 계획서 버전을 v5.6 으로 바꾼다. 커밋.
   (Q1~Q6 은 사람이 고른다. 이 문서는 결정의 내용을 정하지 않는다. 고른 결과는 아래 TC 와 K1~K4 TC 단언으로만 기계에 닿는다.)

【테스트】
```
TC-K0.T12.a  계획서 개정이 공백 여섯을 모두 닫는다
  단언:  grep "^- v5\.6: .*Q1.*Q2.*Q3.*Q4.*Q5.*Q6" 계획서 → 1, 상태 줄 v5.6 이상 → 1, check-verify resolved --set phase2 → 0
  검출:  Q1 을 남긴 채 K2 를 열어 남은 한도 0 인 회원의 새 키(사용액 0)가 예산 없이 무제한으로 쓰이는 것
```

【통과】
- [ ] G-K0.28 · G-K0.29 · G-K0.15 통과

### ☐ K0.T13 — 필수 검사·병합 방식 대조
선행 K0.T2 · 산출 `scripts/check-required-checks.mjs`, `test/check-required-checks.test.mjs`, `test/fixtures/required-checks/**` · 되돌리기 커밋 1개

【작업】
1. `check-required-checks.mjs --repo <owner/name> [--rules <json 파일>]`: `gh api repos/<repo>/rules/branches/main`의 `required_status_checks` 문맥 ⊇ `.github/workflows/*.yml`의 잡 표시 이름(`name`, 매트릭스 `${{ matrix.combo }}`는 펼침) 이고, `pull_request.allowed_merge_methods == ["merge"]`인지 본다. `--rules`는 음성 대조용 파일 입력. CI 단계 잡에는 `GH_TOKEN: ${{ github.token }}`을 준다. 커밋.
2. `(사용자/메인 세션)` main ruleset 의 `allowed_merge_methods`를 `merge` 하나로 줄인다 (지금 `merge`·`squash`·`rebase` 셋 다 허용 — 2026-10-10 `gh api` 로 확인). K0 잡 이름을 필수 검사에 넣는다. 이후 단계마다 같은 일을 한다.

【테스트】
```
TC-K0.T13.a  필수 검사에 빠진 잡 이름을 잡는다
  단언:  --rules 픽스처(ci.yml 잡 이름 중 "재발 방지 (S7 게이트)" 하나를 뺀 목록) → 종료코드 ≠ 0, 빠진 이름 출력
  검출:  새 단계 잡을 ci.yml 에 넣고 ruleset 에 넣지 않아, 그 잡이 빨개도 PR 이 병합되는 것
TC-K0.T13.b  스쿼시·리베이스 허용을 잡는다
  단언:  --rules 픽스처(필수 검사는 다 있고 allowed_merge_methods ["merge","squash"]) → ≠ 0. ["merge"] → 0
  검출:  스쿼시 병합 한 번으로 봉인 head 가 main 의 조상이 아니게 돼 그 단계와 뒤 단계 봉인이 모두 ⚠ 가 되는 것
TC-K0.T13.c  실제 ruleset 이 맞다
  단언:  check-required-checks --repo henryj-dev/magnetosphere → 종료코드 0
  검출:  ruleset 설정이 ci.yml 과 어긋난 채 단계를 봉인하는 것
```

【통과】
- [ ] G-K0.30 · G-K0.31 통과

### ☐ K0.T14 — 재현 빨강 확인 장치
선행 K0.T1 · 산출 `scripts/check-red.mjs`, `test/check-red.test.mjs` · 되돌리기 커밋 1개

【작업】
1. `check-red.mjs --check <검사 ID> --since seal:<단계>|<ref>`: 설정에서 그 검사의 명령을 찾고, `<봉인 head>..HEAD`에서 꼬리줄 `Red: <TC>`(검사 `desc`의 첫 TC ID)를 가진 커밋을 찾아 그 커밋 작업 트리(`git worktree add --detach`, 잠금 파일이 있으면 `pnpm install --frozen-lockfile`)에서 명령을 돌린다. 종료코드 ≠ 0 이어야 통과. `test` 검사면 `expectPassed`를 못 채운 경우도 빨강으로 본다. 커밋.

【테스트】
```
TC-K0.T14.a  Red 커밋이 없으면 실패한다
  단언:  임시 저장소, Red 꼬리줄 없는 이력 → 종료코드 ≠ 0, "Red: TC-… 커밋 없음"
  검출:  재현 테스트 없이 고침만 넣어, 테스트가 고치기 전에도 초록이었는지(검출력 0) 아무도 모르는 것
TC-K0.T14.b  Red 커밋에서 초록이면 실패한다
  단언:  Red 커밋에서 이미 통과하는 테스트 → 종료코드 ≠ 0, "Red 커밋에서 통과"
  검출:  재현 테스트가 고장과 무관한 것을 단언해 고친 뒤에도 고치기 전에도 초록인 것
TC-K0.T14.c  Red 커밋에서 빨강이면 통과한다
  단언:  Red 커밋에서 실패, HEAD 에서 통과하는 테스트 → 종료코드 0
  검출:  장치가 모든 경우를 실패로 내 행동 변경 작업이 봉인될 수 없는 것
```

【통과】
- [ ] G-K0.34 통과

### ☐ K0.T15 — K0 CI 잡과 봉인
선행 K0.T1 ~ K0.T14 · 산출 `.github/workflows/ci.yml` · 되돌리기 커밋 1개

【작업】
1. `ci.yml`에 잡 `p2-k0`(이름 `장치·확인 (K0 게이트, OmniRoute 3.8.51)`)을 넣는다: checkout(fetch-depth 0) → pnpm → node → install → 스텝 `run: node scripts/gate.mjs K0 --explain`, `env: GH_TOKEN: ${{ github.token }}`. 계약 환경과 측정용 OmniRoute 는 검사 실행기가 띄운다. 커밋.
2. `(사용자/메인 세션)` ruleset 필수 검사에 `장치·확인 (K0 게이트, OmniRoute 3.8.51)`를 넣는다.
3. `node scripts/gate.mjs K0 --seal` → 봉인 파일 커밋 → PR → 머지 커밋으로 병합.

【테스트】
```
TC-K0.T15.a  K0 게이트를 도는 CI 잡이 있다
  단언:  grep "^\s+run: node scripts/gate\.mjs K0\b" .github/workflows/ci.yml → 1 (G-K0.32). 봉인 뒤에는 TC-K0.T2.b 가 이 단계에 대해서도 "잡이 빠지면 stage-missing" 을 확인한다
  검출:  봉인 PR 에 잡을 빠뜨려, 병합 뒤 main 의 guard 잡(G-S7.1)이 처음 빨개지고 그 사이 이 단계 산출을 깨는 변경이 아무 잡에도 걸리지 않는 것
TC-K0.T15.b  ruleset 필수 검사가 이 잡을 포함한다
  단언:  node scripts/check-required-checks.mjs --repo henryj-dev/magnetosphere → 0 (G-K0.31)
  검출:  잡은 있으나 필수 검사가 아니라 빨간 채로 PR 이 병합되는 것
```

【통과】
- [ ] G-K0.32 · G-K0.31 통과

## 🚪 GATE K0

| id | 검사 | 명령 | 통과 기준 |
|---|---|---|---|
| G-K0.1 | TC-S0.T2.a 선행 미봉인 거부 | `node --test --test-reporter=tap --test-name-pattern="TC-S0.T2.a" scripts/gate.test.mjs` | 통과 = 1 |
| G-K0.2 | TC-S0.T2.b 되돌리면 봉인 무효 | 같은 파일, `TC-S0.T2.b` | 통과 = 1 |
| G-K0.3 | TC-S0.T2.c --seal 재검 | 같은 파일, `TC-S0.T2.c` | 통과 = 1 |
| G-K0.4 | TC-S0.T2.d 검사 종류마다 이빨 | 같은 파일, `TC-S0.T2.d` | 통과 = 13 (하위 테스트 포함) |
| G-K0.5 | TC-S0.T3 pre-push 훅 거부 | `… --test-name-pattern="TC-S0.T3" scripts/hook.test.mjs` | 통과 = 2 |
| G-K0.6 ~ 9 | TC-K0.T1.a ~ d | `… --test-name-pattern="TC-K0.T1.<x>" scripts/gate.test.mjs` | 각 통과 = 1 |
| G-K0.10 | TC-K0.T2.a·b | `node --test --test-reporter=tap test/check-ci-matrix.test.mjs` | 통과 = 2 |
| G-K0.11 | TC-K0.T3.a·b | `node scripts/check-ci-matrix.mjs --expect 6 && node scripts/check-ci-matrix.mjs --fixture test/fixtures/ci-guard/concurrency-cancel-main.yml --expect 6 --expect-fail` | 종료코드 0 |
| G-K0.12 | TC-K0.T4.a ~ e | `… --test-name-pattern="TC-K0.T4" scripts/check-verify.test.mjs` | 통과 = 5 |
| G-K0.13 | 확인 파일 6개 존재·모양 | `node scripts/check-verify.mjs present --set phase2` | 종료코드 0 |
| G-K0.14 | 설계를 막는 결과 없음 | `node scripts/check-verify.mjs unblocked --set phase2` | 종료코드 0 |
| G-K0.15 | 막았던 결과는 현재 계획서 버전 | `node scripts/check-verify.mjs resolved --set phase2` | 종료코드 0 |
| G-K0.16 | TC-K0.T5.a V12 | [L] `pnpm test:contract -t "TC-K0.T5.a"` | 통과 = 1 |
| G-K0.17 | TC-K0.T6.a V13 | [L] `pnpm test:contract -t "TC-K0.T6.a"` | 통과 = 1 |
| G-K0.18 | TC-K0.T7.a V15 측정 재현 | [L] `node tests/bench/analytics.mjs --assert` | 종료코드 0 |
| G-K0.19 | V15 기록 수 | json `docs/verify/V15.json` `answer.dataset.records` | ≥ 300,000 |
| G-K0.20 | V15 키 수 | json `answer.dataset.keys` | ≥ 300 |
| G-K0.21 | V15 전체 키 한 달 분석 | json `answer.fullMonth.p95Ms` | ≤ 5,000 |
| G-K0.22 | V15 회원 하나 분석 | json `answer.member.p95Ms` | ≤ 1,000 |
| G-K0.23 | V15 측정 횟수 | json `answer.fullMonth.runs` | ≥ 10 |
| G-K0.24 | TC-K0.T8.a V18 | [L] `pnpm test:contract -t "TC-K0.T8.a"` | 통과 = 1 |
| G-K0.25 | TC-K0.T9.a V19 | [L] `pnpm test:contract -t "TC-K0.T9.a"` | 통과 = 1 |
| G-K0.26 | TC-K0.T10.a·b·c V20 | [L] `pnpm test:contract -t "TC-K0.T10"` | 통과 = 3 |
| G-K0.27 | TC-K0.T11.a | `… --test-name-pattern="TC-K0.T11.a" tests/contract/budget-block.test.mjs` | 통과 = 1 |
| G-K0.28 | TC-K0.T12.a 공백 Q1~Q6 닫음 | grep `^- v5\.6: .*Q1.*Q2.*Q3.*Q4.*Q5.*Q6` 계획서 | == 1 |
| G-K0.29 | 계획서 v5.6 이상 | grep `^상태: 초안 v5\.([6-9]\|[1-9][0-9])` 계획서 | == 1 |
| G-K0.30 | TC-K0.T13.a·b | `node --test --test-reporter=tap test/check-required-checks.test.mjs` | 통과 = 2 |
| G-K0.31 | TC-K0.T13.c ruleset · TC-K0.T15.b | `node scripts/check-required-checks.mjs --repo henryj-dev/magnetosphere` | 종료코드 0 |
| G-K0.32 | TC-K0.T15.a CI 단계 잡 | grep `^\s+run: node scripts/gate\.mjs K0\b` in `.github/workflows/ci.yml` | == 1 |
| G-K0.33 | 스크립트 테스트 전부 | `node --test --test-reporter=tap "scripts/*.test.mjs"` | 종료코드 0 |
| G-K0.34 | TC-K0.T14.a·b·c | `node --test --test-reporter=tap test/check-red.test.mjs` | 통과 = 3 |
| G-K0.35 | 재현 빨강 TC-K0.T1.a | `node scripts/check-red.mjs --check G-K0.6 --since seal:S7` | 종료코드 0 |
| G-K0.36 | 재현 빨강 TC-K0.T3.a | `node scripts/check-red.mjs --check G-K0.11 --since seal:S7` | 종료코드 0 |

`node scripts/gate.mjs K0 --seal`

가장 중요한 검사는 G-K0.14 다. 확인 항목 여섯 중 V12(공동 예산)·V18(삭제 키 기록)·V19(재발급 누적)·V20(경계값) 넷이 5.3 분배 방식의 전제다. 하나라도 계획서와 다르면 K2·K4 를 지금 계획대로 만드는 일이 통째로 헛일이 되므로, 설계를 막는 결과가 남은 채로는 K1 이 열리지 않아야 한다. 장치 쪽에서는 G-K0.4 다 — `TC-S0.T2.d`가 검사 종류마다 이빨이 있음을 다시 보이지 못하면 이 문서의 모든 GATE 가 장식이다.

---

# K1 — 작업 기반: 임대·작업 큐·주기 등록 🔒 (K0 필요)

**브랜치** `p2/k1`.
**outputs** `packages/db/migrations/*/0001_*`, `packages/runtime/test/lease-fence/**`, `apps/server/src/queue/**`, `apps/server/test/queue/**` (새 경로만, 0절). 이 단계가 고치는 기존 파일(`lease.ts`·`node.ts`·`workers.ts`·`types.ts`, `packages/db/src/schema/**`, `apps/server/src/jobs.ts`, `apps/server/wrangler.toml`)은 `outputs`에 없다. 스키마 변경(V19 결과의 `api_keys` 칼럼 포함)은 모두 이 단계가 한다.

### ☐ K1.T1 — `job_leases` 펜싱 토큰 칼럼
선행 없음 · 산출 `packages/db/src/schema/**`, `packages/db/migrations/{sqlite,mysql,pg}/0001_*` · 되돌리기 커밋 1개

【작업】
1. 공통 정의 `jobLeases`에 `fence`(정수, NOT NULL, 기본 0)를 더하고 세 벌 생성·마이그레이션을 만든다. V19 결과로 계획서가 `api_keys` 칼럼을 바꿨으면 같은 커밋에 넣는다. 커밋.

【테스트】
```
TC-K1.T1.a  다섯 DB 빈 상태 → 최신 마이그레이션에 fence 칼럼이 있다
  단언:  test:migrate --db sqlite,mysql,mariadb,pg,d1 → job_leases.fence 정수 NOT NULL 기본 0, 기존 행이 있는 DB 에 0001 적용 뒤 fence = 0
  검출:  한 DB 의 마이그레이션만 빠져 그 DB 에서 acquireLease 가 "no such column fence" 로 주기 작업 전체가 멈추는 것
TC-K1.T1.b  마이그레이션과 생성 스키마가 같다
  단언:  pnpm -C packages/db gen && git diff --exit-code packages/db/src/schema/ → 0, pnpm -C packages/db check:drift → 0
  검출:  공통 정의만 고치고 생성물·마이그레이션을 안 만들어 Drizzle 이 없는 칼럼에 쓰는 것
```

【통과】
- [ ] G-K1.1 · G-K1.2 통과

### ☐ K1.T2 — 임대 하트비트·펜싱 (S4 보안 리뷰 L4)
선행 K1.T1 · 산출 `packages/runtime/src/lease.ts`, `packages/runtime/src/node.ts`, `packages/runtime/src/workers.ts`, `packages/runtime/test/lease-fence/**` · 되돌리기 커밋 2개 · 장치 요구 `Red: TC-K1.T2.a`

【작업】
1. TC-K1.T2.a 를 넣는다 (지금 `acquireLease`는 한 번 잡고 늘리지 않으므로 빨강). 꼬리줄 `Red: TC-K1.T2.a`. 커밋.
2. `acquireLease`는 잡으면 `{ fence }`(잡을 때마다 `fence + 1`)를 돌려준다. `renewLease(name, holder, fence, ttl)`은 같은 holder·fence 일 때만 늘린다. Node `schedule()`은 작업 중 `ttl / 3`마다 늘리고, 늘리기에 실패하면 작업에 넘긴 `AbortSignal`을 끊는다. `fenced(h, name, fence)` 조건을 DB 쓰기(`api_keys.budget_usd`·`sync_state`, `omniroute_jobs`)에 붙인다. Workers 는 Cron 호출이 겹칠 수 있으므로(1분 작업이 1분을 넘기면) 같은 임대를 쓴다. 커밋.

【테스트】
```
TC-K1.T2.a  하트비트가 있는 동안 다른 인스턴스는 임대를 못 잡는다
  단언:  ttl 300ms, 작업 1,500ms, 다른 holder 가 100ms 마다 acquireLease → 성공 0회 (sqlite·mysql·mariadb·pg)
  검출:  node.ts schedule() 이 ttl = period − 5_000 로 한 번 잡고 늘리지 않아, 55초를 넘는 분배가 다음 1분 경계에서 두 인스턴스에서 동시에 도는 것
TC-K1.T2.b  임대를 잃은 쪽의 펜싱 쓰기는 0행이다
  단언:  A 가 fence n 으로 잡음 → 늘리지 않고 만료 → B 가 fence n+1 → A 의 fenced 갱신 0행, B 의 갱신 1행 (네 DB)
  검출:  멈췄다 깨어난 인스턴스(GC·절전)가 옛 계산으로 budget_usd 를 덮어써 새 임대자의 예산 기록과 OmniRoute 예산이 어긋나는 것
TC-K1.T2.c  하트비트 실패면 작업 신호가 끊기고 OmniRoute 호출이 멈춘다
  단언:  renewLease 가 false 를 돌려주는 가짜 DB + 가짜 fetch → signal.aborted true, 끊긴 뒤 fetch 호출 0건
  검출:  임대를 잃고도 분배 루프가 끝까지 돌아 setBudget 을 두 인스턴스가 번갈아 부르는 것
TC-K1.T2.d  fence 는 같은 이름에서 엄격히 증가한다
  단언:  같은 이름을 holder 바꿔 10번 잡음 → fence 10개가 엄격 증가 (네 DB)
  검출:  MySQL INSERT IGNORE 경로(RETURNING 없음)에서 fence 를 다시 읽지 않아 두 임대자가 같은 fence 를 받는 것
```

【통과】
- [ ] G-K1.3 ~ G-K1.6 통과
- [ ] G-K1.18 통과 (Red 커밋에서 TC-K1.T2.a 실패)

### ☐ K1.T3 — 작업 큐 `omniroute_jobs` 와 재시도
선행 K1.T2 · 산출 `apps/server/src/queue/**`, `apps/server/test/queue/**` · 되돌리기 커밋 1개

【작업】
1. `enqueue(action, payload)` · `runDue(now)`(done_at NULL 이고 next_run_at ≤ now, 펜싱 아래 한 건씩 차지) · 핸들러 표(`key.apply_state`, `key.delete`, `budget.set`, `key.rollback`). 실패하면 `attempts + 1`, 다음 간격 `[10_000, 30_000, 120_000, 600_000]`ms. 4번째 재시도 뒤 동작과 실행기 주기는 계획서 v5.6 의 Q2·Q3 결정대로. `last_error`에는 OmniRoute 오류 코드·상태만 남기고 원문 키·토큰은 지운다. 커밋.

【테스트】
```
TC-K1.T3.a  재시도 간격은 10초·30초·2분·10분이다
  단언:  늘 실패하는 핸들러, 가짜 시계 → 실패 시각 대비 next_run_at 차이 == 10000, 30000, 120000, 600000 ms (그 뒤는 Q3 결정)
  검출:  간격 표 순서·단위를 틀려(초를 ms 로) 10ms 마다 OmniRoute 를 두드리거나 첫 재시도가 10분 뒤로 밀리는 것
TC-K1.T3.b  재시도를 다 써도 실패하면 대상 키가 failed 로 드러난다 (Q3 의존)
  단언:  4번째 재시도 실패 → 대상 api_keys.sync_state "failed", audit_log 에 action "alert.job_failed" 1행 (Q6 결정 형식)
  검출:  실패 작업이 조용히 10분 간격으로 영원히 남아 정지가 반영 안 된 회원 키가 계속 켜져 있는데 아무도 모르는 것
TC-K1.T3.c  두 실행기가 동시에 돌아도 작업마다 핸들러는 한 번이다
  단언:  작업 20개, 실행기 둘 동시 runDue → 작업마다 핸들러 호출 정확히 1 (sqlite·mysql·mariadb·pg)
  검출:  두 인스턴스가 같은 key.rollback 을 동시에 돌려 DELETE 를 두 번 보내고, 두 번째 404 를 실패로 세어 재시도가 쌓이는 것
TC-K1.T3.d  성공한 작업은 done_at 이 찍히고 다시 돌지 않는다
  단언:  성공 → done_at 설정, attempts 1, 다음 runDue 에서 호출 0
  검출:  done_at 을 안 찍어 매 실행마다 같은 PATCH 를 다시 보내는 것
TC-K1.T3.e  last_error 에 비밀 값이 없다
  단언:  오류 본문에 "oma_live_x…"·"sk-x…" 를 담은 OmniRouteError → last_error 에 "oma_live_"·"sk-" 0건
  검출:  OmniRouteError.message 가 응답 본문 300자를 담아(어댑터 call()) 관리 토큰이 DB 에 평문으로 남는 것
```

【통과】
- [ ] G-K1.7 ~ G-K1.11 · G-K1.17 통과

### ☐ K1.T4 — 주기 작업 등록 (1분 분배·5분 정합성·큐 실행기)
선행 K1.T3 · 산출 `apps/server/src/jobs.ts`, `apps/server/wrangler.toml`, `packages/runtime/src/types.ts` · 되돌리기 커밋 1개

【작업】
1. `JOBS`에 `omniroute_jobs` 실행기(Q2 결정의 주기)를 등록한다. 분배(`budget_rebalance`, `* * * * *`)는 K2.T3, 정합성 점검(`reconcile`, `*/5 * * * *`)은 K3.T3 이 본문과 함께 등록한다 — 본문 없는 작업을 main 에 등록하지 않는다. `wrangler.toml [triggers] crons`를 `JOBS` cron 집합과 같게 두고, 이 같음을 TC-K1.T4.b 가 뒤 단계에서도 계속 본다. 커밋.

【테스트】
```
TC-K1.T4.a  작업 큐 실행기가 Q2 결정 주기로 등록된다 (Q2 의존)
  단언:  JOBS 에 name "omniroute_jobs" 하나, 주기 == Q2 결정 (Node 는 그 주기 타이머, Workers 는 "* * * * *")
  검출:  실행기를 등록하지 않아 반영 실패 작업이 큐에 쌓이기만 하고 재시도가 한 번도 돌지 않는 것
TC-K1.T4.b  wrangler crons 집합이 JOBS cron 집합과 같다
  단언:  wrangler.toml 의 triggers.crons 집합 == JOBS cron 집합
  검출:  지금 crons = ["*/5 * * * *"] 뿐이라 Workers 조합에서 1분 분배가 한 번도 불리지 않는 것 (runScheduled 는 받은 cron 에 등록된 작업만 돈다)
TC-K1.T4.c  Workers scheduled 는 받은 cron 의 작업만 돈다
  단언:  시험용 작업 둘("* * * * *"·"*/5 * * * *")을 registerJobs 에 넘긴 wrangler dev --test-scheduled → "* * * * *" 호출엔 첫 작업만, "*/5 * * * *" 호출엔 둘째만 실행 기록
  검출:  cron 문자열 비교가 틀려 5분마다 분배와 점검이 함께 돌거나 아무것도 안 도는 것
TC-K1.T4.d  Node 는 1분 경계마다 인스턴스 둘 중 하나만 1분 작업을 돈다
  단언:  같은 DB 에 붙은 런타임 둘, 시험용 "* * * * *" 작업, 가짜 시계 3 경계 → 실행 기록 3, 경계마다 holder 하나 (mysql·pg)
  검출:  하트비트(K1.T2) 를 붙이며 임대 판정을 바꿔 두 인스턴스가 같은 경계에서 둘 다 도는 것
```

【통과】
- [ ] G-K1.12 ~ G-K1.16 통과

### ☐ K1.T5 — K1 CI 잡과 봉인
선행 K1.T1 ~ K1.T4 · 산출 `.github/workflows/ci.yml` · 되돌리기 커밋 1개

【작업】
1. 잡 `p2-k1`(이름 `작업 기반 (K1 게이트, 네 DB)`) 스텝 `run: node scripts/gate.mjs K1 --explain`. `gates.config.mjs` K1 `checks`를 아래 표대로 채운다 (`expectPassed` 포함). 커밋.
2. `(사용자/메인 세션)` ruleset 필수 검사에 `작업 기반 (K1 게이트, 네 DB)`.
3. `gate K1 --seal` → 커밋 → PR → 머지 커밋.

【테스트】
```
TC-K1.T5.a  K1 게이트를 도는 CI 잡이 있다
  단언:  grep "^\s+run: node scripts/gate\.mjs K1\b" .github/workflows/ci.yml → 1 (G-K1.20). 봉인 뒤에는 TC-K0.T2.b 가 이 단계에 대해서도 "잡이 빠지면 stage-missing" 을 확인한다
  검출:  봉인 PR 에 잡을 빠뜨려, 병합 뒤 main 의 guard 잡(G-S7.1)이 처음 빨개지고 그 사이 이 단계 산출을 깨는 변경이 아무 잡에도 걸리지 않는 것
TC-K1.T5.b  ruleset 필수 검사가 이 잡을 포함한다
  단언:  node scripts/check-required-checks.mjs --repo henryj-dev/magnetosphere → 0 (G-K1.21)
  검출:  잡은 있으나 필수 검사가 아니라 빨간 채로 PR 이 병합되는 것
```

【통과】
- [ ] G-K1.20 · G-K1.21 통과

## 🚪 GATE K1

| id | 검사 | 명령 | 통과 기준 |
|---|---|---|---|
| G-K1.1 | TC-K1.T1.a 다섯 DB fence 칼럼 | [L] `pnpm -C packages/db test:migrate -t "TC-K1.T1.a" --db sqlite,mysql,mariadb,pg,d1` | 통과 = 5 (TC 1 × DB 5) |
| G-K1.2 | TC-K1.T1.b 생성물·드리프트 | `pnpm -C packages/db gen && git diff --exit-code packages/db/src/schema/ && pnpm -C packages/db check:drift` | 종료코드 0 |
| G-K1.3 | TC-K1.T2.a 하트비트 | [L] `pnpm -C packages/runtime test:db -t "TC-K1.T2.a" --db sqlite,mysql,mariadb,pg` | 통과 = 4 |
| G-K1.4 | TC-K1.T2.b 펜싱 쓰기 | [L] 같은 실행기, `TC-K1.T2.b` | 통과 = 4 |
| G-K1.5 | TC-K1.T2.c 신호 끊김 | `pnpm -C packages/runtime test -t "TC-K1.T2.c"` | 통과 = 1 |
| G-K1.6 | TC-K1.T2.d fence 증가 | [L] `… test:db -t "TC-K1.T2.d" --db sqlite,mysql,mariadb,pg` | 통과 = 4 |
| G-K1.7 | TC-K1.T3.a 재시도 간격 | `pnpm -C apps/server test -t "TC-K1.T3.a"` | 통과 = 1, 간격 10,000·30,000·120,000·600,000ms |
| G-K1.8 | TC-K1.T3.b 재시도 소진 | `pnpm -C apps/server test -t "TC-K1.T3.b"` | 통과 = 1 |
| G-K1.9 | TC-K1.T3.c 동시 실행기 | [L] `pnpm -C apps/server test:db -t "TC-K1.T3.c" --db sqlite,mysql,mariadb,pg` | 통과 = 4 |
| G-K1.10 | TC-K1.T3.d 완료 기록 | `pnpm -C apps/server test -t "TC-K1.T3.d"` | 통과 = 1 |
| G-K1.11 | TC-K1.T3.e 비밀 값 없음 | `pnpm -C apps/server test -t "TC-K1.T3.e"` | 통과 = 1 |
| G-K1.12 | TC-K1.T4.a 큐 실행기 등록 | `pnpm -C apps/server test -t "TC-K1.T4.a"` | 통과 = 1 |
| G-K1.13 | TC-K1.T4.b crons 집합 | `pnpm -C apps/server test -t "TC-K1.T4.b"` | 통과 = 1 |
| G-K1.14 | TC-K1.T4.c Workers 분기 | [L] `pnpm -C apps/server test:workers -t "TC-K1.T4.c"` | 통과 = 1 |
| G-K1.15 | TC-K1.T4.d Node 경계마다 하나 | [L] `pnpm -C apps/server test:db -t "TC-K1.T4.d" --db mysql,pg` | 통과 = 2 |
| G-K1.16 | 큐 실행기 등록 | grep `name: "omniroute_jobs"` in `apps/server/src/jobs.ts` | == 1 |
| G-K1.17 | 재시도 간격 상수 | grep `\[10_000, 30_000, 120_000, 600_000\]` in `apps/server/src/queue` | == 1 |
| G-K1.18 | 재현 빨강 TC-K1.T2.a | `node scripts/check-red.mjs --check G-K1.3 --since seal:K0` | 종료코드 0 |
| G-K1.19 | 타입 검사 | `pnpm -r typecheck` | 종료코드 0 |
| G-K1.20 | TC-K1.T5.a CI 단계 잡 | grep `^\s+run: node scripts/gate\.mjs K1\b` in ci.yml | == 1 |
| G-K1.21 | ruleset · TC-K1.T5.b | `node scripts/check-required-checks.mjs --repo henryj-dev/magnetosphere` | 종료코드 0 |

`node scripts/gate.mjs K1 --seal`

가장 중요한 검사는 G-K1.3 이다. 2단계의 모든 주기 작업(분배·점검·큐)이 "한 번에 한 인스턴스"라는 전제 위에 있다. 이 전제가 깨지면 두 인스턴스가 같은 회원 예산을 서로 다른 시점의 분석으로 번갈아 쓰고, 그 결과는 어느 TC 의 단일 실행에서도 재현되지 않는다.

---

# K2 — 회원 단위 한도 분배 🔒 (K1 필요)

**브랜치** `p2/k2`.
**outputs** `apps/server/src/limits/**`, `apps/server/test/limits/**`, `apps/server/test/contract/limits/**` (새 경로만). 어댑터(`packages/omniroute/src`)를 고쳐야 하면 고치되 `outputs`에는 넣지 않는다 (0절). V12 결과로 공동 예산 방식이 되어도 이 경로와 어댑터 안에서 끝난다.

### ☐ K2.T1 — 남은 한도 계산 (순수 함수)
선행 없음 · 산출 `apps/server/src/limits/compute.ts`, `apps/server/test/limits/**` · 되돌리기 커밋 1개

【작업】
1. `computeBudgets({ limitUsd, keys: [{ id, state, spentUsd }] })` → `{ memberSpent, remaining, budgets: Map<id, number> }`. 계획서 5.3 식: 회원 사용액 = 모든 키(삭제 포함) 사용액 합, 남은 한도 = max(한도 − 사용액, 0), 키 예산 = 그 키 사용액 + 남은 한도 (삭제 키는 예산 대상 아님). 한도 NULL 이면 예산 없음. 남은 한도 0 · 사용액 0 키는 v5.6 Q1 결정대로. 금액은 소수 6자리(`DECIMAL(12,6)`)로 반올림. 커밋.

【테스트】
```
TC-K2.T1.a  계산식이 계획서 5.3 과 같다
  단언:  한도 5, 키 A(active) 3, 키 B(deleted) 1.5, 키 C(active) 0 → 사용액 4.5, 남은 0.5, A 3.5, C 0.5, B 예산 없음
  검출:  삭제 키를 사용액 합에서 빼 키를 지우면 한도가 늘어나는 것 (7장 회귀 시나리오 "키 삭제 후 재발급으로 한도 초기화")
TC-K2.T1.b  한도를 넘긴 회원의 남은 한도는 0 이고 예산은 음수가 아니다
  단언:  한도 5, 사용액 6(A 4, B 2) → 남은 0, A 예산 4, B 예산 2
  검출:  max(…, 0) 을 빠뜨려 예산이 사용액보다 작아지고 setBudget 이 음수·0 으로 TypeError 를 던져 분배 전체가 멈추는 것
TC-K2.T1.c  한도 NULL(무제한)이면 예산을 걸지 않는다
  단언:  limitUsd null → budgets 빈 Map
  검출:  NULL 을 0 으로 읽어 무제한 회원의 모든 키를 막는 것 (5.9 "NULL이면 무제한")
TC-K2.T1.d  남은 한도 0 · 사용액 0 키는 Q1 결정대로 막힌다 (Q1 의존)
  단언:  한도 1, A 사용액 1, C 사용액 0 → C 에 대한 결정 결과 (예산 0 이하 값을 setBudget 에 넘기는 경우 0건)
  검출:  C 예산이 0 으로 계산돼 OmniRoute 에서 무제한이 되거나(어댑터를 우회한 경우), 어댑터 TypeError 로 분배가 멈추는 것
TC-K2.T1.e  부동소수 오차로 남은 한도가 생기지 않는다
  단언:  한도 0.3, 키 사용액 0.1·0.2 → 남은 0 (6자리 반올림 뒤), 예산은 소수 6자리 이하
  검출:  0.1 + 0.2 = 0.30000000000000004 로 남은 한도가 -4e-17 → 0 은 맞지만, 한도 0.3 사용액 0.1·0.19999999 에서 1e-8 짜리 예산이 생겨 매분 setBudget 이 바뀌는 것
```

【통과】
- [ ] G-K2.1 ~ G-K2.5 통과

### ☐ K2.T2 — 달 경계와 시간대
선행 K2.T1 · 산출 `apps/server/src/limits/month.ts` · 되돌리기 커밋 1개

【작업】
1. `monthWindow(now)` → `[이번 달 1일 00:00, now]`, 시간대는 V20 `answer.timezone`(계획서 v5.6). 1분 분배가 매번 이 창으로 분석을 부르므로 달이 바뀐 첫 실행이 새 달 기준 재계산이다 (Q5). 커밋.

【테스트】
```
TC-K2.T2.a  달 경계 직전·직후의 창이 다르다 (V20 의존)
  단언:  answer.timezone 기준 3월 31일 23:59:59.999 → 창 시작 3월 1일 00:00, 4월 1일 00:00:00.000 → 4월 1일 00:00 (ISO 로 비교)
  검출:  UTC 로 자르는데 OmniRoute 가 다른 시간대로 자르면 매달 첫 몇 시간 동안 지난달 사용액이 이번 달 남은 한도를 깎는 것
TC-K2.T2.b  새 달 첫 실행은 지난달 사용액을 넣지 않는다
  단언:  가짜 분석(지난달 4.9, 이번 달 0), 한도 5, 새 달 00:00:30 실행 → 남은 5
  검출:  창 시작을 "지난 실행 시각"으로 잡는 식의 구현에서 달이 바뀌어도 한도가 풀리지 않는 것
```

【통과】
- [ ] G-K2.6 · G-K2.7 통과

### ☐ K2.T3 — 1분 분배 작업
선행 K2.T2 · 산출 `apps/server/src/limits/rebalance.ts`, `packages/omniroute/src/**`(V15 결정에 필요한 호출), `apps/server/test/contract/limits/**` · 되돌리기 커밋 1개

【작업】
1. `budget_rebalance` 본문: 활성 키가 있는 회원만, V15 `decision`대로 분석 호출(전체 한 번이면 `byApiKey`를 `api_keys` 매핑으로 회원별로 묶는다 — 삭제 키 포함). 회원마다 `computeBudgets` → 목표가 켜짐인 키 중 `budget_usd`와 다른 것만 `setBudget` → 펜싱 아래 `budget_usd` 기록. 분석이 `OmniRouteFormatError`·`OmniRouteError`면 이번 실행은 예산을 하나도 바꾸지 않는다. 어댑터 변경이 필요하면(예: 필터 없는 분석) `packages/omniroute`에 두고 `G-S5.9`(어댑터 밖 관리 호출 0)를 지킨다. `JOBS`에 `{ name: "budget_rebalance", cron: "* * * * *" }`를 등록하고 `wrangler.toml` crons 에 `"* * * * *"`를 더한다 (TC-K1.T4.b 가 같음을 본다). 커밋.

【테스트】
```
TC-K2.T3.a  활성 키가 없는 회원은 OmniRoute 호출이 없다
  단언:  회원 둘(활성 키 있음 1, 꺼진 키만 1), 가짜 OmniRoute → setBudget 대상은 첫 회원 키뿐
  검출:  모든 회원을 매분 돌아 회원 수에 비례해 분배 시간이 늘고 임대(55초)를 넘기는 것
TC-K2.T3.b  예산이 바뀐 키만 setBudget 을 부른다
  단언:  같은 상태로 두 번 실행 → 두 번째 실행 setBudget 0건
  검출:  매분 키마다 POST /api/usage/budget 를 보내 키 300개면 분당 300건이 OmniRoute 에 쌓이는 것
TC-K2.T3.c  분석 형식 오류면 예산을 하나도 바꾸지 않는다
  단언:  분석 응답에 음수 cost(analyticsSchema money 위반) → OmniRouteFormatError, setBudget 0건, budget_usd 변화 0
  검출:  형식이 바뀐 분석을 0 으로 읽어 모든 회원 남은 한도를 한도 전액으로 되돌리는 것
TC-K2.T3.d  두 키로 나눠 써 회원 한도에 닿으면 분배 뒤 두 키 모두 예산 차단이다 (계약)
  단언:  한도 0.02, 키 A·B 각 요청 3건(0.014633씩) → 분배 1회 → A·B 다음 요청 isBudgetBlocked 둘 다 true
  검출:  키별 예산을 키 사용액 기준으로만 걸어 회원 합계가 한도를 넘어도 각 키가 자기 몫 안이라 통과하는 것
TC-K2.T3.e  삭제한 키의 사용액이 새 키의 남은 몫을 줄인다 (계약, V18 의존)
  단언:  한도 0.02, 키 A 요청 3건(0.014633) → A 삭제 → 키 B 발급·분배 → B 예산 == 0.02 − 0.014633 (오차 1e-6)
  검출:  분석 apiKeyIds 에 삭제 키를 빼 B 가 한도 전액을 새로 받는 것
TC-K2.T3.f  사용액 0 키도 회원 한도 도달 뒤 요청이 2xx 가 아니다 (계약, Q1 의존)
  단언:  한도 0.01, 키 A 요청 3건 → 키 C(사용액 0) 분배 1회 → C 다음 요청 상태 ≠ 2xx
  검출:  Q1 공백 그대로 예산 0(무제한)이 걸리거나 예산을 아예 안 걸어 C 로 한도 밖 사용이 계속되는 것
TC-K2.T3.g  초과 폭은 한도 × 동시에 쓰는 키 수 안이다 (계약)
  단언:  한도 0.02, 키 2개를 동시에 예산 차단까지 쓰기 → 회원 총 사용액 ≤ 0.02 × 2 + 요청 1건 비용(0.004878)
  검출:  예산이 "남은 한도"가 아니라 "한도"로 걸려 초과 폭이 키 수와 무관하게 커지는 것 (5.3 한계의 상한이 깨짐)
TC-K2.T3.i  분배는 1분마다 등록된다
  단언:  JOBS 의 budget_rebalance cron == "* * * * *", wrangler crons 에 "* * * * *" 포함 (TC-K1.T4.b 재실행)
  검출:  분배를 5분 정합성 cron 에 같이 걸어 한도 반영이 최대 5분 늦는 것, Workers crons 에서 빠져 Workers 조합에서 분배가 안 도는 것
TC-K2.T3.h  분배 한 번이 측정 환경에서 임대 안에 끝난다 (V15 의존)
  단언:  tests/bench 의 키 300·기록 300,000 환경, 회원 150·각 키 2 매핑 → 분배 1회 소요 ≤ 30,000ms
  검출:  회원마다 분석을 부르는 방식이 V15 결정과 달라져 300 회 호출로 55초 임대를 넘기는 것
```

【통과】
- [ ] G-K2.8 ~ G-K2.15 · G-K2.22 · G-K2.23 통과
- [ ] G-K2.18 통과 (어댑터 밖 OmniRoute 관리 호출 0)

### ☐ K2.T4 — 즉시 분배 진입점
선행 K2.T3 · 산출 `apps/server/src/limits/member.ts` · 되돌리기 커밋 1개

【작업】
1. `rebalanceMember(userId)`: 그 회원 키 전부(삭제 포함) id 로 분석 한 번 → 계산 → 예산. 발급·재발급 직후와 관리자 한도 변경 직후(K4)가 부른다. 1분 작업과 같은 임대를 잡지 않고 회원 단위 펜싱(`budget_usd` 갱신 조건)으로 겹침을 막는다. 커밋.

【테스트】
```
TC-K2.T4.a  즉시 분배는 그 회원 키 전부(삭제 포함)로 분석한다
  단언:  회원 키 3(그중 삭제 1) → getAnalytics apiKeyIds 집합 == 세 id, 다른 회원 키 0
  검출:  삭제 키를 빼고 불러 재발급 직후 예산이 한도 전액으로 걸리는 것 (1분 분배가 고칠 때까지 최대 1분 열림)
TC-K2.T4.b  즉시 분배와 1분 분배가 겹쳐도 옛 계산이 새 계산을 덮지 않는다
  단언:  즉시 분배(분석 시각 t2) 기록 뒤 늦게 끝난 1분 분배(분석 시각 t1 < t2)의 budget_usd 갱신 → 0행
  검출:  늦게 끝난 쪽이 옛 사용액으로 예산을 다시 올려 방금 막은 키가 열리는 것
```

【통과】
- [ ] G-K2.16 · G-K2.17 통과

### ☐ K2.T5 — K2 CI 잡과 봉인
선행 K2.T1 ~ K2.T4 · 산출 `.github/workflows/ci.yml` · 되돌리기 커밋 1개

【작업】
1. 잡 `p2-k2`(이름 `한도 분배 (K2 게이트, OmniRoute 3.8.51)`) 스텝 `run: node scripts/gate.mjs K2 --explain`. K2 `checks` 채움. 커밋.
2. `(사용자/메인 세션)` ruleset 필수 검사에 그 이름.
3. `gate K2 --seal` → 커밋 → PR → 머지 커밋.

【테스트】
```
TC-K2.T5.a  K2 게이트를 도는 CI 잡이 있다
  단언:  grep "^\s+run: node scripts/gate\.mjs K2\b" .github/workflows/ci.yml → 1 (G-K2.20). 봉인 뒤에는 TC-K0.T2.b 가 이 단계에 대해서도 "잡이 빠지면 stage-missing" 을 확인한다
  검출:  봉인 PR 에 잡을 빠뜨려, 병합 뒤 main 의 guard 잡(G-S7.1)이 처음 빨개지고 그 사이 이 단계 산출을 깨는 변경이 아무 잡에도 걸리지 않는 것
TC-K2.T5.b  ruleset 필수 검사가 이 잡을 포함한다
  단언:  node scripts/check-required-checks.mjs --repo henryj-dev/magnetosphere → 0 (G-K2.21)
  검출:  잡은 있으나 필수 검사가 아니라 빨간 채로 PR 이 병합되는 것
```

【통과】
- [ ] G-K2.20 · G-K2.21 통과

## 🚪 GATE K2

| id | 검사 | 명령 | 통과 기준 |
|---|---|---|---|
| G-K2.1 ~ 5 | TC-K2.T1.a ~ e | `pnpm -C apps/server test -t "TC-K2.T1.<x>"` | 각 통과 = 1 |
| G-K2.6 · 7 | TC-K2.T2.a · b | `pnpm -C apps/server test -t "TC-K2.T2.<x>"` | 각 통과 = 1, 창 시작 = V20 시간대 매달 1일 00:00 |
| G-K2.8 ~ 10 | TC-K2.T3.a ~ c | `pnpm -C apps/server test -t "TC-K2.T3.<x>"` | 각 통과 = 1 |
| G-K2.11 | TC-K2.T3.d 두 키 회원 한도 | [L] `pnpm test:contract -t "TC-K2.T3.d"` | 통과 = 1 |
| G-K2.12 | TC-K2.T3.e 삭제 키 사용액 | [L] `pnpm test:contract -t "TC-K2.T3.e"` | 통과 = 1 |
| G-K2.13 | TC-K2.T3.f 사용액 0 키 | [L] `pnpm test:contract -t "TC-K2.T3.f"` | 통과 = 1 |
| G-K2.14 | TC-K2.T3.g 초과 폭 | [L] `pnpm test:contract -t "TC-K2.T3.g"` | 통과 = 1, 회원 총 사용액 ≤ 한도 × 2 + 0.004878 |
| G-K2.15 | TC-K2.T3.h 분배 소요 | [L] `node tests/bench/analytics.mjs --rebalance --assert` | 종료코드 0, ≤ 30,000ms |
| G-K2.16 · 17 | TC-K2.T4.a · b | `pnpm -C apps/server test -t "TC-K2.T4.<x>"` | 각 통과 = 1 |
| G-K2.18 | 어댑터 밖 관리 호출 0 | grep `/api/(keys\|usage)` in `apps packages`, `packages/omniroute/**` 제외 | == 0 |
| G-K2.19 | 타입 검사 | `pnpm -r typecheck` | 종료코드 0 |
| G-K2.20 | TC-K2.T5.a CI 단계 잡 | grep `^\s+run: node scripts/gate\.mjs K2\b` in ci.yml | == 1 |
| G-K2.22 | TC-K2.T3.i 분배 1분 등록 | `pnpm -C apps/server test -t "TC-K2.T3.i" && pnpm -C apps/server test -t "TC-K1.T4.b"` | 통과 = 2 |
| G-K2.23 | 1분 주기 상수 | grep `name: "budget_rebalance", cron: "\* \* \* \* \*"` in `apps/server/src/jobs.ts` | == 1 |
| G-K2.21 | ruleset · TC-K2.T5.b | `node scripts/check-required-checks.mjs --repo henryj-dev/magnetosphere` | 종료코드 0 |

`node scripts/gate.mjs K2 --seal`

가장 중요한 검사는 G-K2.11 이다. "여러 키로 나눠 써도 회원 한도에서 429"가 2단계 완료 기준 가운데 이 프로젝트가 새로 만드는 유일한 차단이다 (끈 키 거부·예산 차단 자체는 OmniRoute 기능이고 1단계 계약 시험이 이미 본다). 계산 함수 단위 TC 가 모두 초록이어도 분석의 `byApiKey` 묶음이 매핑과 어긋나면 이 계약 TC 만 빨개진다.

---

# K3 — 키 목표 상태·반영·정합성 점검 🔒 (K2 필요)

**브랜치** `p2/k3`.
**outputs** `apps/server/src/keys/**`, `apps/server/test/keys/**`, `apps/server/test/contract/keys/**`.

### ☐ K3.T1 — 목표 상태 함수
선행 없음 · 산출 `apps/server/src/keys/target.ts` · 되돌리기 커밋 1개

【작업】
1. `targetState(keyState, userStatus)` → `deleted | off | on` (계획서 5.7 식). `disabled_reason` 셋(`member`·`admin`·`user_status`)과 정지 해제 규칙. 커밋.

【테스트】
```
TC-K3.T1.a  12 조합 표가 계획서 5.7 과 같다
  단언:  keyState {active, disabled, deleted} × userStatus {pending, active, suspended, deleted} 12 칸 == 기대 표 (deleted 4·… 정확히)
  검출:  pending 회원 키를 켜짐으로 계산해 승인 전 회원이 키를 쓰는 것
TC-K3.T1.b  정지를 풀면 user_status 때문에 꺼진 키만 켠다
  단언:  키 셋(disabled_reason member · admin · user_status), 회원 suspended → active → user_status 키만 목표 on, 나머지 off 유지
  검출:  정지 해제가 회원 스스로 끈 키·관리자가 끈 키까지 켜는 것
```

【통과】
- [ ] G-K3.1 · G-K3.2 통과

### ☐ K3.T2 — 반영: 즉시 실행, 실패하면 큐
선행 K3.T1 · 산출 `apps/server/src/keys/apply.ts` · 되돌리기 커밋 1개

【작업】
1. `applyKey(keyId)`: 목표 계산 → OmniRoute 상태가 다르면 즉시 `setKeyActive`/`deleteKey`. 켜기 직전 `rebalanceMember`(K2.T4)로 예산을 먼저 건다. 2xx 면 `sync_state = synced`, 실패하면 `pending` + `key.apply_state` 작업(첫 재시도 10초). 끄기·정지는 반영이 끝나야 "완료" — API 응답은 `sync_state`를 그대로 준다 (화면 "반영 중" 표시는 4단계·7단계). 커밋.

【테스트】
```
TC-K3.T2.a  끄기는 응답 전에 OmniRoute 에 반영된다
  단언:  applyKey(목표 off) → 응답 전 setKeyActive(false) 1건, sync_state synced
  검출:  끄기를 큐에만 넣어 최대 1분 동안 끈 키가 동작하는 것 (V11: OmniRoute 는 PATCH 직후부터 403)
TC-K3.T2.b  OmniRoute 실패면 반영 중으로 남고 10초 뒤 재시도가 잡힌다
  단언:  setKeyActive → OmniRouteError 503 → sync_state pending, key.apply_state 작업 1개, next_run_at − now == 10,000ms
  검출:  실패를 삼켜 synced 로 기록해 정합성 점검(5분) 전까지 꺼야 할 키가 켜져 있는 것
TC-K3.T2.c  목표가 켜짐이 아니면 켜지 않는다
  단언:  회원 suspended, 키 disabled_reason member → 회원이 켜기 요청 → 409, setKeyActive 0건
  검출:  회원이 자기 키를 켜는 경로로 정지를 우회하는 것
TC-K3.T2.d  켜기 전에 예산을 건다
  단언:  켜기 반영의 어댑터 호출 순서 == [getAnalytics, setBudget, setKeyActive(true)]
  검출:  한도를 다 쓴 회원의 꺼진 키를 켤 때 옛 예산(더 큰 값)으로 먼저 켜져 1분 분배 전까지 한도 밖 사용이 열리는 것
```

【통과】
- [ ] G-K3.3 ~ G-K3.6 통과

### ☐ K3.T3 — 정합성 점검 (5분)
선행 K3.T2 · 산출 `apps/server/src/keys/reconcile.ts`, `apps/server/test/contract/keys/**` · 되돌리기 커밋 1개

【작업】
1. `reconcile` 본문: `listKeys()` → 매핑된 키마다 실제 `isActive`를 목표와 비교해 `applyKey`. 매핑 없는 `m_` 키 → 알림(Q6 형식), 삭제·변경 없음. `m_` 키 중 `scopes`에 `manage`·`admin`이 있으면 끄고 알림(5.8). 재시도를 다 쓴 작업(Q3)을 알림으로. 회원 상태 변화(DB 에서 바뀐 정지·탈퇴)도 이 점검이 반영한다. 임대·펜싱 아래서 돈다. `JOBS`에 `{ name: "reconcile", cron: "*/5 * * * *" }`를 등록한다 (1단계 `JOB_CRON`과 wrangler crons 의 `"*/5 * * * *"`가 이미 있다). 커밋.

【테스트】
```
TC-K3.T3.a  OmniRoute 에서 켜진 키의 목표가 꺼짐이면 점검이 끈다 (계약)
  단언:  매핑 키를 어댑터(대시보드 쿠키 자격)로 setKeyActive(true) → 회원 status suspended(DB) → reconcile 1회 → listKeys 의 그 키 isActive false, 요청 403
  검출:  반영 실패·수동 조작으로 어긋난 상태가 영원히 남는 것 (정지한 회원이 계속 쓰는 것)
TC-K3.T3.b  매핑 없는 m_ 키는 알리기만 한다
  단언:  OmniRoute 에 m_deadbeef_cafebabe 키(매핑 없음)와 다른 이름 키 하나 → 알림 1건(m_ 키만), deleteKey·setKeyActive 0건
  검출:  자동 삭제로 운영자가 OmniRoute 에서 직접 만든 키나 복구 중인 매핑을 지우는 것
TC-K3.T3.c  scopes 에 manage 가 붙은 m_ 키는 끄고 알린다 (계약, V10)
  단언:  매핑 키에 scopes ["manage"]를 붙인다(시험 도구 tests/contract 의 대시보드 쿠키 호출, 어댑터는 scopes 를 못 보낸다) → reconcile 1회 → 그 키 isActive false, 알림 1건, 회원 앱이 보낸 요청 본문에 scopes 0건
  검출:  write 토큰으로 회원 키에 manage 를 붙여 admin 토큰을 만드는 권한 상승(V10 privilegeEscalation)을 점검이 놓치는 것
TC-K3.T3.d  점검은 임대를 잃으면 멈춘다
  단언:  reconcile 중 renewLease false → 그 뒤 setKeyActive·deleteKey 0건
  검출:  두 인스턴스 점검이 같은 키를 번갈아 켜고 끄는 것
TC-K3.T3.f  정합성 점검은 5분마다 등록된다
  단언:  JOBS 의 reconcile cron == "*/5 * * * *", TC-K1.T4.b 재실행 통과
  검출:  점검을 1분 cron 에 걸어 OmniRoute 키 목록 전체를 매분 읽거나, 등록을 빠뜨려 어긋난 상태가 영영 안 맞춰지는 것
TC-K3.T3.e  탈퇴 회원 키는 점검이 삭제한다
  단언:  회원 status deleted(DB) → reconcile 1회 → deleteKey 1건, api_keys.state deleted, deleted_at 설정, 행은 남음
  검출:  탈퇴 회원 키가 OmniRoute 에 켜진 채 남거나, 매핑 행을 지워 그 키 사용액이 분석 합계에서 빠지는 것
```

【통과】
- [ ] G-K3.7 ~ G-K3.11 · G-K3.16 · G-K3.17 통과

### ☐ K3.T4 — K3 CI 잡과 봉인
선행 K3.T1 ~ K3.T3 · 산출 `.github/workflows/ci.yml` · 되돌리기 커밋 1개

【작업】
1. 잡 `p2-k3`(이름 `키 상태 (K3 게이트, OmniRoute 3.8.51)`) 스텝 `run: node scripts/gate.mjs K3 --explain`. K3 `checks` 채움. 커밋.
2. `(사용자/메인 세션)` ruleset 필수 검사에 그 이름.
3. `gate K3 --seal` → 커밋 → PR → 머지 커밋.

【테스트】
```
TC-K3.T4.a  K3 게이트를 도는 CI 잡이 있다
  단언:  grep "^\s+run: node scripts/gate\.mjs K3\b" .github/workflows/ci.yml → 1 (G-K3.14). 봉인 뒤에는 TC-K0.T2.b 가 이 단계에 대해서도 "잡이 빠지면 stage-missing" 을 확인한다
  검출:  봉인 PR 에 잡을 빠뜨려, 병합 뒤 main 의 guard 잡(G-S7.1)이 처음 빨개지고 그 사이 이 단계 산출을 깨는 변경이 아무 잡에도 걸리지 않는 것
TC-K3.T4.b  ruleset 필수 검사가 이 잡을 포함한다
  단언:  node scripts/check-required-checks.mjs --repo henryj-dev/magnetosphere → 0 (G-K3.15)
  검출:  잡은 있으나 필수 검사가 아니라 빨간 채로 PR 이 병합되는 것
```

【통과】
- [ ] G-K3.14 · G-K3.15 통과

## 🚪 GATE K3

| id | 검사 | 명령 | 통과 기준 |
|---|---|---|---|
| G-K3.1 · 2 | TC-K3.T1.a · b | `pnpm -C apps/server test -t "TC-K3.T1.<x>"` | 각 통과 = 1 (a 는 12 칸 표 한 테스트) |
| G-K3.3 ~ 6 | TC-K3.T2.a ~ d | `pnpm -C apps/server test -t "TC-K3.T2.<x>"` | 각 통과 = 1, b 는 next_run_at − now == 10,000ms |
| G-K3.7 | TC-K3.T3.a 어긋난 상태 맞춤 | [L] `pnpm test:contract -t "TC-K3.T3.a"` | 통과 = 1 |
| G-K3.8 | TC-K3.T3.b 매핑 없는 m_ 키 | `pnpm -C apps/server test -t "TC-K3.T3.b"` | 통과 = 1 |
| G-K3.9 | TC-K3.T3.c scopes manage 감지 | [L] `pnpm test:contract -t "TC-K3.T3.c"` | 통과 = 1 |
| G-K3.10 | TC-K3.T3.d 임대 잃으면 멈춤 | `pnpm -C apps/server test -t "TC-K3.T3.d"` | 통과 = 1 |
| G-K3.11 | TC-K3.T3.e 탈퇴 회원 키 | [L] `pnpm -C apps/server test:db -t "TC-K3.T3.e" --db sqlite,mysql,mariadb,pg` | 통과 = 4 |
| G-K3.12 | 어댑터 키 수정 본문에 scopes 없음 (1단계 회귀) | [L] `pnpm test:contract -t "TC-S5.T2.i"` | 통과 = 1 |
| G-K3.13 | 타입 검사 | `pnpm -r typecheck` | 종료코드 0 |
| G-K3.14 | TC-K3.T4.a CI 단계 잡 | grep `^\s+run: node scripts/gate\.mjs K3\b` in ci.yml | == 1 |
| G-K3.16 | TC-K3.T3.f 점검 5분 등록 | `pnpm -C apps/server test -t "TC-K3.T3.f" && pnpm -C apps/server test -t "TC-K1.T4.b"` | 통과 = 2 |
| G-K3.17 | 5분 주기 상수 | grep `name: "reconcile", cron: "\*/5 \* \* \* \*"` in `apps/server/src/jobs.ts` | == 1 |
| G-K3.15 | ruleset · TC-K3.T4.b | `node scripts/check-required-checks.mjs --repo henryj-dev/magnetosphere` | 종료코드 0 |

`node scripts/gate.mjs K3 --seal`

가장 중요한 검사는 G-K3.9 다. 계획서 5.8 이 적은 대로 `write` 토큰의 범위 제한은 침해 시 피해를 줄여 주지 못한다. 회원 키에 `manage`가 붙는 일을 잡는 장치는 이 점검 하나뿐이고, 그것이 계약 환경에서 실제로 재현돼야 의미가 있다.

---

# K4 — 키 수명주기와 회원 키 API 🔒 (K3 필요)

**브랜치** `p2/k4`.
**outputs** `apps/server/src/routes/**`, `apps/server/test/routes/**`, `apps/server/test/contract/routes/**`. 라우터를 거는 `apps/server/src/app.ts`는 공용 파일이라 넣지 않는다.

### ☐ K4.T1 — 발급 `POST /api/me/keys`
선행 없음 · 산출 `apps/server/src/routes/keys.ts` · 되돌리기 커밋 1개

【작업】
1. 경로는 `/api/me/keys` (0절 G-S5.9 제약). 회원 세션 필요. 확인(계획서 5.2 1번): 회원 status `active`, `emailVerified`, 키 수(활성 + 비활성, 삭제 제외) < `user.max_keys ?? app_settings.default_max_keys`, 남은 한도 > 0 (한도 NULL 이면 통과). 순서: `createKey(이름)` → `setKeyActive(false)` → 예산(K2 계산) → `setKeyActive(true)` → `api_keys` 행 → `rebalanceMember` → 원문을 응답에 한 번. 2~5 중 실패 → `deleteKey`로 되돌리고 502, 되돌리기도 실패 → `key.rollback` 작업. 이름 `m_<회원 id 앞 8자리>_<키 id 앞 8자리>`, DB 에는 `omniroute_key_id`와 끝 4자리만. 최대 개수 경쟁은 DB 한 문장 조건(D1 은 대화형 트랜잭션이 없으므로 조건부 INSERT 또는 batch)으로 막는다. 커밋.

【테스트】
```
TC-K4.T1.a  발급 순서가 계획서 5.2 와 같다
  단언:  가짜 어댑터 호출 기록 == [createKey, setKeyActive(false), setBudget, setKeyActive(true)], 응답 201 에 원문 1회
  검출:  createKey 직후 켜진 채로 예산을 거는 순서라, 예산 단계가 실패하면 한도 없는 키가 켜진 채 남는 것
TC-K4.T1.b  2~5 단계 어디서 실패해도 만든 키를 지운다
  단언:  실패 위치 셋(끄기·예산·켜기) 각각 → deleteKey 1건, api_keys 행 0, 응답 502
  검출:  되돌리기를 첫 실패 위치에서만 해 예산 단계 실패 때 OmniRoute 에 m_ 키가 남는 것
TC-K4.T1.c  되돌리기도 실패하면 큐에 넣고 켜진 채 남지 않는다
  단언:  예산 실패 + deleteKey 가 OmniRouteError 503 → key.rollback 작업 1개, 그 키는 isActive=false 상태(끄기 단계까지만 진행)
  검출:  되돌리기 실패를 로그만 남겨 OmniRoute 에 매핑 없는 키가 남고 정합성 점검이 알리기만 해 영원히 남는 것
TC-K4.T1.d  거부 조건은 OmniRoute 를 부르지 않는다
  단언:  pending → 403, suspended → 403, emailVerified false → 403, 남은 한도 0 → 409 limit_exhausted, 최대 개수 → 409 max_keys. 각 경우 OmniRoute 호출 0
  검출:  확인 전에 createKey 를 불러 거부된 요청마다 OmniRoute 에 키가 생기고 지워지는 것
TC-K4.T1.e  최대 개수는 기본 2, 비활성 포함, 삭제 제외, 줄여도 기존 키 유지
  단언:  max_keys NULL(시드 default_max_keys 2) → 2 개 201, 3번째 409 · 1개 끄고도 409 · 1개 삭제 → 201 · max_keys 3 → 3번째 201 · 3→1 → 기존 3개 그대로, 새 발급 409
  검출:  꺼진 키를 세지 않아 끄고 발급하기를 반복해 키를 무한히 만드는 것
TC-K4.T1.f  동시 발급 10건은 최대 개수를 넘지 않는다
  단언:  최대 2, 동시 POST 10건 → 201 정확히 2, 남은 응답 409, OmniRoute 의 그 회원 m_ 키 == 2 (sqlite·mysql·mariadb·pg·d1)
  검출:  "세기 → 만들기"가 원자적이지 않아(D1 은 대화형 트랜잭션이 없음) 경쟁하면 최대 개수를 넘는 것
TC-K4.T1.g  원문 키는 응답에만 있다
  단언:  발급 뒤 DB 덤프·서버 로그에 원문 0건, key_preview == 원문 끝 4자리
  검출:  api_keys 에 원문이나 앞부분을 저장해 DB 유출이 곧 키 유출이 되는 것 (5.2 "원문은 저장하지 않는다")
TC-K4.T1.h  OmniRoute 키 이름에 개인정보가 없다
  단언:  이름 ~ /^m_[0-9a-f]{8}_[0-9a-f]{8}$/, 회원 이메일·이름 문자열 0
  검출:  이름에 이메일을 넣어 OmniRoute 로그·대시보드에 회원 개인정보가 퍼지는 것 (7장)
TC-K4.T1.i  목록은 남은 발급 가능 개수를 준다
  단언:  GET /api/me/keys → { keys[], remainingSlots }, 키 1(최대 2) → remainingSlots 1, 원문 필드 없음
  검출:  4단계 화면이 남은 개수를 프런트에서 따로 세어 서버 규칙(비활성 포함)과 어긋나는 것
```

【통과】
- [ ] G-K4.1 ~ G-K4.9 통과

### ☐ K4.T2 — 이름 변경·끄기·켜기·재발급·삭제
선행 K4.T1 · 산출 `apps/server/src/routes/keys.ts` · 되돌리기 커밋 1개

【작업】
1. `PATCH /api/me/keys/:id {label}`(DB 만), `POST /api/me/keys/:id/disable`·`enable`(K3 `applyKey`, `disabled_reason member`), `POST /api/me/keys/:id/regenerate`(V19 결과대로 매핑 유지 또는 갱신, 새 원문 1회, `rebalanceMember`), `DELETE /api/me/keys/:id`(`deleteKey`, `state deleted`, `deleted_at`, 행 유지). 남의 키는 모두 404. 어댑터에 `regenerateKey`가 없으므로 `packages/omniroute/src`에 더한다 (`G-S5.9`: OmniRoute 경로 문자열은 어댑터에만). 커밋.

【테스트】
```
TC-K4.T2.a  이름 변경은 OmniRoute 를 부르지 않는다
  단언:  PATCH label → 200, OmniRoute 호출 0
  검출:  label 을 OmniRoute 키 이름에 써 개인정보 규칙(m_ 이름)을 깨는 것
TC-K4.T2.b  삭제는 행을 남긴다
  단언:  DELETE → deleteKey 1건, state deleted, deleted_at 설정, 다음 분배의 분석 apiKeyIds 에 그 id 포함
  검출:  행을 지워 그 키의 이번 달 사용액이 회원 합계에서 빠지는 것
TC-K4.T2.c  재발급은 한도를 초기화하지 않는다 (V19 의존)
  단언:  재발급 → regenerateKey 1건, 응답 새 원문, 매핑(V19 결과대로)으로 다음 분배가 옛 사용액을 포함
  검출:  regenerate 가 새 id 를 주는데 매핑을 안 바꿔(또는 옛 id 를 버려) 사용액이 0 에서 시작하는 것
TC-K4.T2.d  남의 키는 404 이고 OmniRoute 를 부르지 않는다
  단언:  회원 B 세션으로 A 키에 disable·enable·regenerate·DELETE·PATCH → 모두 404, OmniRoute 0
  검출:  키 id 만으로 조회해 다른 회원 키를 끄거나 재발급해 원문을 가져가는 것
TC-K4.T2.e  회원이 끈 키는 회원이 켤 수 있다
  단언:  disable(member) → enable → 200, setKeyActive(true) 1건. admin 이 끈 키 → enable 403
  검출:  관리자가 끈 키를 회원이 다시 켜는 것
```

【통과】
- [ ] G-K4.10 ~ G-K4.14 통과

### ☐ K4.T3 — 관리자 한도·최대 개수 API
선행 K4.T1 · 산출 `apps/server/src/routes/admin-limits.ts` · 되돌리기 커밋 1개

【작업】
1. `PATCH /api/admin/users/:id {monthlyLimitUsd?, maxKeys?}` (관리자 세션). 값 검사(한도 null 또는 0 이상 `DECIMAL(12,6)` 범위·소수 6자리 이하, maxKeys null 또는 0 이상 정수). 저장 → `rebalanceMember` → `audit_log` 1행. 커밋.

【테스트】
```
TC-K4.T3.a  관리자만 바꾸고, 바꾸면 즉시 분배한다
  단언:  회원 세션 → 403, 세션 없음 → 401, 관리자 → 200 + rebalanceMember 1회 + audit_log(action limits.update) 1행
  검출:  회원이 자기 한도를 올리는 것, 또는 한도를 내려도 1분 분배까지 옛 예산이 남는 것
TC-K4.T3.b  잘못된 값은 400 이다
  단언:  -1 · NaN · "5" · 1e13 · 0.0000001 · maxKeys 1.5 · maxKeys -1 → 각각 400, DB 변화 0
  검출:  음수 한도가 저장돼 남은 한도 계산이 모든 키를 막거나, 1e13 이 DECIMAL(12,6) 를 넘어 MySQL 에서 잘려 저장되는 것
```

【통과】
- [ ] G-K4.15 · G-K4.16 통과

### ☐ K4.T4 — 변경 API 의 CSRF 와 발급 요청 수 제한
선행 K4.T1 · 산출 `apps/server/src/routes/guard.ts` · 되돌리기 커밋 1개

【작업】
1. `/api/me/keys*`·`/api/admin/*`의 GET 아닌 요청은 `Origin`이 `BETTER_AUTH_URL` 출처와 같아야 한다 (7장 "회원 앱 변경 API는 CSRF 보호"). 키 발급·재발급 요청 수 제한은 v5.6 Q4 숫자로, `rate_limit` 테이블(여러 인스턴스 공유)을 쓴다. 커밋.

【테스트】
```
TC-K4.T4.a  다른 출처의 변경 요청은 403 이다
  단언:  Origin https://evil.example 로 POST /api/me/keys · DELETE /api/me/keys/:id → 403, OmniRoute 0. Origin 없음 → 403. 같은 출처 → 정상
  검출:  SameSite=Lax 쿠키만 믿어, 같은 사이트의 다른 하위 도메인 페이지가 회원 키를 발급·삭제하는 것
TC-K4.T4.b  발급 요청 수 제한을 넘으면 429 다 (Q4 의존)
  단언:  같은 회원이 Q4 숫자 + 1 번 발급 시도(최대 개수 넉넉히) → 마지막 429, 다른 인스턴스(같은 DB)에서도 같은 계산 (sqlite·mysql·pg)
  검출:  인스턴스 메모리로 세어 인스턴스 수만큼 한도가 늘거나, 발급·삭제 반복으로 OmniRoute 에 키 생성 요청을 퍼붓는 것
```

【통과】
- [ ] G-K4.17 · G-K4.18 통과

### ☐ K4.T5 — 실제 OmniRoute 로 수명주기 (계약)
선행 K4.T1 ~ K4.T4 · 산출 `apps/server/test/contract/routes/**` · 되돌리기 커밋 1개

【작업】
1. 회원 앱(계약 환경 OmniRoute 에 연결)으로 발급 → 그 원문으로 `/v1/messages`(모델 `mka/claude-mock`) → 끄기 → 삭제. 커밋.

【테스트】
```
TC-K4.T5.a  발급한 키로 Anthropic 형식 요청이 되고, 끄면 403, 지우면 401 이다
  단언:  POST /api/me/keys → 원문 → /v1/messages 200 → disable → 다음 요청 403 permission_denied(지연 0ms, V11) → DELETE → 401
  검출:  발급 순서의 마지막 켜기가 빠지거나 끄기가 큐로만 가서 "끈 키 거부"(완료 기준)가 지연되는 것
TC-K4.T5.b  남은 한도 0 인 회원은 발급이 막히고 OmniRoute 에 키가 늘지 않는다
  단언:  한도 0.01, 키 하나로 요청 3건 → 분배 → 키 삭제 → 새 발급 409 limit_exhausted, listKeys 의 그 회원 m_ 키 수 변화 0
  검출:  "삭제·재발급으로 한도가 초기화되지 않음"(완료 기준)을 발급 거부가 아니라 1분 분배에만 맡겨 새 키로 1분 동안 쓰는 것
```

【통과】
- [ ] G-K4.19 · G-K4.20 통과

### ☐ K4.T6 — K4 CI 잡과 봉인
선행 K4.T1 ~ K4.T5 · 산출 `.github/workflows/ci.yml` · 되돌리기 커밋 1개

【작업】
1. 잡 `p2-k4`(이름 `키 API (K4 게이트, 다섯 DB·OmniRoute 3.8.51)`) 스텝 `run: node scripts/gate.mjs K4 --explain`. K4 `checks` 채움. 커밋.
2. `(사용자/메인 세션)` ruleset 필수 검사에 그 이름.
3. `gate K4 --seal` → 커밋 → PR → 머지 커밋.

【테스트】
```
TC-K4.T6.a  K4 게이트를 도는 CI 잡이 있다
  단언:  grep "^\s+run: node scripts/gate\.mjs K4\b" .github/workflows/ci.yml → 1 (G-K4.26). 봉인 뒤에는 TC-K0.T2.b 가 이 단계에 대해서도 "잡이 빠지면 stage-missing" 을 확인한다
  검출:  봉인 PR 에 잡을 빠뜨려, 병합 뒤 main 의 guard 잡(G-S7.1)이 처음 빨개지고 그 사이 이 단계 산출을 깨는 변경이 아무 잡에도 걸리지 않는 것
TC-K4.T6.b  ruleset 필수 검사가 이 잡을 포함한다
  단언:  node scripts/check-required-checks.mjs --repo henryj-dev/magnetosphere → 0 (G-K4.27)
  검출:  잡은 있으나 필수 검사가 아니라 빨간 채로 PR 이 병합되는 것
```

【통과】
- [ ] G-K4.26 · G-K4.27 통과

## 🚪 GATE K4

| id | 검사 | 명령 | 통과 기준 |
|---|---|---|---|
| G-K4.1 ~ 5 | TC-K4.T1.a ~ e | `pnpm -C apps/server test -t "TC-K4.T1.<x>"` | 각 통과 = 1. e 는 기본 최대 2 |
| G-K4.6 | TC-K4.T1.f 동시 발급 (Node DB 넷) | [L] `pnpm -C apps/server test:db -t "TC-K4.T1.f" --db sqlite,mysql,mariadb,pg` | 통과 = 4, 201 == 2 |
| G-K4.7 | TC-K4.T1.f 동시 발급 (D1) | [L] `pnpm -C apps/server test:workers -t "TC-K4.T1.f"` | 통과 = 1, 201 == 2 |
| G-K4.8 | TC-K4.T1.g · h 원문 미저장·이름 규칙 | `pnpm -C apps/server test -t "TC-K4.T1.[gh]"` | 통과 = 2, preview 4자리, 이름 `m_` + 8 + `_` + 8 |
| G-K4.9 | TC-K4.T1.i 남은 발급 가능 개수 | `pnpm -C apps/server test -t "TC-K4.T1.i"` | 통과 = 1 |
| G-K4.10 ~ 14 | TC-K4.T2.a ~ e | `pnpm -C apps/server test -t "TC-K4.T2.<x>"` | 각 통과 = 1 |
| G-K4.15 · 16 | TC-K4.T3.a · b | `pnpm -C apps/server test -t "TC-K4.T3.<x>"` | 각 통과 = 1 |
| G-K4.17 | TC-K4.T4.a CSRF | `pnpm -C apps/server test -t "TC-K4.T4.a"` | 통과 = 1 |
| G-K4.18 | TC-K4.T4.b 발급 요청 수 제한 | [L] `pnpm -C apps/server test:db -t "TC-K4.T4.b" --db sqlite,mysql,pg` | 통과 = 3 |
| G-K4.19 | TC-K4.T5.a 발급·끄기·삭제 | [L] `pnpm test:contract -t "TC-K4.T5.a"` | 통과 = 1, 끈 뒤 첫 요청 403 |
| G-K4.20 | TC-K4.T5.b 한도 0 발급 거부 | [L] `pnpm test:contract -t "TC-K4.T5.b"` | 통과 = 1 |
| G-K4.21 | 발급 순서 (5.2 의 2~5번) 기대값 | grep `"createKey", "setKeyActive\(false\)", "setBudget", "setKeyActive\(true\)"` in `apps/server/test/routes` | == 1 |
| G-K4.22 | 원문 키 저장 칼럼 없음 | grep `\b(key_raw\|raw_key\|secret_key)\b` in `packages/db/src/schema` | == 0 |
| G-K4.23 | 어댑터 밖 관리 호출 0 (1단계 G-S5.9 와 같은 규칙) | grep `/api/(keys\|usage)` in `apps packages`, `packages/omniroute/**` 제외 | == 0 |
| G-K4.24 | 시드 기본값 (최대 키 2, 월 한도 $5) | grep `default_limit_usd: 5,` · `default_max_keys: 2,` in `packages/db/src/seed.ts` | 각 == 1 |
| G-K4.25 | 타입 검사 | `pnpm -r typecheck` | 종료코드 0 |
| G-K4.26 | TC-K4.T6.a CI 단계 잡 | grep `^\s+run: node scripts/gate\.mjs K4\b` in ci.yml | == 1 |
| G-K4.27 | ruleset · TC-K4.T6.b | `node scripts/check-required-checks.mjs --repo henryj-dev/magnetosphere` | 종료코드 0 |

`node scripts/gate.mjs K4 --seal`

가장 중요한 검사는 G-K4.7 이다. D1 은 대화형 트랜잭션이 없어(3.2) 다른 네 DB 와 다른 경로로 최대 개수를 지킨다. 그 경로가 깨져도 Node 쪽 시험은 모두 초록이므로, Workers + D1 에서 동시 발급을 직접 재현하는 이 검사만 잡는다.

---

# K5 — 2단계 완료 기준 E2E 🔒 (K4 필요)

**브랜치** `p2/k5`.
**outputs** `tests/e2e/keys/**`, `tests/e2e/claude-code/**`. `tests/e2e/run.mjs`(1단계 S6)는 공용이라 넣지 않는다.

### ☐ K5.T1 — Claude Code 가 발급 키로 동작한다
선행 없음 · 산출 `tests/e2e/claude-code/**` · 되돌리기 커밋 1개

【작업】
1. `tests/e2e/claude-code/package.json`에 `@anthropic-ai/claude-code`를 정확한 버전으로 고정한다. docker-sqlite 묶음(Caddy 경유)에서 회원 키를 발급하고, 빈 임시 폴더에서 `ANTHROPIC_BASE_URL=<Caddy 주소>`, `ANTHROPIC_AUTH_TOKEN=<원문>`, 모델 `mka/claude-mock`, `--setting-sources project`로 `claude -p "say hi" --max-turns 1`(stdin 닫음)을 돈다 (V16 증거의 방식). 커밋.

【테스트】
```
TC-K5.T1.a  Claude Code 가 회원 앱이 발급한 키로 응답을 받는다
  단언:  종료코드 0, stdout 에 "hello from mock", Caddy 접근 기록에 POST /v1/messages 200, localhost:20128 접속 0
  검출:  Caddy 허용 목록·키 발급 순서·OmniRoute 키가 각각 시험에서는 맞는데 실제 도구가 쓰는 헤더(x-api-key 대신 Authorization)·경로 조합에서 401·404 가 나는 것
```

【통과】
- [ ] G-K5.1 · G-K5.2 통과

### ☐ K5.T2 — 여섯 조합 키 시나리오
선행 K5.T1 · 산출 `tests/e2e/keys/**`, `tests/e2e/run.mjs`(`--scenario keys` 인자만) · 되돌리기 커밋 1개

【작업】
1. `pnpm e2e --combo <조합> --scenario keys`: 1단계 흐름(설치·관리자) 뒤 회원을 만들고(DB 직접, 가입 정책은 3단계) 관리자 API 로 한도 $0.02·최대 키 2 → 시나리오 넷. 분배를 기다릴 때 Node 는 1분 경계를, Workers 는 `wrangler dev --test-scheduled`의 `/__scheduled?cron=*+*+*+*+*`를 쓴다. 조합마다 끝나면 내린다 (메모리 4GB). 커밋.

【테스트】
```
TC-K5.T2.a  끈 키는 거부된다 (여섯 조합)
  단언:  발급 → 요청 200 → POST /api/me/keys/:id/disable → 다음 요청 403 permission_denied
  검출:  조합마다 다른 DB 경로에서 disabled_reason 저장이 실패해 끄기 API 가 500 이거나 반영이 큐로만 가는 것
TC-K5.T2.b  여러 키로 나눠 써도 회원 한도에서 막힌다 (여섯 조합)
  단언:  키 둘로 번갈아 요청 → 회원 총 사용액이 한도($0.02)에 닿은 시각부터 125,000ms 안에 두 키 모두 isBudgetBlocked,
         그때 총 사용액 ≤ 0.02 × 2 + 0.004878
  검출:  한 조합의 분배 작업이 돌지 않는 것 (Workers crons 에 "* * * * *" 누락, MySQL 임대 판정 오류 등) — 그 조합에서만 한도가 안 걸린다
TC-K5.T2.c  삭제·재발급으로 한도가 초기화되지 않는다 (여섯 조합)
  단언:  b 뒤 두 키 삭제 → 새 발급 409 limit_exhausted. 한도 $0.04 로 올린 뒤 발급 → 그 키 예산 == 0.04 − 총 사용액 (오차 1e-6)
  검출:  삭제 키 사용액이 회원 합계에서 빠지는 조합(매핑 행 삭제, 분석 apiKeyIds 누락)
TC-K5.T2.d  재발급으로 한도가 초기화되지 않는다 (여섯 조합, V19 의존)
  단언:  한도 도달 뒤 남은 키 재발급 → 새 원문의 다음 요청 isBudgetBlocked
  검출:  재발급이 누적 지출 0 인 새 키를 만들어 한도를 다 쓴 회원이 다시 쓰는 것
```

【통과】
- [ ] G-K5.3 ~ G-K5.8 통과

### ☐ K5.T3 — CI 에서 키 시나리오를 E2E 매트릭스가 돈다
선행 K5.T2 · 산출 `.github/workflows/ci.yml`, `scripts/check-ci-matrix.mjs`, `test/fixtures/ci-guard/e2e-keys-missing.yml` · 되돌리기 커밋 2개 · 장치 요구 `Red: TC-K5.T3.a`

【작업】
1. 픽스처 `e2e-keys-missing.yml`(`# expect: combo-set`, 매트릭스 스텝에 `--scenario keys` 없음)과 `K5` 단계에 그 검사를 둔다. 꼬리줄 `Red: TC-K5.T3.a`. 커밋.
2. `check-ci-matrix.mjs`: 매트릭스 E2E 명령을 "S6 의 `pnpm e2e --combo <c>` 검사 + 봉인된 K5 의 `pnpm e2e --combo <c> --scenario keys` 검사"로 넓힌다. `e2e` 매트릭스 잡에 스텝 `run: pnpm e2e --combo ${{ matrix.combo }} --scenario keys`를 더한다. `K5` 잡은 G-K5.3~8 을 `--skip-ids`로 빼고(매트릭스가 같은 명령으로 돈다) 나머지를 돈다. 커밋.

【테스트】
```
TC-K5.T3.a  매트릭스가 키 시나리오를 빠뜨리면 잡는다
  단언:  check-ci-matrix --fixture test/fixtures/ci-guard/e2e-keys-missing.yml --expect 6 --expect-fail → 0 ([combo-set] 잡음)
  검출:  K5 잡이 --skip-ids 로 여섯 시나리오를 빼고 매트릭스에는 그 스텝이 없어, 완료 기준 E2E 가 CI 에서 하나도 안 도는 것
TC-K5.T3.b  실제 ci.yml 은 여섯 조합 모두 키 시나리오를 돈다
  단언:  check-ci-matrix --expect 6 → 0
  검출:  매트릭스 스텝 명령 오타로 시나리오 인자가 빠지는 것
```

【통과】
- [ ] G-K5.9 · G-K5.10 통과

### ☐ K5.T4 — K5 CI 잡과 봉인
선행 K5.T1 ~ K5.T3 · 산출 `.github/workflows/ci.yml` · 되돌리기 커밋 1개

【작업】
1. 잡 `p2-k5`(이름 `완료 기준 (K5 게이트, 키 시나리오는 e2e 잡)`) 스텝 `run: node scripts/gate.mjs K5 --explain --skip-ids G-K5.3,G-K5.4,G-K5.5,G-K5.6,G-K5.7,G-K5.8`. 커밋.
2. `(사용자/메인 세션)` ruleset 필수 검사에 그 이름.
3. `gate K5 --seal`(로컬은 여섯 조합 전부 돈다) → 커밋 → PR → 머지 커밋.

【테스트】
```
TC-K5.T4.a  K5 게이트를 도는 CI 잡이 있다
  단언:  grep "^\s+run: node scripts/gate\.mjs K5\b" .github/workflows/ci.yml → 1 (G-K5.11). 봉인 뒤에는 TC-K0.T2.b 가 이 단계에 대해서도 "잡이 빠지면 stage-missing" 을 확인한다
  검출:  봉인 PR 에 잡을 빠뜨려, 병합 뒤 main 의 guard 잡(G-S7.1)이 처음 빨개지고 그 사이 이 단계 산출을 깨는 변경이 아무 잡에도 걸리지 않는 것
TC-K5.T4.b  ruleset 필수 검사가 이 잡을 포함한다
  단언:  node scripts/check-required-checks.mjs --repo henryj-dev/magnetosphere → 0 (G-K5.12)
  검출:  잡은 있으나 필수 검사가 아니라 빨간 채로 PR 이 병합되는 것
```

【통과】
- [ ] G-K5.11 · G-K5.12 통과

## 🚪 GATE K5

| id | 검사 | 명령 | 통과 기준 |
|---|---|---|---|
| G-K5.1 | TC-K5.T1.a Claude Code | [L] `pnpm e2e --combo docker-sqlite --scenario claude-code` | 종료코드 0, 출력 "hello from mock" |
| G-K5.2 | Claude Code 버전 고정 | grep `"@anthropic-ai/claude-code": "[0-9]+\.[0-9]+\.[0-9]+"` in `tests/e2e/claude-code/package.json` | == 1 |
| G-K5.3 | TC-K5.T2.a~d docker-sqlite | [L] `pnpm e2e --combo docker-sqlite --scenario keys` | 종료코드 0 — 끈 뒤 첫 요청 403, 한도 반영 ≤ 125,000ms (지출 기록 60초 + 분배 1분 + 5초), 초과 폭 ≤ 0.02 × 2 + 0.004878, 삭제 뒤 발급 409 |
| G-K5.4 | 같음 docker-mysql | [L] `pnpm e2e --combo docker-mysql --scenario keys` | G-K5.3 과 같은 기준 |
| G-K5.5 | 같음 docker-pg | [L] `pnpm e2e --combo docker-pg --scenario keys` | G-K5.3 과 같은 기준 |
| G-K5.6 | 같음 workers-d1 | [L] `pnpm e2e --combo workers-d1 --scenario keys` | G-K5.3 과 같은 기준 |
| G-K5.7 | 같음 workers-mysql | [L] `pnpm e2e --combo workers-mysql --scenario keys` | G-K5.3 과 같은 기준 |
| G-K5.8 | 같음 workers-pg | [L] `pnpm e2e --combo workers-pg --scenario keys` | G-K5.3 과 같은 기준 |
| G-K5.9 | TC-K5.T3.a·b | `node scripts/check-ci-matrix.mjs --expect 6 && node scripts/check-ci-matrix.mjs --fixture test/fixtures/ci-guard/e2e-keys-missing.yml --expect 6 --expect-fail` | 종료코드 0 |
| G-K5.10 | 재현 빨강 TC-K5.T3.a | `node scripts/check-red.mjs --check G-K5.9 --since seal:K4` | 종료코드 0 |
| G-K5.11 | TC-K5.T4.a CI 단계 잡 | grep `^\s+run: node scripts/gate\.mjs K5\b` in ci.yml | == 1 |
| G-K5.12 | ruleset · TC-K5.T4.b | `node scripts/check-required-checks.mjs --repo henryj-dev/magnetosphere` | 종료코드 0 |

E2E 시나리오의 숫자: 한도 반영 ≤ 125,000ms = 지출 기록 60초 + 분배 주기 1분 + 분배 소요 5초(V15 p95 기준). 초과 폭 ≤ 한도 × 최대 키 2 + 요청 1건 0.004878 (계획서 5.3 "남은 한도 × 동시에 쓰는 키 수").

`node scripts/gate.mjs K5 --seal`

가장 중요한 검사는 G-K5.6 이다. Workers + D1 은 작업 실행(Cron Trigger), 트랜잭션(없음), 임대(Cron 겹침) 셋이 모두 Docker 와 다른 유일한 조합이라, 한도 차단이 이 조합에서만 따로 깨질 수 있다.

---

# K6 — 재발 방지와 잔재 회수 🔒 (K5 필요)

**브랜치** `p2/k6`.
**outputs** 없음 (검사와 문서만).

### ☐ K6.T1 — 임시 코드 회수
선행 없음 · 산출 없음 (검사만) · 되돌리기 해당 없음

【작업】
1. K1~K5 가 시험을 위해 넣은 주입점은 함수 인자(`now`, `fetch`, `signal`)만 허용한다. 환경 변수로 켜는 시험 갈림길·가짜 시계를 운영 코드에서 지운다. 꺼진 테스트·미구현 표식도 0 으로. 커밋.

【테스트】
```
TC-K6.T1.a  운영 코드에 시험 갈림길이 없다
  단언:  grep "process\.env\.(TEST_|E2E_|FAKE_|MG_TEST)|globalThis\.__test" in apps/server/src packages/*/src → 0
  검출:  E2E 에서 분배 주기를 줄이려고 넣은 환경 변수가 운영에 남아 누군가 켜면 1초마다 OmniRoute 예산을 두드리는 것
TC-K6.T1.b  건너뛴 테스트와 미구현 표식이 없다 (1단계 TC-S7.T3.a 와 같은 규칙, 2단계 경로 포함)
  단언:  G-S7.3 과 같은 grep in apps packages tests scripts test (빌드 산출·scripts/gate.test.mjs 제외) → 0
  검출:  .skip 으로 꺼진 계약 TC 때문에 K2·K3 GATE 가 expectPassed 를 줄여 맞춘 채 초록으로 보이는 것
```

【통과】
- [ ] G-K6.1 · G-K6.2 통과

### ☐ K6.T2 — 운영 문서에 5.3 한계
선행 없음 · 산출 `deploy/README.md` · 되돌리기 커밋 1개

【작업】
1. 계획서 5.3 "한계 (문서에 적는다)" 두 줄을 운영 문서에 옮긴다: 짧은 시간에 몰아 쓰면 대략 "남은 한도 × 동시에 쓰는 키 수"까지 넘을 수 있다(지출 기록 60초, 분배 1분), 비용은 OmniRoute 가격표 추정치다. 커밋.

【테스트】
```
TC-K6.T2.a  운영 문서에 한계 두 줄이 있다
  단언:  grep "남은 한도 × 동시에 쓰는 키 수" deploy/README.md → 1, grep "추정" deploy/README.md → ≥ 1
  검출:  운영자가 회원 한도를 결제 상한으로 믿고 초과분을 청구하거나 막지 못한 것을 장애로 보는 것
```

【통과】
- [ ] G-K6.3 통과

### ☐ K6.T3 — 2단계 전체 봉인·순서·필수 검사
선행 K6.T1 · K6.T2 · 산출 `.github/workflows/ci.yml` · 되돌리기 커밋 1개

【작업】
1. 잡 `p2-k6`(이름 `재발 방지 (K6 게이트)`) 스텝 `run: node scripts/gate.mjs K6 --explain`. K6 `checks` 채움. 커밋.
2. `(사용자/메인 세션)` ruleset 필수 검사에 그 이름.
3. `gate K6 --seal` → 커밋 → PR → 머지 커밋.

【테스트】
```
TC-K6.T3.a  K6 게이트를 도는 CI 잡이 있다
  단언:  grep "^\s+run: node scripts/gate\.mjs K6\b" .github/workflows/ci.yml → 1 (G-K6.8). 봉인 뒤에는 TC-K0.T2.b 가 이 단계에 대해서도 "잡이 빠지면 stage-missing" 을 확인한다
  검출:  봉인 PR 에 잡을 빠뜨려, 병합 뒤 main 의 guard 잡(G-S7.1)이 처음 빨개지고 그 사이 이 단계 산출을 깨는 변경이 아무 잡에도 걸리지 않는 것
TC-K6.T3.b  ruleset 필수 검사가 이 잡을 포함한다
  단언:  node scripts/check-required-checks.mjs --repo henryj-dev/magnetosphere → 0 (G-K6.7)
  검출:  잡은 있으나 필수 검사가 아니라 빨간 채로 PR 이 병합되는 것
TC-K6.T3.c  1·2단계 봉인이 모두 유효하고 처음 커밋부터 순서 위반이 없다
  단언:  gate --status --json → S0~S7·K0~K5 모두 sealed (G-K6.4·5), gate --assert-order --base <첫 커밋> → 0 (G-K6.6)
  검출:  어느 단계를 스쿼시로 병합해 봉인이 ⚠ 가 된 채 2단계를 끝났다고 보는 것, 잠긴 단계 산출을 먼저 고친 커밋이 이력에 남는 것
```

【통과】
- [ ] G-K6.4 ~ G-K6.8 통과

## 🚪 GATE K6

| id | 검사 | 명령 | 통과 기준 |
|---|---|---|---|
| G-K6.1 | TC-K6.T1.a 시험 갈림길 0 | grep `process\.env\.(TEST_\|E2E_\|FAKE_\|MG_TEST)\|globalThis\.__test` in `apps/server/src packages/auth/src packages/db/src packages/omniroute/src packages/runtime/src` | == 0 |
| G-K6.2 | TC-K6.T1.b 꺼진 테스트·미구현 표식 0 | G-S7.3 의 패턴, in `apps packages tests scripts test`, 같은 제외 | == 0 |
| G-K6.3 | TC-K6.T2.a 운영 문서 한계 | grep `남은 한도 × 동시에 쓰는 키 수` in `deploy/README.md` | == 1 |
| G-K6.4 | TC-K6.T3.c 2단계 봉인 모두 유효 | `node scripts/gate.mjs --status --json` 에서 K0~K5 | 모두 ✅ (⚠ 0) |
| G-K6.5 | TC-K6.T3.c 1단계 봉인도 유효 | 같은 출력에서 S0~S7 | 모두 ✅ |
| G-K6.6 | TC-K6.T3.c 처음 커밋부터 순서 위반 없음 | `node scripts/gate.mjs --assert-order --base "$(git rev-list --max-parents=0 HEAD)"` | 종료코드 0 |
| G-K6.7 | ruleset 필수 검사·머지 커밋만 · TC-K6.T3.b | `node scripts/check-required-checks.mjs --repo henryj-dev/magnetosphere` | 종료코드 0 |
| G-K6.8 | TC-K6.T3.a CI 단계 잡 | grep `^\s+run: node scripts/gate\.mjs K6\b` in ci.yml | == 1 |
| G-K6.9 | 어댑터 밖 관리 호출 0 (2단계 코드 포함) | G-K4.23 과 같음 | == 0 |

`node scripts/gate.mjs K6 --seal`

가장 중요한 검사는 G-K6.2 다. 2단계 GATE 는 `expectPassed`로 통과 수를 고정하지만, 테스트를 `.skip` 하고 `expectPassed`를 함께 줄이면 여전히 초록이 된다. 꺼진 테스트를 문자열로 잡는 이 검사가 그 우회를 막는 마지막 장치다.

---

## 최종 목표표

계획서 9장 2단계 완료 기준과 그 밑의 숫자를 옮긴 것이다.

| 지표 | 목표 | 검사 |
|---|---|---|
| **여러 키로 나눠 써도 회원 한도에서 차단되는 조합 수** | **6 / 6** | G-K5.3 ~ G-K5.8 (TC-K5.T2.b), 계약 G-K2.11 |
| Claude Code 가 발급 키로 동작 | 종료코드 0, "hello from mock" | G-K5.1 |
| 끈 키 거부 | 끈 직후 첫 요청 403 (6 / 6 조합) | G-K4.19, G-K5.3 ~ 8 (TC-K5.T2.a) |
| 삭제·재발급으로 한도 초기화 | 0 / 6 조합 | G-K5.3 ~ 8 (TC-K5.T2.c·d), G-K4.20 |
| 한도 반영 시간 | ≤ 125,000ms (지출 기록 60초 + 분배 1분 + 5초) | TC-K5.T2.b |
| 초과 폭 | ≤ 한도 × 최대 키 2 + 요청 1건 | G-K2.14, TC-K5.T2.b |
| 최대 키 기본값 | 2 (활성 + 비활성, 삭제 제외) | G-K4.5, G-K4.24 |
| 동시 발급 최대 개수 초과 | 0 (다섯 DB) | G-K4.6, G-K4.7 |
| 분배 주기 · 정합성 점검 주기 | 1분 · 5분 | G-K2.22, G-K2.23, G-K3.16, G-K3.17, G-K1.13 |
| 재시도 간격 | 10초 · 30초 · 2분 · 10분 (첫 반영 실패 뒤 10초) | G-K1.7, G-K1.17, G-K3.4 |
| 분석 API (기록 300,000 · 키 300) | 전체 p95 ≤ 5,000ms · 회원 p95 ≤ 1,000ms | G-K0.19 ~ G-K0.23 |
| 확인 항목 | 6 / 6, 설계 막음 0 | G-K0.13, G-K0.14 |
| 설계 공백 | 0 / 6 남음 | G-K0.28 |

최종 판정은 **여러 키 회원 한도 차단 6/6 조합**이다. 2단계에서 이 프로젝트가 새로 만드는 동작은 "키 단위 예산을 회원 단위 한도로 묶는 분배"이고, 끈 키 거부와 예산 차단 자체는 OmniRoute 가 하며 1단계 계약 시험이 이미 본다. 분배는 작업 실행(Node 타이머·Workers Cron)·임대·DB 방언을 모두 지나가므로, 여섯 조합에서 차단이 실제로 일어나는지가 나머지 지표를 모두 묶는다.

## 막혔을 때

- **게이트가 빨간데 원인을 모름**: `node scripts/gate.mjs <단계> --explain`. `test` 검사가 `통과 n / 기대 m`으로 실패하면 `-t` 패턴에 걸린 TC 목록을 먼저 본다 (이름이 바뀌었거나 skip 된 것).
- **봉인 뒤 회귀**: 봉인을 고치지 않는다. 고친 커밋을 올린 뒤 `--seal`을 다시 돈다 (R3). 스쿼시·리베이스로 병합해 봉인이 ⚠ 가 되면 그 단계부터 다시 봉인해야 한다 — 병합은 머지 커밋만.
- **확인 결과가 계획서와 다름 (K0)**: `V*.json`을 `blocking: true`로 두고 계획서를 개정한다. 개정 버전을 `resolved_in`에 적고 `blocking: false`. 이 문서의 해당 작업을 `(폐기)` + 새 번호로 바꾸고 `gates.config.mjs`는 그 단계 `checks`만 고친다 (잠긴 단계의 `outputs`는 못 고친다).
- **`--assert-order`가 2단계 단계를 이유로 거부**: 바꾼 파일이 아직 🔒 인 단계의 `outputs`에 걸렸다. 그 파일은 그 단계에서 고친다. 앞 단계가 꼭 고쳐야 하는 파일이면 계획을 잘못 나눈 것이니 이 문서를 개정한다 (그 단계 `outputs` 변경은 그 단계가 열린 뒤에만 된다).
- **잠긴 단계의 `outputs`를 아직 병합 안 된 브랜치에서 고쳐야 함**: pre-push 훅은 원격 브랜치 끝을 기준으로 잡아 그 시점에 잠긴 단계 설정 변경을 거부한다 (이 문서의 `p2/plan` 에서 실제로 겪었다). 봉인 파일이 없는 계획 브랜치라면 원격 브랜치를 지우고 다시 올린다 (기준이 `origin/main`이 된다). PR 은 `gh pr reopen`으로 다시 연다. `--no-verify`로 넘기지 않는다 — push 이벤트의 `gate.yml`이 같은 기준으로 다시 막는다.
- **Docker 메모리(4GB) 부족**: 계약 환경 OmniRoute·mock, 시험 DB 셋, mailpit 이 이미 떠 있다. V15 측정용 OmniRoute(20171)·E2E 묶음은 하나씩 띄우고 끝나면 내린다. `docker compose -f docker-compose.test.yml stop mariadb`로 당장 안 쓰는 DB 를 멈춘다.
- **amd64·arm64 결과가 다름**: 예산 차단 판정은 K0.T11 도우미만 쓴다. 상태코드가 다르면(429 가 아님) 빌드 차이가 차단 동작까지 번진 것이니 8단계로 미룬 digest 고정 결정을 앞당긴다.
- **분배가 1분 안에 안 끝남**: V15 `decision`과 G-K2.15 를 다시 잰다. 기준을 넘으면 계획서 5.3 실행 시점을 개정한다 (주기를 늘리면 G-K1.16·최종 목표표 "한도 반영 시간"도 같이 바뀐다).
- **일정 부족**: 단계를 건너뛰지 않는다. 면제 가능한 단계가 없다. 범위를 줄이려면 계획서를 개정하고 해당 작업을 `(폐기)`로 표시한다.
- **사용자 OmniRoute(`localhost:20128`)와 충돌**: 모든 시험은 20170(계약)·20171(측정)에서 돈다. 20128 을 쓰는 검사가 보이면 그 검사가 잘못된 것이다.

## 확인 결과에 기댄 TC 목록

| TC | 기대는 확인 결과 | 결과가 다르면 |
|---|---|---|
| TC-K0.T5.a | V12 공동 예산 유무 | 계획서 5.3 개정, K2 작업 교체 |
| TC-K0.T6.a | V13 거르기 파라미터 | 4단계 "최근 요청"이 어댑터에서 거름 (2단계 영향 없음) |
| TC-K0.T7.a, TC-K2.T3.h | V15 측정·호출 방식 | 계획서 5.3 실행 시점 개정 |
| TC-K0.T8.a, TC-K2.T3.e | V18 삭제 키 기록 유지 | 계획서가 대안(삭제 전 사용액 보존) 결정, K1 스키마 |
| TC-K0.T9.a, TC-K4.T2.c, TC-K5.T2.d | V19 regenerate id·지출 유지 | 계획서 5.2·5.9 개정, K1 스키마·K4 재발급 |
| TC-K0.T10.a·b·c, TC-K2.T2.a | V20 시간대·경계값 | 계획서 5.3 개정 (Q1 과 함께) |
| TC-K1.T3.b | Q3 재시도 소진 동작 | K0.T12 개정 내용 |
| TC-K2.T1.d, TC-K2.T3.f | Q1 사용액 0 키 처리 | K0.T12 개정 내용 |
| TC-K4.T4.b | Q4 발급 요청 수 숫자 | K0.T12 개정 내용 |

## 코드 미확인 TC 목록

1단계 코드(`packages/omniroute/src/index.ts`, `packages/runtime/src/{lease,node,workers,types}.ts`, `apps/server/src/{jobs,workers}.ts`, `apps/server/wrangler.toml`, `packages/db/src/schema/common.ts`·`seed.ts`, `scripts/gate.mjs`·`check-ci-matrix.mjs`·`check-verify.mjs`, `tests/contract/*`)는 열어 보고 검출줄에 그 사실을 적었다. 아래는 기대는 코드나 동작이 아직 없어 열어 보지 못한 것이다.

| TC | 열어 보지 못한 것 | 처음 확인되는 곳 |
|---|---|---|
| TC-K0.T10.c | OmniRoute 3.8.51 의 월 예산 기간 시작 계산 함수와 그 값을 읽는 방법 | K0.T10 (이미지 안 소스) |
| TC-K0.T7.a | OmniRoute 기록 저장 테이블(직접 삽입 시) | K0.T7 |
| TC-K1.T4.c | `wrangler dev --test-scheduled`의 `/__scheduled` 경로가 이 저장소 wrangler 버전에서 cron 별로 동작하는지 | K1.T4 |
| TC-K5.T1.a | 고정할 `@anthropic-ai/claude-code` 버전의 인자(`--setting-sources`, `--max-turns`)가 V16 때와 같은지 | K5.T1 |
| TC-K5.T2.a ~ d | `tests/e2e/run.mjs`에 `--scenario` 인자를 더할 자리 (지금은 조합 하나의 고정 흐름) | K5.T2 |
| TC-K4.T2.c | OmniRoute `POST /api/keys/{id}/regenerate` 응답 형식 (어댑터에 아직 없음) | K0.T9 (V19), K4.T2 |
