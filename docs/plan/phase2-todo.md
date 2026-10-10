# Magnetosphere 2단계 "키·한도" — 실행 목록

계획은 [`../design/omniroute-member-layer.md`](../design/omniroute-member-layer.md) (v5.7) 다. 이 문서는 그 9장 2단계의 순서 · 통과 조건 · 잠금만 적는다. 논거는 계획서 절 번호로 가리킨다.

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

**브랜치** `k0/verify` (실행판을 쓸 때 정한 이름은 `p2/k0`). 이 문서를 넣은 `p2/plan` 이 K0.T2 를 먼저 했다 (CI 를 초록으로 두려면 필요했다).
**outputs** 장치 스크립트·음성 대조, `docs/verify/V12·13·15·18·19·20.json`, `packages/omniroute/test/contract/verify/**`, `tests/bench/**`, 예산 차단 도우미. 확인 결과가 어떻든 이 경로 밖으로 나가지 않는다.

### ☑ K0.T1 — gate `test` 판정에 `expectPassed`
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
TC-K0.T1.e  grep 검사의 ^·$ 는 줄의 시작·끝이다 (작업 중 추가)
  단언:  둘째 줄 이후에 "        run: node scripts/gate.mjs K0 --explain" 이 있는 파일, 패턴 ^\s+run: node scripts/gate\.mjs K0\b · K0 --explain$ → 각각 1, PASS
  검출:  gate grep 이 new RegExp(pattern, "g") 라 ^ 가 파일 시작에만 걸려 G-K0.28·29·32 와 K1~K6 의 "CI 단계 잡" grep 이 늘 0 인 것 (이 브랜치 첫 CI 에서 G-K0.32 가 잡이 있는데도 0 으로 실패)
```

【통과】
- [x] G-K0.6 ~ G-K0.9 · G-K0.37 통과
- [x] G-K0.35 통과 (Red 커밋에서 TC-K0.T1.a 실패), G-K0.38 통과 (Red 커밋에서 TC-K0.T1.e 실패)

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

### ☑ K0.T3 — main 에서 앞 CI 실행을 취소하지 않는다 (S7 리뷰 L5)
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
- [x] G-K0.11 통과
- [x] G-K0.36 통과 (Red 커밋에서 G-K0.11 실패)

### ☑ K0.T4 — 확인 결과 검사기에 2단계 항목 묶음
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
- [x] G-K0.12 통과
- [x] `node --test --test-reporter=tap scripts/check-verify.test.mjs` 종료코드 0 (TC-S1.G.a~d 포함, G-K0.33)

### ☑ K0.T5 — V12 키 그룹·쿼터 풀 공동 예산
선행 K0.T4 · 산출 `docs/verify/V12.json`, `packages/omniroute/test/contract/verify/v12.contract.ts` · 되돌리기 커밋 1개

【작업】
1. OmniRoute 3.8.51 이미지 안의 OpenAPI 와 소스에서 키 묶음(그룹·풀·combo 예산 등) 경로를 찾는다. 있으면 계약 환경에서 키 둘을 한 묶음에 넣고 공동 예산을 걸어 본다. `V12.json`: `answer = { exists: bool, mechanism, api, sharedBlocking: bool|null }`. 커밋.
2. 결과가 `exists: true` 이고 둘 이상의 키 지출을 합쳐 막으면 `blocking: true`. 계획서 5.3 을 공동 예산 방식으로 개정(K0.T12 의 같은 개정 버전)하고, 이 문서의 K2 작업을 `(폐기)` + 새 번호로 개정한다. K2 `outputs`(`apps/server/src/limits/**` 등 새 경로)는 두 방식 모두를 덮는다. 결과가 `false`면 5.3 그대로 간다. 두 갈래를 미리 적지 않는다.
   (실제: `exists: true`·`sharedBlocking: true` — 쿼터 풀 일정 예산. 하지만 풀은 제공자 연결 하나에 묶이고 창이 슬라이딩이며 3.8.51 arm64 는 차단을 본문 없는 500 으로 내 회원 한도로 쓸 수 없다. 계획서 v5.6 5.3 은 "분배 유지"로 개정했고 K2 작업은 바꾸지 않았다.)

【테스트】
```
TC-K0.T5.a  V12 관찰이 V12.json answer 와 같다 (V12 의존)
  단언:  계약 환경에서 answer.api 경로 존재 여부와 sharedBlocking 재현 == V12.json (exists false 면 후보 경로가 404·405)
  검출:  OmniRoute 버전을 올려 공동 예산이 생기거나 없어졌는데 5.3 분배 방식이 그대로 남는 것
```

【통과】
- [x] G-K0.16 통과
- [x] G-K0.13 · G-K0.14 · G-K0.15 통과 (V12 포함)

### ☑ K0.T6 — V13 call-logs 를 키로 거르는 쿼리
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
- [x] G-K0.17 통과

### ☑ K0.T7 — V15 분석 API 성능 (5.3 이 1분마다 부른다)
선행 K0.T4 · 산출 `docs/verify/V15.json`, `tests/bench/analytics.mjs`, `tests/bench/docker-compose.yml` · 되돌리기 커밋 1개

【작업】
1. 측정용 OmniRoute 를 계약 환경과 따로 띄운다 (`127.0.0.1:20171`, 같은 digest, 데이터 볼륨 없음. 계약 환경의 분석 합계를 오염시키지 않으려고). 키 300개, 완료 기록 300,000건(계획서 "수십만 건, 키 수백 개"의 아래 끝을 고정값으로)을 넣는다. 넣는 방법(요청 / OmniRoute DB 직접 삽입)은 작업에서 정하고 `evidence`에 적되, 넣은 뒤 `analytics` 전체 `totalRequests == 300000`으로 확인한다. 측정 뒤 내린다 (Docker 메모리 4GB).
2. 두 호출을 각각 10번 잰다: 전체 키 한 달(필터 없음, `byApiKey`로 회원 묶음) · 회원 하나(키 2개, 그중 삭제 1개). `answer = { dataset: { records, keys }, fullMonth: { p95Ms, runs }, member: { p95Ms, runs }, arch, decision }`. `decision`은 분배가 쓸 호출 방식(전체 한 번 / 회원마다)이다. 기준을 넘으면 `blocking: true` 로 두고 계획서 5.3 실행 시점을 개정한다. 커밋.
   기준의 근거: 1분 작업의 임대는 55초(`period − 5_000`)이고 지출 기록이 60초 주기다. 전체 호출 p95 5,000ms 는 주기의 1/12 로, 분배 한 번이 예산 쓰기 300번을 더해도 임대 안에 끝난다.
   (실제: 필터 없는 전체 한 달 호출은 CI x64 세 번 p95 6,396ms·통과·6,104ms 로 기준 언저리·위였다. 사용자가 선택지 B 를 골랐다 (계획서 v5.7): 1분 분배는 오늘 창만 부르고 지난 날은 `usage_daily`에 저장, 하루 한 번 대조. 측정을 그 호출로 바꿨다 — 300,000건을 최근 30일에 하루 10,000건씩 넣고 오늘 창 p95 ≤ 2,000ms, 회원 하나 ≤ 1,000ms, 대조(지난 29일) ≤ 55,000ms. G-K0.21·23 은 `answer.todayWindow`, G-K0.39 는 `answer.reconcile`을 본다.)

【테스트】
```
TC-K0.T7.a  측정이 재현된다 (V15 의존)
  단언:  node tests/bench/analytics.mjs --assert → 넣은 기록 300,000(30일)·키 300·오늘 10,000 확인, 오늘 창 p95 ≤ 2,000ms, 회원 p95 ≤ 1,000ms, 대조(지난 29일) p95 ≤ 55,000ms, 10회씩. 종료코드 0 (v5.7, 처음 기준은 전체 한 달 p95 ≤ 5,000ms)
  검출:  분석 API 가 기록 수에 비례해 느려져 1분 분배가 다음 경계까지 안 끝나고, 두 인스턴스가 같은 회원 예산을 엇갈려 쓰는 것
```

【통과】
- [x] G-K0.18 ~ G-K0.23 · G-K0.39 통과

### ☑ K0.T8 — V18 삭제한 키의 기록이 분석에 남는가
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
- [x] G-K0.24 통과

### ☑ K0.T9 — V19 `regenerate`의 id·누적 지출·예산
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
- [x] G-K0.25 통과

### ☑ K0.T10 — V20 월 예산 시간대·초기화·달 중간 변경
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
  단언:  요청 1건(0.00221) 뒤 그 키 분석 비용 c 를 예산으로 → 다음 요청이 예산 차단인지 == answer.equalBlocks, 그다음 요청은 차단
         (처음엔 요청 3건이었다. OmniRoute 는 요청마다 더한 부동소수 합 0.014633000000000004 로 비교해 분석 비용 0.014633 을 걸면 '같음'이 아니라 '넘음'이 된다)
  검출:  남은 한도 0 인 회원의 키 예산을 "그 키 사용액"으로 걸었는데 OmniRoute 가 '>' 로 비교해 계속 통과시키는 것
TC-K0.T10.c  기간 시작 시각이 answer.timezone 기준이다 (V20 의존, 코드 미확인)
  단언:  OmniRoute 예산 조회 응답(또는 소스에서 찾은 계산 함수를 이미지 안 node 로 부른 값)의 기간 시작 == answer.timezone 의 이번 달 1일 00:00
  검출:  회원 앱이 UTC 로 달을 자르고 OmniRoute 는 다른 시간대로 잘라 매달 첫 몇 시간 동안 예산과 사용액 기간이 어긋나는 것
```

【통과】
- [x] G-K0.26 통과

### ☑ K0.T11 — 예산 차단 판정 도우미 (amd64·arm64)
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
- [x] G-K0.27 통과

### ☑ K0.T12 — 계획서 개정 v5.6 (설계 공백 Q1~Q6 과 확인 결과)
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
   (실제: v5.6 에 Q1~Q6·V12·V13·V18·V19·V20 을, V15 결정(선택지 B)을 v5.7 에 넣었다. `was_blocking` 파일의 `resolved_in`은 현재 버전 v5.7 이다 — G-K0.15 가 현재 버전과 같기를 요구한다.)

【테스트】
```
TC-K0.T12.a  계획서 개정이 공백 여섯을 모두 닫는다
  단언:  grep "^- v5\.6: .*Q1.*Q2.*Q3.*Q4.*Q5.*Q6" 계획서 → 1, 상태 줄 v5.6 이상 → 1, check-verify resolved --set phase2 → 0
  검출:  Q1 을 남긴 채 K2 를 열어 남은 한도 0 인 회원의 새 키(사용액 0)가 예산 없이 무제한으로 쓰이는 것
```

【통과】
- [x] G-K0.28 · G-K0.29 · G-K0.15 통과

### ☑ K0.T13 — 필수 검사·병합 방식 대조
선행 K0.T2 · 산출 `scripts/check-required-checks.mjs`, `test/check-required-checks.test.mjs`, `test/fixtures/required-checks/**` · 되돌리기 커밋 1개

【작업】
1. `check-required-checks.mjs --repo <owner/name> [--rules <json 파일>]`: `gh api repos/<repo>/rules/branches/main`의 `required_status_checks` 문맥 ⊇ `.github/workflows/*.yml`의 잡 표시 이름(`name`, 매트릭스 `${{ matrix.combo }}`는 펼침) 이고, `pull_request.allowed_merge_methods == ["merge"]`인지 본다. `--rules`는 음성 대조용 파일 입력. CI 단계 잡에는 `GH_TOKEN: ${{ github.token }}`을 준다. 커밋.
2. `(사용자/메인 세션)` main ruleset 의 `allowed_merge_methods`를 `merge` 하나로 줄인다 (지금 `merge`·`squash`·`rebase` 셋 다 허용 — 2026-10-10 `gh api` 로 확인). K0 잡 이름을 필수 검사에 넣는다. 이후 단계마다 같은 일을 한다.
   (실제: `allowed_merge_methods`는 K0 작업 전에 `["merge"]`로 줄었다. K0 잡 이름은 PR 병합 전에 메인 세션이 넣는다.)

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
- [x] G-K0.30 · G-K0.31 통과

### ☑ K0.T14 — 재현 빨강 확인 장치
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
- [x] G-K0.34 통과

### ◐ K0.T15 — K0 CI 잡과 봉인
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
| G-K0.37 | TC-K0.T1.e grep 줄 단위 | `… --test-name-pattern="TC-K0.T1.e" scripts/gate.test.mjs` | 통과 = 1 |
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
| G-K0.21 | V15 오늘 창 분석 (v5.7) | json `answer.todayWindow.p95Ms` | ≤ 2,000 |
| G-K0.22 | V15 회원 하나 분석 | json `answer.member.p95Ms` | ≤ 1,000 |
| G-K0.23 | V15 측정 횟수 | json `answer.todayWindow.runs` | ≥ 10 |
| G-K0.39 | V15 하루 한 번 대조 (지난 29일) | json `answer.reconcile.p95Ms` | ≤ 55,000 (1분 작업 임대) |
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
| G-K0.38 | 재현 빨강 TC-K0.T1.e | `node scripts/check-red.mjs --check G-K0.37 --since seal:S7` | 종료코드 0 |

`node scripts/gate.mjs K0 --seal`

가장 중요한 검사는 G-K0.14 다. 확인 항목 여섯 중 V12(공동 예산)·V18(삭제 키 기록)·V19(재발급 누적)·V20(경계값) 넷이 5.3 분배 방식의 전제다. 하나라도 계획서와 다르면 K2·K4 를 지금 계획대로 만드는 일이 통째로 헛일이 되므로, 설계를 막는 결과가 남은 채로는 K1 이 열리지 않아야 한다. 장치 쪽에서는 G-K0.4 다 — `TC-S0.T2.d`가 검사 종류마다 이빨이 있음을 다시 보이지 못하면 이 문서의 모든 GATE 가 장식이다.

---

# K1 — 작업 기반: 임대·작업 큐·주기 등록 🔓 (K0 필요)

**브랜치** `p2/k1`.
**outputs** `packages/db/migrations/*/0001_*`, `packages/runtime/test/lease-fence/**`, `apps/server/src/queue/**`, `apps/server/test/queue/**` (새 경로만, 0절). 이 단계가 고치는 기존 파일(`lease.ts`·`node.ts`·`workers.ts`·`types.ts`, `packages/db/src/schema/**`, `apps/server/src/jobs.ts`, `apps/server/wrangler.toml`)은 `outputs`에 없다. 스키마 변경(V19 결과의 `api_keys` 칼럼 포함)은 모두 이 단계가 한다.

### ☑ K1.T1 — `job_leases` 펜싱 토큰 칼럼
선행 없음 · 산출 `packages/db/src/schema/**`, `packages/db/migrations/{sqlite,mysql,pg}/0001_*` · 되돌리기 커밋 1개

【작업】
1. 공통 정의 `jobLeases`에 `fence`(정수, NOT NULL, 기본 0)를 더하고 세 벌 생성·마이그레이션을 만든다. 같은 커밋에 계획서 v5.6 의 스키마 변경을 넣는다: `omniroute_jobs.failed_at`(시각, NULL 허용, Q3), `api_keys.disabled_reason` 설명에 `limit`(Q1, 칼럼 길이 16 그대로). V19 결과로 `api_keys` 칼럼 변경은 없다 (재발급이 새 키 발급 + 옛 키 삭제라 매핑을 바꾸지 않는다). 커밋.
2. (K1 리뷰 #1·#6, 재검토) 같은 0001 에 `omniroute_jobs.generation`(합칠 때마다 + 1, 정수 NOT NULL 기본 0)·`interrupts`(임대를 잃어 끊긴 횟수, 같은 모양)·`omniroute_jobs.key_id`(대상 `api_keys.id`, NULL 허용, 색인 `(key_id, done_at)`)와 `job_leases.last_slot`(마지막으로 돈 경계 번호, bigint, NULL 허용)을 더한다. 병합 전이라 0001 을 다시 만든다. 커밋.
3. (K1 리뷰 #10) 구조 비교(TC-S2.T3.d)의 SQL 정규화는 따옴표 밖에서만 공백을 맞춘다. 재현 커밋 `Red: TC-K1.T1.c` → 고침.

【테스트】
```
TC-K1.T1.a  다섯 DB 빈 상태 → 최신 마이그레이션에 fence·failed_at 칼럼이 있다
  단언:  test:migrate --db sqlite,mysql,mariadb,pg,d1 → job_leases.fence 정수 NOT NULL 기본 0·last_slot NULL 허용, omniroute_jobs.failed_at 시각·key_id NULL 허용, 기존 행이 있는 DB 에 0001 적용 뒤 fence = 0·나머지 NULL
  검출:  한 DB 의 마이그레이션만 빠져 그 DB 에서 acquireLease 가 "no such column fence" 로 주기 작업 전체가 멈추는 것
TC-K1.T1.c  구조 비교 정규화는 문자열 리터럴 안의 공백을 바꾸지 않는다 (K1 리뷰 #10)
  단언:  norm("… DEFAULT 'a, b' …") ≠ norm("… DEFAULT 'a,b' …"), 따옴표 밖의 괄호·쉼표 둘레 공백은 같게 본다
  검출:  norm 이 리터럴 안의 ", ( )" 둘레 공백까지 지워, 기본값 'a, b' 가 마이그레이션에서 'a,b' 로 바뀌어도 TC-S2.T3.d 가 초록인 것
TC-K1.T1.b  마이그레이션과 생성 스키마가 같다
  단언:  pnpm -C packages/db gen && git diff --exit-code packages/db/src/schema/ → 0, pnpm -C packages/db check:drift → 0
  검출:  공통 정의만 고치고 생성물·마이그레이션을 안 만들어 Drizzle 이 없는 칼럼에 쓰는 것
```

【통과】
- [x] G-K1.1 · G-K1.2 · G-K1.22 통과
- [x] G-K1.36 통과 (Red 커밋에서 TC-K1.T1.c 실패)

### ☑ K1.T2 — 임대 하트비트·펜싱 (S4 보안 리뷰 L4)
선행 K1.T1 · 산출 `packages/runtime/src/lease.ts`, `packages/runtime/src/node.ts`, `packages/runtime/src/workers.ts`, `packages/runtime/test/lease-fence/**` · 되돌리기 커밋 2개 · 장치 요구 `Red: TC-K1.T2.a`

【작업】
1. TC-K1.T2.a 를 넣는다 (지금 `acquireLease`는 한 번 잡고 늘리지 않으므로 빨강). 꼬리줄 `Red: TC-K1.T2.a`. 커밋.
2. `acquireLease`는 잡으면 `{ fence }`(잡을 때마다 `fence + 1`)를 돌려준다. `renewLease(name, holder, fence, ttl)`은 같은 holder·fence 일 때만 늘린다. Node `schedule()`은 작업 중 `ttl / 3`마다 늘리고, 늘리기에 실패하면 작업에 넘긴 `AbortSignal`을 끊는다. `fenced(h, name, fence)` 조건을 DB 쓰기(`api_keys.budget_usd`·`sync_state`, `omniroute_jobs`)에 붙인다. Workers 는 Cron 호출이 겹칠 수 있으므로(1분 작업이 1분을 넘기면) 같은 임대를 쓴다. 커밋.
3. (K1 리뷰 #3) `renew` 하나에 ttl/3 시간 제한, 마지막 갱신 성공 + ttl − ttl/6 을 로컬 마감으로 두고 지나면 신호를 끊는다. `Red: TC-K1.T2.e` → 고침.
4. (K1 리뷰 #6) 주기 작업은 경계 번호(경계 시각 / 주기, 반올림)를 넘기고 `acquireLease`는 `last_slot < slot`일 때만 잡아 `last_slot = slot`으로 둔다. 같은 경계는 같은 holder 라도 다시 돌지 않는다 (K2 분배가 이것에 기댄다). `Red: TC-K1.T2.f` → 고침.
5. (K1 리뷰 #7) `fenced()` 서브쿼리를 공유 잠금으로 읽는다: Postgres `FOR SHARE`, MySQL·MariaDB `LOCK IN SHARE MODE`(MariaDB 10.11 은 `FOR SHARE` 문법 오류), SQLite·D1 은 쓰기가 직렬화되어 그대로. 커밋.

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
TC-K1.T2.e  DB 응답이 멈춰도 ttl 안에 작업 신호가 끊긴다 (K1 리뷰 #3)
  단언:  renew 가 영원히 기다리는 가짜 연결, ttl 300ms → 시작부터 300ms 안에 signal.aborted, 이유 LeaseLostError
  검출:  holdLease 의 renew 에 시간 제한이 없고 기다리는 동안 beating 이 true 라, DB 가 멈추면 임대가 만료된 뒤에도 작업이 계속 돌아 새 임대자와 함께 쓰는 것
TC-K1.T2.f  주기 경계 하나는 한 번만 돈다 (K1 리뷰 #6)
  단언:  runLeased(A, 경계 n) 두 번 → 한 번만 실행, 만료 뒤 B 가 경계 n → 실행 안 함, 경계 n+1·n+2 → 실행 (네 DB)
  검출:  takeable 이 "만료됐거나 내 임대"라 같은 holder 의 타이머가 같은 경계에서 다시 울리면 분배가 두 번 도는 것
TC-K1.T2.d  fence 는 같은 이름에서 엄격히 증가한다
  단언:  같은 이름을 holder 바꿔 10번 잡음 → fence 10개가 엄격 증가 (네 DB)
  검출:  MySQL INSERT IGNORE 경로(RETURNING 없음)에서 fence 를 다시 읽지 않아 두 임대자가 같은 fence 를 받는 것
```

【통과】
- [x] G-K1.3 ~ G-K1.6 · G-K1.23 · G-K1.24 통과
- [x] G-K1.18 · G-K1.30 · G-K1.31 통과 (Red 커밋에서 TC-K1.T2.a·e·f 실패)

### ☑ K1.T3 — 작업 큐 `omniroute_jobs` 와 재시도
선행 K1.T2 · 산출 `apps/server/src/queue/**`, `apps/server/test/queue/**` · 되돌리기 커밋 1개

【작업】
1. `enqueue(action, payload, { runAt? })` · `runDue(now)`(done_at·failed_at NULL 이고 next_run_at ≤ now, 펜싱 아래 한 건씩 차지) · 핸들러 표(`key.apply_state`, `key.delete`, `budget.set`, `key.rollback`). 실패하면 `attempts + 1`, 다음 간격 `[60_000, 120_000, 600_000, 1_800_000]`ms (계획서 v5.6 Q2: 1분·2분·10분·30분, 실행기 최소 주기 1분). 4번째 재시도도 실패하면 `failed_at = now`, 대상 키 `sync_state = failed`, `audit_log` action `alert.job_failed` 1행 (Q3·Q6). `isLongFailed(job, now)` = failed_at 이 30분보다 오래됨 (Q3, 화면은 7단계). `key.delete` 는 `runAt` 으로 끈 시각 + 2분 뒤에 잡는다 (v5.6 5.2, V18). `last_error`에는 OmniRoute 오류 코드·상태만 남기고 원문 키·토큰은 지운다. 커밋.
2. (K1 리뷰 #1) `key.apply_state`는 값을 싣지 않는다 (payload `{ keyId }`). 핸들러가 실행할 때 `api_keys`·회원 상태로 목표를 다시 계산해 걸고(`queue/target.ts`, 5.7 목표 상태 함수의 **최소 형태**: `api_keys.state`·`user.status` 만. 남은 한도·`disabled_reason` 규칙은 K3.T1 이 넓힌다), 건 뒤 다시 읽어 바뀌었으면 한 번 더 건다. 같은 키의 미완료 `key.apply_state`가 있으면 새로 넣지 않는다(합치기). 같은 키에 미완료 `key.delete`가 있으면 켜지 않는다(delete 가 이긴다). `Red: TC-K1.T3.f` → 고침.
3. (K1 리뷰 #2) 다음 시도는 **실패 시각** + 간격, 차례 비교는 `next_run_at ≤ now + 30초`(실행기 주기의 절반). `Red: TC-K1.T3.a`(개정) → 고침.
4. (K1 리뷰 #4) `failed_at`·키 `sync_state`·`alert.job_failed`를 한 트랜잭션(D1 은 batch)으로, 펜싱 조건과 함께 쓴다. 알림을 못 쓰면 셋 다 되돌리고 차지 시각 뒤 다시 실패 처리한다 (알림 없는 failed 를 남기지 않는다). 작업 하나의 결과 쓰기 예외는 그 작업에서 잡아 `errors`로 센다. `Red: TC-K1.T3.g` → 고침.
5. (K1 리뷰 #5) payload 가 JSON 객체가 아니거나 모르는 작업이면 재시도 없이 곧바로 failed. `Red: TC-K1.T3.h` → 고침.
6. (K1 리뷰 #8) 임대를 잃어 신호가 끊긴 시도는 세지 않는다: 차지를 풀어 `attempts`·`next_run_at`을 되돌린다. `Red: TC-K1.T3.i` → 고침.
7. (K1 재검토 높음) 합치기는 `generation + 1`, `attempts = 0`, `next_run_at = min(기존, 지금)`. 완료·재시도·실패·차지 풀기 쓰기는 차지할 때 읽은 `generation`이 그대로일 때만 하고, 0행이면 시도로 세지 않고 `stale`로 센다 (합치기가 next_run_at 을 당겨 두어 곧바로 다시 돈다). `Red: TC-K1.T3.j, TC-K1.T3.k` → 고침.
8. (K1 재검토 중간) `attempts`가 재시도 표 길이 + 2 를 넘은 작업은 핸들러 없이 실패 처리만 시도하고, 그것도 실패하면 경보(`onAlarm`, console.error). `Red: TC-K1.T3.l` → 고침.
9. (K1 재검토 중간) 끊김은 `interrupts`로 따로 센다. `MAX_INTERRUPTS`(5) 번 끊긴 작업은 다음 차지가 핸들러 없이 failed·alert. `Red: TC-K1.T3.m` → 고침.
10. (K1 재검토 중간) `key.*` 작업은 모두 `keyId` 필수 (없으면 TypeError). `Red: TC-K1.T3.n` → 고침.
11. (K1 재검토 낮음) 핸들러는 `Object.hasOwn(handlers, action)`인 함수만. `Red: TC-K1.T3.o` → 고침. 경계 번호는 예약한 경계 시각(Workers `controller.scheduledTime`, Node 예약 경계)에서 정한다.

【테스트】
```
TC-K1.T3.a  재시도 간격은 1분·2분·10분·30분이다 (Q2 의존, K1 리뷰 #2 개정)
  단언:  늘 실패하는 핸들러, 1분 경계 tick 에 0~20초 지연(고정 씨앗 20개) → 시도는 0·1·3·13·43분 경계, 실패 시각 대비 next_run_at 차이 == 60000, 120000, 600000, 1800000 ms, 4번째 재시도 실패 뒤 failed_at 설정
  검출:  간격 표 순서·단위를 틀리는 것, 그리고 next_run_at 을 실행 시작 + 간격으로 잡고 유예 없이 비교해 다음 tick 지연이 더 작으면 한 주기를 건너뛰는 것 (1분이 2분이 된다)
TC-K1.T3.b  재시도를 다 써도 실패하면 대상 키가 failed 로 드러난다 (Q3 의존)
  단언:  4번째 재시도 실패 → 작업 failed_at 설정·runDue 대상에서 빠짐, 대상 api_keys.sync_state "failed", audit_log 에 action "alert.job_failed" 1행(target 작업 id), isLongFailed 는 failed_at + 30분 − 1ms 에 false · + 30분 + 1ms 에 true
  검출:  실패 작업이 조용히 30분 간격으로 영원히 남아 정지가 반영 안 된 회원 키가 계속 켜져 있는데 아무도 모르는 것
TC-K1.T3.c  두 실행기가 동시에 돌아도 작업마다 핸들러는 한 번이다
  단언:  작업 20개, 실행기 둘 동시 runDue → 작업마다 핸들러 호출 정확히 1 (sqlite·mysql·mariadb·pg)
  검출:  두 인스턴스가 같은 key.rollback 을 동시에 돌려 DELETE 를 두 번 보내고, 두 번째 404 를 실패로 세어 재시도가 쌓이는 것
TC-K1.T3.d  성공한 작업은 done_at 이 찍히고 다시 돌지 않는다
  단언:  성공 → done_at 설정, attempts 1, 다음 runDue 에서 호출 0
  검출:  done_at 을 안 찍어 매 실행마다 같은 PATCH 를 다시 보내는 것
TC-K1.T3.f  오래된 켜기 재시도가 새 끄기를 덮지 않는다 (K1 리뷰 #1)
  단언:  T0 켜기 작업 503 → T0+30초 회원이 끄고 즉시 끄기 성공(같은 키 작업은 합쳐져 1개) → T0+1분 재시도 → OmniRoute 키 꺼짐. 차지한 실행기가 멈춘 채 CLAIM_MS 뒤 다시 집혀도 꺼짐, 깨어난 옛 실행기의 완료 쓰기 0행 (네 DB)
  검출:  key.apply_state 가 넣을 때의 payload.active 를 걸어, 실행기가 next_run_at 순서로만 집는 사이 회원이 끈 키가 옛 재시도로 다시 켜지는 것
TC-K1.T3.g  실패 표시와 알림은 함께 남거나 함께 되돌려진다 (K1 리뷰 #4)
  단언:  마지막 시도만 남은 작업 + 다음 작업, audit_log 삽입 실패 → failed_at NULL·sync_state 그대로·다음 작업은 돎·runDue 예외 없음, 알림이 돌아온 뒤 CLAIM_MS 지나 → failed_at·sync_state failed·alert 1행 (네 DB)
  검출:  failed_at UPDATE 뒤 알림 삽입이 따로 실패해 알림 없는 failed 가 남고, 예외가 runDue 밖으로 나가 그 tick 의 남은 작업이 멈추는 것
TC-K1.T3.h  망가진 payload 는 곧바로 failed 로 두고 큐를 끊지 않는다 (K1 리뷰 #5)
  단언:  payload "{broken" 작업 → 핸들러 호출 0·attempts 1·failed_at·last_error "payload JSON 아님"·sync_state failed·alert 1행, 같은 tick 의 다음 작업 실행
  검출:  JSON.parse 가 try 밖이라 SyntaxError 가 tick 마다 큐 전체를 끊는 것
TC-K1.T3.i  임대를 잃어 끊긴 실행은 재시도 횟수를 쓰지 않는다 (K1 리뷰 #8)
  단언:  핸들러 도중 다른 실행기가 임대를 가져가 신호가 끊김 → 그 작업 attempts 0·next_run_at 원래 값·last_error NULL, 다음 작업은 집지 않음
  검출:  차지할 때 늘린 attempts 가 펜싱에 막혀 그대로 남아, 임대 다툼이 잦으면 OmniRoute 는 멀쩡한데 작업이 failed 로 가는 것
TC-K1.T3.j  실행 중인 반영 작업에 끄기가 합쳐져도 키가 꺼진다 (K1 재검토 높음)
  단언:  핸들러가 켜기를 건 뒤·완료 쓰기 전에 회원이 끄고 즉시 반영 503 → enqueue 는 그 작업에 합쳐짐 → OmniRoute 키 꺼짐, 미완료 0, 완료 쓰기 0행은 stale 1 (네 DB)
  검출:  미완료 조건이 실행 중인 작업에도 맞아 id 만 돌려받고, 그 작업이 done 으로 끝나 회원이 끈 키가 켜진 채 남는 것
TC-K1.T3.k  재시도 대기 중인 반영 작업에 끄기가 합쳐지면 바로 돌고 시도 횟수를 새로 센다 (K1 재검토 높음)
  단언:  켜기 세 번 실패(다음 시도 10분 뒤) → 끄기 enqueue 가 합쳐짐 → attempts 0·next_run_at ≤ 지금 → 그 시각 runDue 로 OmniRoute 키 꺼짐 (네 DB)
  검출:  끄기가 기존 작업의 대기(최대 30분)와 남은 시도를 같이 써, 그 작업이 최종 실패하면 끄기가 큐에서 처리되지 않는 것
TC-K1.T3.l  실패 처리가 계속 실패해도 OmniRoute 호출을 끝없이 되풀이하지 않는다 (K1 재검토 중간)
  단언:  attempts = 재시도 표 길이 + 2 인 작업, audit_log 삽입 실패 → 핸들러 호출 0·onAlarm 1·failed_at NULL, 알림 저장이 돌아온 뒤 CLAIM_MS 지나 → 핸들러 호출 0·failed_at 설정
  검출:  실패 처리 트랜잭션이 매번 되돌려져 약 5분마다 다시 차지되고 OmniRoute 호출부터 다시 도는 것
TC-K1.T3.m  매번 임대를 잃는 작업은 5번 끊긴 뒤 failed 다 (K1 재검토 중간)
  단언:  끊길 때마다 attempts 0·next_run_at 원래 값·interrupts + 1, 5번 끊긴 뒤 다음 차지 → 핸들러 호출 없이 failed·last_error "임대를 5번 잃음"·alert 1행 (네 DB, 차지 풀기의 next_run_at 비교 포함)
  검출:  끊긴 시도를 세지 않아(리뷰 #8) 매번 임대를 잃는 작업이 영원히 도는 것, MySQL·PG 시각 비교가 어긋나 차지 풀기가 0행이 되는 것
TC-K1.T3.n  key.* 작업은 keyId 없이 넣을 수 없다 (K1 재검토 중간)
  단언:  key.delete·key.rollback·key.apply_state 를 keyId 없이(빈 문자열 포함) → TypeError·행 0, keyId 가 있으면 key_id 칼럼에 남고 미완료 key.delete 가 켜기를 막는다
  검출:  key_id NULL 인 key.delete 가 delete 우선 검사에 잡히지 않아 반영이 지울 키를 켜는 것
TC-K1.T3.o  핸들러 표 밖의 action 은 프로토타입 함수로 돌지 않는다 (K1 재검토 낮음)
  단언:  action "toString"·"constructor"·"hasOwnProperty" → done 이 아니라 failed "모르는 작업"
  검출:  handlers[action] 참·거짓으로 고르면 Object.prototype.toString 이 핸들러로 불려 작업이 done 이 되는 것
TC-K1.T3.e  last_error 에 비밀 값이 없다
  단언:  오류 본문에 "oma_live_x…"·"sk-x…" 를 담은 OmniRouteError → last_error 에 "oma_live_"·"sk-" 0건
  검출:  OmniRouteError.message 가 응답 본문 300자를 담아(어댑터 call()) 관리 토큰이 DB 에 평문으로 남는 것
```

【통과】
- [x] G-K1.7 ~ G-K1.11 · G-K1.17 · G-K1.25 ~ G-K1.28 통과
- [x] G-K1.29 · G-K1.32 ~ G-K1.35 통과 (Red 커밋에서 TC-K1.T3.a·f·g·h·i 실패)
- [x] G-K1.37 ~ G-K1.42 · G-K1.43 ~ G-K1.48 통과 (TC-K1.T3.j~o 와 그 Red 커밋)

### ☑ K1.T4 — 주기 작업 등록 (1분 분배·5분 정합성·큐 실행기)
선행 K1.T3 · 산출 `apps/server/src/jobs.ts`, `apps/server/wrangler.toml`, `packages/runtime/src/types.ts` · 되돌리기 커밋 1개

【작업】
1. `JOBS`에 `omniroute_jobs` 실행기(1분, `* * * * *`, 계획서 v5.6 Q2)를 등록한다. 분배(`budget_rebalance`, `* * * * *`)는 K2.T6, 정합성 점검(`reconcile`, `*/5 * * * *`)은 K3.T3 이 본문과 함께 등록한다 — 본문 없는 작업을 main 에 등록하지 않는다. `wrangler.toml [triggers] crons`를 `JOBS` cron 집합과 같게 두고, 이 같음을 TC-K1.T4.b 가 뒤 단계에서도 계속 본다. 커밋.

【테스트】
```
TC-K1.T4.a  작업 큐 실행기가 1분 주기로 등록된다 (Q2 의존)
  단언:  JOBS 에 name "omniroute_jobs" 하나, cron "* * * * *" (Node 는 1분 경계 타이머, Workers 는 "* * * * *" Cron)
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
- [x] G-K1.12 ~ G-K1.16 통과

### ◐ K1.T5 — K1 CI 잡과 봉인
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
| G-K1.1 | TC-K1.T1.a 다섯 DB fence·last_slot·failed_at·key_id 칼럼 | [L] `pnpm -C packages/db test:migrate -t "TC-K1.T1.a" --db sqlite,mysql,mariadb,pg,d1` | 통과 = 5 (TC 1 × DB 5) |
| G-K1.2 | TC-K1.T1.b 생성물·드리프트 | `pnpm -C packages/db gen && git diff --exit-code packages/db/src/schema/ && pnpm -C packages/db check:drift` | 종료코드 0 |
| G-K1.3 | TC-K1.T2.a 하트비트 | [L] `pnpm -C packages/runtime test:db -t "TC-K1.T2.a" --db sqlite,mysql,mariadb,pg` | 통과 = 4 |
| G-K1.4 | TC-K1.T2.b 펜싱 쓰기 | [L] 같은 실행기, `TC-K1.T2.b` | 통과 = 4 |
| G-K1.5 | TC-K1.T2.c 신호 끊김 | `pnpm -C packages/runtime test -t "TC-K1.T2.c"` | 통과 = 1 |
| G-K1.6 | TC-K1.T2.d fence 증가 | [L] `… test:db -t "TC-K1.T2.d" --db sqlite,mysql,mariadb,pg` | 통과 = 4 |
| G-K1.7 | TC-K1.T3.a 재시도 간격 (tick 지연 포함) | `pnpm -C apps/server test -t "TC-K1.T3.a"` | 통과 = 1, 간격 60,000·120,000·600,000·1,800,000ms, 시도 0·1·3·13·43분 경계 |
| G-K1.8 | TC-K1.T3.b 재시도 소진 | `pnpm -C apps/server test -t "TC-K1.T3.b"` | 통과 = 1 |
| G-K1.9 | TC-K1.T3.c 동시 실행기 | [L] `pnpm -C apps/server test:db -t "TC-K1.T3.c" --db sqlite,mysql,mariadb,pg` | 통과 = 4 |
| G-K1.10 | TC-K1.T3.d 완료 기록 | `pnpm -C apps/server test -t "TC-K1.T3.d"` | 통과 = 1 |
| G-K1.11 | TC-K1.T3.e 비밀 값 없음 | `pnpm -C apps/server test -t "TC-K1.T3.e"` | 통과 = 1 |
| G-K1.12 | TC-K1.T4.a 큐 실행기 등록 | `pnpm -C apps/server test -t "TC-K1.T4.a"` | 통과 = 1 |
| G-K1.13 | TC-K1.T4.b crons 집합 | `pnpm -C apps/server test -t "TC-K1.T4.b"` | 통과 = 1 |
| G-K1.14 | TC-K1.T4.c Workers 분기 | [L] `pnpm -C apps/server test:workers -t "TC-K1.T4.c"` | 통과 = 1 |
| G-K1.15 | TC-K1.T4.d Node 경계마다 하나 | [L] `pnpm -C apps/server test:db -t "TC-K1.T4.d" --db mysql,pg` | 통과 = 2 |
| G-K1.16 | 큐 실행기 등록 | grep `name: "omniroute_jobs"` in `apps/server/src/jobs.ts` | == 1 |
| G-K1.17 | 재시도 간격 상수 | grep `\[60_000, 120_000, 600_000, 1_800_000\]` in `apps/server/src/queue` | == 1 |
| G-K1.18 | 재현 빨강 TC-K1.T2.a | `node scripts/check-red.mjs --check G-K1.3 --since seal:K0` | 종료코드 0 |
| G-K1.19 | 타입 검사 | `pnpm -r typecheck` | 종료코드 0 |
| G-K1.20 | TC-K1.T5.a CI 단계 잡 | grep `^\s+run: node scripts/gate\.mjs K1\b` in ci.yml | == 1 |
| G-K1.21 | ruleset · TC-K1.T5.b | `node scripts/check-required-checks.mjs --repo henryj-dev/magnetosphere` | 종료코드 0 |
| G-K1.22 | TC-K1.T1.c 정규화는 리터럴 밖에서만 | `pnpm -C packages/db test -t "TC-K1.T1.c"` | 통과 = 1 |
| G-K1.23 | TC-K1.T2.e 멈춘 DB 에도 신호 끊김 | `pnpm -C packages/runtime test -t "TC-K1.T2.e"` | 통과 = 1 |
| G-K1.24 | TC-K1.T2.f 경계 하나는 한 번 | [L] `pnpm -C packages/runtime test:db -t "TC-K1.T2.f" --db sqlite,mysql,mariadb,pg` | 통과 = 4 |
| G-K1.25 | TC-K1.T3.f 키별 순서 | [L] `pnpm -C apps/server test:db -t "TC-K1.T3.f" --db sqlite,mysql,mariadb,pg` | 통과 = 4 |
| G-K1.26 | TC-K1.T3.g 실패 표시·알림 원자성 | [L] `pnpm -C apps/server test:db -t "TC-K1.T3.g" --db sqlite,mysql,mariadb,pg` | 통과 = 4 |
| G-K1.27 | TC-K1.T3.h 망가진 payload | `pnpm -C apps/server test -t "TC-K1.T3.h"` | 통과 = 1 |
| G-K1.28 | TC-K1.T3.i 임대 잃은 시도 | `pnpm -C apps/server test -t "TC-K1.T3.i"` | 통과 = 1 |
| G-K1.29 | 재현 빨강 TC-K1.T3.a | `node scripts/check-red.mjs --check G-K1.7 --since seal:K0` | 종료코드 0 |
| G-K1.30 | 재현 빨강 TC-K1.T2.e | `… --check G-K1.23 --since seal:K0` | 종료코드 0 |
| G-K1.31 | 재현 빨강 TC-K1.T2.f | `… --check G-K1.24 --since seal:K0` | 종료코드 0 |
| G-K1.32 | 재현 빨강 TC-K1.T3.f | `… --check G-K1.25 --since seal:K0` | 종료코드 0 |
| G-K1.33 | 재현 빨강 TC-K1.T3.g | `… --check G-K1.26 --since seal:K0` | 종료코드 0 |
| G-K1.34 | 재현 빨강 TC-K1.T3.h | `… --check G-K1.27 --since seal:K0` | 종료코드 0 |
| G-K1.35 | 재현 빨강 TC-K1.T3.i | `… --check G-K1.28 --since seal:K0` | 종료코드 0 |
| G-K1.36 | 재현 빨강 TC-K1.T1.c | `… --check G-K1.22 --since seal:K0` | 종료코드 0 |
| G-K1.37 | TC-K1.T3.j 실행 중 합치기 | [L] `pnpm -C apps/server test:db -t "TC-K1.T3.j" --db sqlite,mysql,mariadb,pg` | 통과 = 4 |
| G-K1.38 | TC-K1.T3.k 재시도 대기 중 합치기 | [L] `pnpm -C apps/server test:db -t "TC-K1.T3.k" --db sqlite,mysql,mariadb,pg` | 통과 = 4 |
| G-K1.39 | TC-K1.T3.l 실패 처리만 남은 작업 | `pnpm -C apps/server test -t "TC-K1.T3.l"` | 통과 = 1 |
| G-K1.40 | TC-K1.T3.m 끊김 상한 | [L] `pnpm -C apps/server test:db -t "TC-K1.T3.m" --db sqlite,mysql,mariadb,pg` | 통과 = 4 |
| G-K1.41 | TC-K1.T3.n key.* 의 keyId 필수 | `pnpm -C apps/server test -t "TC-K1.T3.n"` | 통과 = 1 |
| G-K1.42 | TC-K1.T3.o 프로토타입 action | `pnpm -C apps/server test -t "TC-K1.T3.o"` | 통과 = 1 |
| G-K1.43 ~ 48 | 재현 빨강 TC-K1.T3.j·k·l·m·n·o | `… --check G-K1.37 ~ 42 --since seal:K0` | 각 종료코드 0 |

`node scripts/gate.mjs K1 --seal`

가장 중요한 검사는 G-K1.3 이다. 2단계의 모든 주기 작업(분배·점검·큐)이 "한 번에 한 인스턴스"라는 전제 위에 있다. 이 전제가 깨지면 두 인스턴스가 같은 회원 예산을 서로 다른 시점의 분석으로 번갈아 쓰고, 그 결과는 어느 TC 의 단일 실행에서도 재현되지 않는다.

---

# K2 — 회원 단위 한도 분배 🔓 (K1 필요)

**브랜치** `p2/k2`.
**outputs** `apps/server/src/limits/**`, `apps/server/test/limits/**`, `apps/server/test/contract/limits/**` (새 경로만). 어댑터(`packages/omniroute/src`)를 고쳐야 하면 고치되 `outputs`에는 넣지 않는다 (0절). V12 결과는 "분배 유지"다 (계획서 v5.6 5.3). V15 결정(v5.7)으로 이 단계가 새 테이블 `usage_daily`를 만든다: 스키마(`packages/db/src/schema/**`, 기존 파일)와 마이그레이션 `packages/db/migrations/*/0002_*`(새 경로)는 이 단계 `outputs` 글롭 밖이다. 잠긴 단계라 `outputs`를 넓힐 수 없으므로 `--assert-order`는 이 경로를 지키지 않고, 순서는 K1 봉인(R1)이 지킨다.

### ☑ K2.T1 — 남은 한도 계산 (순수 함수)
선행 없음 · 산출 `apps/server/src/limits/compute.ts`, `apps/server/test/limits/**` · 되돌리기 커밋 1개

【작업】
1. `computeBudgets({ limitUsd, keys: [{ id, state, spentUsd }] })` → `{ memberSpent, remaining, exhausted, budgets: Map<id, number> }`. 계획서 5.3 식: 회원 사용액 = 모든 키(삭제 포함) 사용액 합, 남은 한도 = max(한도 − 사용액, 0), 남은 한도 > 0 이면 키 예산 = 그 키 사용액 + 남은 한도 (삭제 키는 예산 대상 아님). 남은 한도 = 0 이면 `exhausted: true`, `budgets` 빈 Map — 키는 예산이 아니라 끄기로 막는다 (v5.6 Q1, `disabled_reason limit`). 한도 NULL 이면 예산 없음·`exhausted: false`. 금액은 소수 6자리(`DECIMAL(12,6)`)로 반올림. 커밋.

【테스트】
```
TC-K2.T1.a  계산식이 계획서 5.3 과 같다
  단언:  한도 5, 키 A(active) 3, 키 B(deleted) 1.5, 키 C(active) 0 → 사용액 4.5, 남은 0.5, A 3.5, C 0.5, B 예산 없음
  검출:  삭제 키를 사용액 합에서 빼 키를 지우면 한도가 늘어나는 것 (7장 회귀 시나리오 "키 삭제 후 재발급으로 한도 초기화")
TC-K2.T1.b  한도를 넘긴 회원의 남은 한도는 0 이고 예산 대신 끄기다 (Q1 의존)
  단언:  한도 5, 사용액 6(A 4, B 2) → 남은 0, exhausted true, budgets 빈 Map
  검출:  max(…, 0) 을 빠뜨려 예산이 사용액보다 작아지고 setBudget 이 음수·0 으로 TypeError 를 던져 분배 전체가 멈추거나, 사용액 그대로 예산을 걸어 OmniRoute 가 '>' 비교로 요청 하나를 더 통과시키는 것 (V20 equalBlocks false)
TC-K2.T1.c  한도 NULL(무제한)이면 예산을 걸지 않는다
  단언:  limitUsd null → budgets 빈 Map
  검출:  NULL 을 0 으로 읽어 무제한 회원의 모든 키를 막는 것 (5.9 "NULL이면 무제한")
TC-K2.T1.d  남은 한도 0 · 사용액 0 키는 예산이 아니라 끄기 대상이다 (Q1 의존)
  단언:  한도 1, A 사용액 1, C 사용액 0 → remaining 0, exhausted true, budgets 에 C 없음 (0 이하 예산 0건)
  검출:  C 예산이 0 으로 계산돼 OmniRoute 에서 무제한이 되거나(어댑터를 우회한 경우), 어댑터 TypeError 로 분배가 멈추는 것
TC-K2.T1.e  부동소수 오차로 남은 한도가 생기지 않는다
  단언:  한도 0.3, 키 사용액 0.1·0.2 → 남은 0 (6자리 반올림 뒤), 예산은 소수 6자리 이하
  검출:  0.1 + 0.2 = 0.30000000000000004 로 남은 한도가 -4e-17 → 0 은 맞지만, 한도 0.3 사용액 0.1·0.19999999 에서 1e-8 짜리 예산이 생겨 매분 setBudget 이 바뀌는 것
TC-K2.T1.f  사용액은 올림, 남은 한도는 내림 (1e-6 단위, K2 리뷰 L2)
  단언:  한도 1·사용액 0.9999991 → 사용액 1, 남은 0(exhausted). 한도 1·0.0000001 → 사용액 0.000001, 남은 0.999999. 한도 0.0000019·0 → 남은 0.000001. 0.1 + 0.2 → 사용액 0.3 (1e-12 아래 꼬리는 올리지 않음)
  검출:  같은 방향 반올림이라 한도 1·사용액 0.9999991 에서 남은 0.000001 이 생겨 다 쓴 회원의 키가 켜진 채 남는 것
```

【통과】
- [ ] G-K2.1 ~ G-K2.5 · G-K2.32 통과

### ☑ K2.T2 — 달 경계와 시간대
선행 K2.T1 · 산출 `apps/server/src/limits/month.ts` · 되돌리기 커밋 1개

【작업】
1. `monthWindow(now)` → `[이번 달 1일 00:00 UTC, now]` (V20 `answer.timezone` "UTC", 계획서 v5.6 5.3). `monthChanged(lastMonth, now)`: `app_settings.budget_rebalance_month`("YYYY-MM", UTC)와 지금 달이 다르면 참 (Q5). 1분 분배가 매번 이 창으로 분석을 부르고, 달이 바뀐 첫 실행이 새 달 기준 재계산(`limit` 으로 꺼진 키 다시 켜기 포함)을 한 뒤 `budget_rebalance_month`를 지금 달로 쓴다. 커밋.

【테스트】
```
TC-K2.T2.a  달 경계 직전·직후의 창이 다르다 (V20 의존)
  단언:  answer.timezone 기준 3월 31일 23:59:59.999 → 창 시작 3월 1일 00:00, 4월 1일 00:00:00.000 → 4월 1일 00:00 (ISO 로 비교)
  검출:  UTC 로 자르는데 OmniRoute 가 다른 시간대로 자르면 매달 첫 몇 시간 동안 지난달 사용액이 이번 달 남은 한도를 깎는 것
TC-K2.T2.b  새 달 첫 실행은 지난달 사용액을 넣지 않는다
  단언:  가짜 분석(지난달 4.9, 이번 달 0), 한도 5, 새 달 00:00:30 실행 → 남은 5
  검출:  창 시작을 "지난 실행 시각"으로 잡는 식의 구현에서 달이 바뀌어도 한도가 풀리지 않는 것
TC-K2.T2.c  달 바뀜은 저장한 마지막 실행 달로 판단한다 (Q5 의존)
  단언:  budget_rebalance_month "2026-03", now 2026-04-01T00:00:30Z → monthChanged true, 실행 뒤 "2026-04" 저장. 같은 달 두 번째 실행 → false. 값 없음(첫 실행) → true
  검출:  월간 cron 을 따로 두려다(cronIntervalMinutes("0 0 1 * *") 는 예외) 등록이 빠져 limit 으로 꺼진 키가 새 달에도 안 켜지는 것
```

【통과】
- [ ] G-K2.6 · G-K2.7 · G-K2.24 통과

### ☐ K2.T3 — 1분 분배 작업 (폐기)
v5.7 에서 폐기 (V15). 매분 이번 달 전체를 분석으로 부르는 방식은 기록 300,000건에서 CI x64 p95 5.6~6.4초라 느리다. 오늘 창 + 지난 날 저장(K2.T7)으로 바꾼 K2.T6 이 대신한다. TC-K2.T3.a~j 는 TC-K2.T6.a~j 로 옮겼다 (GATE 행 번호는 그대로).

### ☑ K2.T7 — 지난 날 저장 `usage_daily`·날 확정·하루 대조 (v5.7)
선행 K2.T2 · 산출 `packages/db/src/schema/**`, `packages/db/migrations/{sqlite,mysql,pg}/0002_*`, `apps/server/src/limits/daily.ts`, `apps/server/test/limits/**`, `apps/server/test/contract/limits/**` · 되돌리기 커밋 1개

【작업】
1. 공통 정의에 `usage_daily(key_id, day, cost_usd DECIMAL(12,6), updated_at, PK(key_id, day))`를 더하고 세 벌 생성·마이그레이션 `0002_*`를 만든다 (계획서 v5.7 5.9). `0002_*`는 K2 `outputs`(잠긴 단계라 못 고침) 밖이라 `--assert-order`가 지키지 않는다. 순서는 K1 봉인(R1)이 지킨다.
2. `apps/server/src/limits/daily.ts`: `storedSpent(keyIds, month)` = 이번 달 1일~어제 합. `confirmDays(now)`: `app_settings.usage_daily_confirmed`(확정·대조를 마지막으로 한 날 = 그 실행의 오늘)가 오늘보다 이르면 (1) 어제 창(어제 00:00 ~ 어제 23:59:59.999 UTC)을 한 번 불러 매핑된 키의 어제 값을 저장하고 (2) 이번 달 1일 ~ 어제 23:59:59.999 를 다시 불러 저장값을 덮는다(대조). 창 끝이 23:59:59.999 인 이유: OmniRoute 3.8.51 분석은 `timestamp >= startDate AND timestamp <= endDate`(양 끝 포함)라, 끝을 오늘 00:00 으로 주면 자정 정각 기록이 어제 저장값과 오늘 창에 두 번 든다 (K2 구현 때 이미지 소스로 확인). 한 번 호출의 `byApiKey`는 키별 합계라 날짜별 값이 없다: 합계가 저장 합과 다른 키의 날짜별 저장값을 비율대로 새 합계에 맞춘다(저장 합 0 이면 어제에 둔다). 회원 사용액은 합만 쓴다. 키·날마다 |새 값 − 저장값| > 0.000001 이 하나라도 있으면 `audit_log` `alert.usage_drift`(차이 난 키·날 수, 합계 차이) 1행. 대조 호출이 어댑터 제한 시간에 걸리면 대조를 멈추고 다음 실행부터 날 단위로 나눠 하루씩 부른다 (진행한 날을 `app_settings`에 남김). 펜싱 아래에서 쓴다. 커밋.
3. (K2 리뷰 M1·L3·열린 질문) 저장값과 분석 창의 경계(`coveredUntil`)는 분할 대조가 남아 있으면 `split.next`다: 그 전 날은 정확한 저장값, 그 뒤는 분석 창 한 번. 그 창이 실패하면 실행이 실패한다(fail-closed). 분할 하루 창 시간 초과는 그날만 미룬다. 응답에 없는 키는 자료 없음으로 보고 저장값을 지우지 않는다. 재현 커밋 `Red: TC-K2.T7.f TC-K2.T7.g TC-K2.T7.h TC-K2.T7.i` → 고침.

【테스트】
```
TC-K2.T7.a  날이 바뀐 첫 분배가 어제를 확정 저장한다 (V15 의존)
  단언:  가짜 어댑터·시계, usage_daily_confirmed "2026-04-09", now 2026-04-10T00:01Z → 어제 창 호출 1건(startDate 04-09T00:00Z, endDate 04-09T23:59:59.999Z — 분석 창 끝은 포함이다), usage_daily 에 매핑 키의 04-09 행, usage_daily_confirmed "2026-04-09"→"2026-04-10" 기준으로 갱신. 같은 날 두 번째 실행 → 어제 창·대조 호출 0건
  검출:  날 확정을 매분 다시 해 1분 분배가 하루 창 두 개를 부르거나, 확정을 빠뜨려 어제 몫이 회원 사용액에서 통째로 빠지는 것
TC-K2.T7.b  하루 한 번 대조가 저장값을 덮고 차이를 알린다 (V15 의존)
  단언:  저장값 04-03 키 A 0.010000, 가짜 대조 응답 0.012000 (가격표 변경) → 대조 호출 1건(startDate 04-01T00:00Z, endDate 04-09T23:59:59.999Z), 저장값 0.012000, audit_log "alert.usage_drift" 1행(키·날 1, 합계 0.002). 차이 없으면 alert 0행
  검출:  가격표가 바뀌어도 지난 날 저장값이 그 달 끝까지 옛 값으로 남거나, 차이를 조용히 덮어 운영자가 한도 계산이 바뀐 것을 모르는 것
TC-K2.T7.c  대조가 제한 시간에 걸리면 날 단위로 나눈다
  단언:  대조 첫 호출이 AbortSignal 시간 초과 → 그 실행 저장값 변화 0, 다음 실행부터 하루 창 호출로 나눠 진행, 9일 치를 다 맞추면 한 번 호출로 돌아감
  검출:  한 달 창 대조가 임대(55초)를 넘겨 두 인스턴스가 같은 날을 번갈아 쓰거나, 실패한 대조를 매분 다시 불러 OmniRoute 를 두드리는 것
TC-K2.T7.d  지난 날 합 + 오늘 == 분석 API 한 달 값이다 (계약, V15 의존)
  단언:  계약 환경, 키 A·B 요청 3건, 계약 OmniRoute usage_history 에 A 의 OpenAI 기록을 본떠 어제 12:00 과 오늘 00:00:00.000(자정 정각)에 넣음 → 실제 시계로 confirmDays → storedSpent([A,B], 이번 달 1일 ~ 오늘) + 오늘 창(자정 기록 포함 4건) == getAnalytics(apiKeyIds [A,B], 이번 달 1일 ~ 지금).totalCost (오차 1e-9). (K2 리뷰 L4: 가짜 '내일' 창은 미래라 늘 0 이었다)
  검출:  창 경계를 [시작, 끝] 둘 다 포함으로 잡아 자정 정각 기록을 두 번 세거나, byApiKey 비용과 summary 비용 계산이 달라 저장 합이 분석 API 한 달 값과 어긋나는 것
  고침:  (2026-10-10, CI 38050586245) 기록이 잡혔는지 기다리는 settled 의 창이 [지금 − 24시간, 지금 + 60초]라, UTC 12:00 뒤(1일 제외)에
         돌면 어제 12:00 기록이 기대값 쪽에서 빠져 0.00221 어긋났다. 시험 시각에 달린 시험 버그다 (운영 코드는 UTC 날·달 경계만 쓴다).
         settled 를 이번 달 1일부터 세게 하고 기록 수(3 + 넣은 수)를 단언한다. 대조: daily.ts endOfDay 를 다음 날 00:00 으로 바꾸면 실패한다
TC-K2.T7.e  다섯 DB 에 usage_daily 가 있다
  단언:  test:migrate --db sqlite,mysql,mariadb,pg,d1 → usage_daily (key_id, day) 기본 키, cost_usd DECIMAL(12,6)·SQLite REAL, 같은 (key_id, day) 두 번 저장은 갱신 1행
  검출:  한 DB 의 0002 마이그레이션이 빠져 그 조합에서 1분 분배가 "no such table usage_daily" 로 멈추는 것
TC-K2.T7.f  이틀 넘는 공백 뒤 대조가 시간 초과여도 이번 달 사용액 == 분석 한 달 합 (K2 리뷰 M1)
  단언:  confirmed "04-05", now 04-10T00:01, 한 번 호출 대조 시간 초과 → 분배의 키 B 사용액 == 기록 합 5.5 (A 예산 94.5), 분할이 하루 나아간 다음 실행도 같다
  검출:  확정 날을 오늘로 써 coveredUntil 이 오늘이 되고, 저장되지 않은 04-05~04-08 이 저장 합에도 오늘 창에도 없어 남은 한도가 부풀고 limit 키가 다시 켜지는 것
TC-K2.T7.g  처음 설치한 날 대조가 시간 초과여도 이번 달 사용액 == 분석 한 달 합 (K2 리뷰 M1)
  단언:  usage_daily_confirmed 없음, now 04-10T00:01, 대조 시간 초과 → B 사용액 == 3.5 (A 예산 96.5)
  검출:  첫날 어제 하루만 저장하고 이번 달 1일 ~ 그 전날 몫이 빠지는 것
TC-K2.T7.h  분할 대조의 하루 창이 시간 초과면 그날만 다음 실행으로 미룬다 (K2 리뷰 L3)
  단언:  split { next 04-03, until 04-10 }, 04-03 창 시간 초과 → rebalanceAll 이 던지지 않고 그날부터 분석 창으로 센다 (A 예산 97.5), split 그대로
  검출:  하루 창 시간 초과가 분배 전체를 멈춰 그동안 예산·끄기가 하나도 반영되지 않는 것
TC-K2.T7.i  대조 응답에 없는 키의 저장값은 지우지 않는다 (K2 리뷰 열린 질문)
  단언:  저장값 A 04-03 0.01·B 04-04 0.02, 대조 응답에 A 만 → B 0.02 그대로, alert 0행. byApiKey 는 개수 제한이 없다 (V15 evidence, 3.8.51 소스)
  검출:  응답에서 빠진 키(자료 없음)를 0 으로 덮어 그 키 몫이 회원 사용액에서 사라지는 것
TC-K2.T7.j  지난달 분할 대조 상태는 새 달 첫 실행이 지운다 (재검토 L-b)
  단언:  split { next 03-25, until 03-31 }, now 04-01T00:01 → split 지움, 같은 날 두 번째 실행까지 3월 하루 창 호출 0건
  검출:  지난달 분할이 남아 새 달에도 매분 지난달 하루 창을 부르는 것
```

【통과】
- [ ] G-K2.27 ~ G-K2.31 · G-K2.33 ~ G-K2.36 · G-K2.55 통과

### ☑ K2.T6 — 1분 분배 작업 (v5.7: 오늘 창 + 지난 날 저장)
선행 K2.T2 · K2.T7 · 산출 `apps/server/src/limits/rebalance.ts`, `packages/omniroute/src/**`(필터 없는 분석 호출), `apps/server/test/contract/limits/**` · 되돌리기 커밋 1개

【작업】
1. `budget_rebalance` 본문: 활성 키가 있는 회원과 `limit` 으로 꺼진 키가 있는 회원만, 계획서 v5.7 5.3 대로 분석은 오늘 창 하나만 부른다 (`startDate` 오늘 00:00 UTC, `endDate` 지금, `apiKeyIds` 없음, V15 decision). `byApiKey`를 `api_keys` 매핑으로 회원별로 묶고(삭제 키 포함), 회원 사용액 = K2.T7 `storedSpent`(이번 달 1일~어제 `usage_daily` 합) + 오늘 창 값. 날이 바뀐 첫 실행은 분석 전에 K2.T7 `confirmDays`를 부른다. 회원마다 `computeBudgets` → `exhausted`면 켜진 키를 `setKeyActive(false)`, `state disabled`·`disabled_reason limit` (Q1). 아니면 목표가 켜짐인 키 중 `budget_usd`와 다른 것만 `setBudget` → 펜싱 아래 `budget_usd` 기록, `limit` 으로 꺼진 키는 예산을 먼저 건 뒤 `setKeyActive(true)`, `state active`·`disabled_reason` NULL (회원·관리자·회원 상태로 꺼진 키는 건드리지 않는다). 이 끄기·켜기는 K3.T2 `applyKey`가 생기면 그것으로 바꾼다. 분석이 `OmniRouteFormatError`·`OmniRouteError`면 이번 실행은 예산을 하나도 바꾸지 않는다. 어댑터 변경이 필요하면(예: 필터 없는 분석) `packages/omniroute`에 두고 `G-S5.9`(어댑터 밖 관리 호출 0)를 지킨다. `JOBS`에 `{ name: "budget_rebalance", cron: "* * * * *" }`를 등록하고 `wrangler.toml` crons 에 `"* * * * *"`를 더한다 (TC-K1.T4.b 가 같음을 본다). 커밋.
2. (K2 리뷰 M2·M3·L1) 한 실행은 1단계 남은 한도 0 회원의 끄기 전부, 2단계 예산·켜기(이번 달 예산을 아직 받지 못한 키가 있는 회원부터). 키별 `api_keys.budget_month`(예산을 건 달, 0002)가 이번 달이고 예산이 같으면 보내지 않는다(새 달 force 대신). 회원 하나의 예외는 그 회원만 실패로 세고 `alert.rebalance_failed` 1행. 시간 예산은 임대의 2/3(36,666ms), 넘으면 다음 회원을 시작하지 않고 다음 tick 에 이어 간다. setBudget 은 잡을 때 `budget_usd`를 비우고 성공한 뒤 `budget_at` 조건으로 값을 쓴다. 한도가 무제한(NULL)으로 바뀐 회원의 옛 예산은 어댑터 `clearBudget`(월 예산 0 = 무제한, V20)으로 푼다 — `setBudget`은 0 을 계속 거부하고, `clearBudget`은 이 경로에서만 쓴다(G-K2.42). 재현 커밋 `Red: TC-K2.T6.l TC-K2.T6.m TC-K2.T6.o TC-K2.T6.p` → 고침.
3. (K2 재검토 H1·M-a·M-b·M-c·L-a·L-b) setBudget·clearBudget 사후 갱신이 0행이면 `budget_usd`·`budget_month`를 모두 비운다(늦게 도착한 호출이 더 새 계산을 덮었을 수 있음). 무제한 전환 때 값을 모르는 키(`budget_usd`·`budget_month` NULL, `budget_at` 있음)도 푼다. 최근 실패한 회원(`app_settings.budget_rebalance_failed`)은 정렬 맨 뒤. 같은 회원·같은 오류 알림은 하루 한 번(`budget_rebalance_alerted`), 계산이 깨진 회원의 켜진 키는 limit 으로 끈다(fail-closed). 연속 10번 실패하면 `alert.rebalance_stalled` 하루 한 번(`budget_rebalance_stalled`). 지난달 분할 대조 상태는 새 달 첫 확정 때 지운다. 재현 커밋 `Red: TC-K2.T6.t TC-K2.T6.u TC-K2.T6.q TC-K2.T6.r TC-K2.T6.s TC-K2.T7.j` → 고침.

【테스트】
```
TC-K2.T6.a  활성 키가 없는 회원은 OmniRoute 호출이 없다
  단언:  회원 둘(활성 키 있음 1, 꺼진 키만 1), 가짜 OmniRoute → setBudget 대상은 첫 회원 키뿐
  검출:  모든 회원을 매분 돌아 회원 수에 비례해 분배 시간이 늘고 임대(55초)를 넘기는 것
TC-K2.T6.b  예산이 바뀐 키만 setBudget 을 부른다
  단언:  같은 상태로 두 번 실행 → 두 번째 실행 setBudget 0건
  검출:  매분 키마다 POST /api/usage/budget 를 보내 키 300개면 분당 300건이 OmniRoute 에 쌓이는 것
TC-K2.T6.c  분석 형식 오류면 예산을 하나도 바꾸지 않는다
  단언:  분석 응답에 음수 cost(analyticsSchema money 위반) → OmniRouteFormatError, setBudget 0건, budget_usd 변화 0
  검출:  형식이 바뀐 분석을 0 으로 읽어 모든 회원 남은 한도를 한도 전액으로 되돌리는 것
TC-K2.T6.d  두 키로 나눠 써 회원 한도에 닿으면 분배 뒤 두 키 모두 막힌다 (계약)
  단언:  한도 0.02, 키 A·B 각 요청 3건(0.014633씩, 합 0.029266 > 0.02) → 분배 1회 → A·B 다음 요청 둘 다 거부 (남은 한도 0 이라 v5.6 Q1 끄기: 403). 대조: 한도 0.03 이면 분배 뒤 A·B 예산 == 각 사용액 + 0.000734, 다음 요청 200
  검출:  키별 예산을 키 사용액 기준으로만 걸어 회원 합계가 한도를 넘어도 각 키가 자기 몫 안이라 통과하는 것
TC-K2.T6.e  삭제한 키의 사용액이 새 키의 남은 몫을 줄인다 (계약, V18 의존)
  단언:  한도 0.02, 키 A 요청 3건(0.014633) → A 삭제 → 키 B 발급·분배 → B 예산 == 0.02 − 0.014633 (오차 1e-6)
  검출:  분석 apiKeyIds 에 삭제 키를 빼 B 가 한도 전액을 새로 받는 것
TC-K2.T6.f  사용액 0 키도 회원 한도 도달 뒤 꺼진다 (계약, Q1 의존)
  단언:  한도 0.01, 키 A 요청 3건 → 키 C(사용액 0) 분배 1회 → A 다음 요청 403 permission_denied, C 는 거부(한 번도 쓰지 않은 채 꺼진 키는 OmniRoute 3.8.51 이 401 AUTH_002 로 거부한다, K2 계약 실측), listKeys 에서 A·C isActive false, api_keys 두 행 disabled_reason "limit"
  검출:  Q1 공백 그대로 예산 0(무제한)이 걸리거나 예산을 아예 안 걸어 C 로 한도 밖 사용이 계속되는 것
TC-K2.T6.j  남은 한도가 다시 생기면 limit 으로 꺼진 키만 켠다 (계약, Q1 의존)
  단언:  f 뒤 회원이 직접 끈 키 D(disabled_reason member) 추가 → 한도 0.05 로 올림 → 분배 1회 → A·C 다음 요청 200, D 거부(쓴 적 없는 꺼진 키라 401 AUTH_002 또는 403)·listKeys isActive false. 어댑터 호출 순서는 키마다 [setBudget, setKeyActive(true)]
  검출:  새 달·한도 상향 뒤에도 limit 키가 꺼진 채 남거나, 회원이 끈 키까지 켜거나, 예산 없이 먼저 켜 1분 동안 한도 밖 사용이 열리는 것
TC-K2.T6.g  초과 폭은 한도 × 동시에 쓰는 키 수 안이다 (계약)
  단언:  한도 0.02, 키 2개를 동시에 막힐 때까지(isBudgetBlocked 또는 403) 쓰기 → 회원 총 사용액 ≤ 0.02 × 2 + 요청 1건 비용(0.004878)
  검출:  예산이 "남은 한도"가 아니라 "한도"로 걸려 초과 폭이 키 수와 무관하게 커지는 것 (5.3 한계의 상한이 깨짐)
TC-K2.T6.i  분배는 1분마다 등록된다
  단언:  JOBS 의 budget_rebalance cron == "* * * * *", wrangler crons 에 "* * * * *" 포함 (TC-K1.T4.b 재실행)
  검출:  분배를 5분 정합성 cron 에 같이 걸어 한도 반영이 최대 5분 늦는 것, Workers crons 에서 빠져 Workers 조합에서 분배가 안 도는 것
TC-K2.T6.h  분배 한 번이 측정 환경에서 임대 안에 끝난다 (V15 의존)
  단언:  tests/bench 의 키 300·기록 300,000(30일) 환경, 회원 150·각 키 2 매핑 → 날 확정·대조가 없는 분배 1회 ≤ 30,000ms, 날이 바뀐 첫 분배(확정·대조 포함) ≤ 55,000ms
  검출:  회원마다 분석을 부르거나 매분 한 달 창을 불러(V15 fullMonth p95 6초) 55초 임대를 넘기는 것
TC-K2.T6.k  1분 분배는 오늘 창 하나만 부른다 (V15 의존)
  단언:  가짜 어댑터, 같은 날 두 번째 실행 → getAnalytics 1건, startDate == 오늘 00:00:00.000Z, endDate == now, apiKeyIds 없음. 회원 사용액 == usage_daily 이번 달 합 + 오늘 창 byApiKey 합
  검출:  매분 이번 달 1일부터 불러 기록이 쌓일수록 분배가 느려지거나, 저장값을 빼고 오늘 값만으로 남은 한도를 계산해 한도가 매일 새로 생기는 것
TC-K2.T6.l  임대 안에 다 못 끝내는 회원 수도 두 tick 이면 모든 키가 새 달 예산(또는 꺼짐)을 받는다 (K2 리뷰 M2)
  단언:  새 달 첫 실행, 회원 20(마지막은 한도 초과), tick 마다 OmniRoute 변경 15건째에 임대 상실, 시간 예산 12초(변경 1건 1초) → 첫 tick 첫 호출이 초과 회원 setKeyActive(false), 두 tick 뒤 켜진 키 19개 모두 setBudget, 둘째 tick 은 첫 tick 이 건 키를 다시 보내지 않음
  검출:  새 달 첫 실행이 임대를 넘겨 budget_rebalance_month 를 못 쓰고 매번 처음부터 다시 돌아, 뒤쪽 회원 키에 지난달 예산이 남고(OmniRoute 카운터는 0) 초과 회원도 꺼지지 않는 것
TC-K2.T6.m  회원 하나의 예외가 다른 회원을 막지 않는다 (K2 리뷰 M2)
  단언:  첫 회원 저장값이 깨짐(음수 비용 → computeBudgets TypeError) → failedMembers 1, alert.rebalance_failed 1행(userIds [그 회원]), 둘째 회원 키 setBudget
  검출:  회원 하나의 예외가 rebalanceAll 전체를 멈춰 그 뒤 회원이 매분 분배를 받지 못하는 것
TC-K2.T6.o  임대를 잃어 끊긴 setBudget 은 다음 실행이 다시 보낸다 (K2 리뷰 L1)
  단언:  setBudget 도중 임대 상실 → rebalanceAll 이 던지고 budget_usd NULL, 다음 실행 setBudget 1건(같은 예산), budget_usd 5
  검출:  잡을 때 budget_usd=want 를 써 두어, 끊긴 뒤 다음 분배가 같은 값이라 건너뛰고 OmniRoute 에는 옛 예산이 남는 것
TC-K2.T6.p  무제한(NULL)으로 바뀐 회원의 옛 예산은 clearBudget 으로 푼다 (K2 리뷰 M3)
  단언:  한도 NULL, 켜진 키 A(budget_usd 5)·limit 키 B(budget_usd 3)·예산 없는 C → 호출 A [clearBudget], B [clearBudget, setKeyActive(true)], C 없음, A·B budget_usd NULL
  검출:  무제한 회원은 예산을 걸지 않는다며 그냥 넘어가 옛 예산에 계속 막히는 것
TC-K2.T6.n  clearBudget 뒤 예산이 무제한이 된다 (계약, K2 리뷰 M3)
  단언:  한도 0.016, 키 A 3건 → 분배(예산 0.016) → 1건 200 → 다음 요청 예산 차단(429) → 한도 NULL → 분배 → 호출 [clearBudget] 하나 → 다음 요청 200
  검출:  clearBudget 이 0 대신 다른 값을 보내거나 resetInterval 을 빼 OmniRoute 에 옛 월 한도가 남는 것
TC-K2.T6.t  늦게 도착한 clearBudget·setBudget 이 더 새 계산을 덮어도 다음 분배가 다시 건다 (재검토 H1)
  단언:  한도 NULL 분배(t1)의 clearBudget 도중 한도 10·즉시 분배(t2) setBudget(10) → 늦은 clear 뒤 budget_usd·budget_month NULL, 다음 분배 setBudget(10). 반대로 한도 10 분배의 setBudget 도중 한도 NULL·즉시 분배 clearBudget → 다음 분배 clearBudget
  검출:  사후 갱신 0행을 그냥 넘겨 DB 에는 새 예산(또는 풀림)이 이번 달 값으로 남고, OmniRoute 는 늦게 도착한 옛 호출 상태라 한 달 내내 무제한(또는 옛 예산)인 것
TC-K2.T6.u  예산 값을 모르는(NULL) 키도 무제한 전환 때 푼다 (재검토 M-a)
  단언:  한도 NULL, budget_usd·budget_month NULL·budget_at 있음 → clearBudget 1건, 다음 실행 0건. budget_at NULL 인 키 0건
  검출:  setBudget 실패·임대 상실로 값을 모르게 된 키를 "예산 없음"으로 보고 넘어가 옛 예산에 계속 막히는 것
TC-K2.T6.q  매번 실패하는 회원이 앞에 있어도 두 tick 안에 뒤 회원이 새 달 예산을 받는다 (재검토 M-b)
  단언:  새 달, 첫 회원 키 3개가 setBudget 마다 15초 뒤 시간 초과(시간 예산 36,666ms), 뒤 회원 10 → 둘째 tick 이 뒤 회원 10명 모두 setBudget
  검출:  실패한 회원이 "이번 달 예산을 못 받은 키"라 매번 정렬 맨 앞에 서고 시간 예산을 혼자 써 뒤 회원이 굶는 것
TC-K2.T6.r  계산이 깨진 회원은 키를 limit 으로 끄고, 같은 오류 알림은 하루 한 번 (재검토 M-c)
  단언:  음수 저장값 회원 → 첫 실행 setKeyActive(false)·limit, 같은 날 두 번 돌아도 alert.rebalance_failed 1행, 값이 고쳐지면 [setBudget, setKeyActive(true)]
  검출:  계산이 깨진 회원의 키가 지난달 예산을 단 채 켜져 있고, 같은 알림이 매분 쌓여 다른 알림을 묻는 것
TC-K2.T6.s  분배가 연속 10번 실패하면 alert.rebalance_stalled 를 하루 한 번 (재검토 L-a)
  단언:  오늘 창 분석 OmniRouteError → 9번째까지 0행, 10번째 1행, 12번째도 1행, 성공하면 연속 수 0
  검출:  분석이 계속 실패해 분배가 무기한 멈췄는데 아무도 모르는 것
```

【통과】
- [ ] G-K2.8 ~ G-K2.15 · G-K2.22 · G-K2.23 · G-K2.25 · G-K2.26 · G-K2.37 ~ G-K2.42 · G-K2.56 ~ G-K2.60 통과
- [ ] G-K2.18 통과 (어댑터 밖 OmniRoute 관리 호출 0)

### ☑ K2.T4 — 즉시 분배 진입점
선행 K2.T6 · 산출 `apps/server/src/limits/member.ts` · 되돌리기 커밋 1개

【작업】
1. `rebalanceMember(userId)`: 그 회원 키 전부(삭제 포함)의 `storedSpent` + 그 키 id 로 오늘 창 분석 한 번(v5.7 5.3) → 계산 → 예산. 발급·재발급 직후와 관리자 한도 변경 직후(K4)가 부른다. 1분 작업과 같은 임대를 잡지 않고 회원 단위 펜싱(`budget_usd` 갱신 조건)으로 겹침을 막는다. 갱신 조건은 `api_keys.budget_at`(그 예산·limit 끄기를 계산한 분석 시각, K2.T7 의 0002 에 함께 넣음)이 비었거나 내 분석 시각보다 이를 때다. 커밋.

【테스트】
```
TC-K2.T4.a  즉시 분배는 그 회원 키 전부(삭제 포함)로 분석한다
  단언:  회원 키 3(그중 삭제 1) → getAnalytics apiKeyIds 집합 == 세 id, 다른 회원 키 0, startDate == 오늘 00:00 UTC, 사용액 == storedSpent(세 id) + 오늘 값
  검출:  삭제 키를 빼고 불러 재발급 직후 예산이 한도 전액으로 걸리는 것 (1분 분배가 고칠 때까지 최대 1분 열림)
TC-K2.T4.b  즉시 분배와 1분 분배가 겹쳐도 옛 계산이 새 계산을 덮지 않는다
  단언:  즉시 분배(분석 시각 t2) 기록 뒤 늦게 끝난 1분 분배(분석 시각 t1 < t2)의 budget_usd 갱신 → 0행
  검출:  늦게 끝난 쪽이 옛 사용액으로 예산을 다시 올려 방금 막은 키가 열리는 것
TC-K2.T4.c  즉시 분배는 예산 실패를 삼키지 않는다 (K2 리뷰 M4)
  단언:  setBudget 이 OmniRouteError 503 → rebalanceMember 가 던진다, budget_usd NULL
  검출:  실패를 counts 에만 세고 돌아와 발급(K4)이 예산 없는 키를 켜는 것
```

【통과】
- [ ] G-K2.16 · G-K2.17 · G-K2.43 통과

### ◐ K2.T5 — K2 CI 잡과 봉인
선행 K2.T1 · K2.T2 · K2.T4 · K2.T6 · K2.T7 · 산출 `.github/workflows/ci.yml` · 되돌리기 커밋 1개

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
| G-K2.6 · 7 | TC-K2.T2.a · b | `pnpm -C apps/server test -t "TC-K2.T2.<x>"` | 각 통과 = 1, 창 시작 = 매달 1일 00:00 UTC (V20) |
| G-K2.24 | TC-K2.T2.c 달 바뀜 판단 | `pnpm -C apps/server test -t "TC-K2.T2.c"` | 통과 = 1 |
| G-K2.8 ~ 10 | TC-K2.T6.a ~ c | `pnpm -C apps/server test -t "TC-K2.T6.<x>"` | 각 통과 = 1 |
| G-K2.11 | TC-K2.T6.d 두 키 회원 한도 | [L] `pnpm test:contract -t "TC-K2.T6.d"` | 통과 = 1 |
| G-K2.12 | TC-K2.T6.e 삭제 키 사용액 | [L] `pnpm test:contract -t "TC-K2.T6.e"` | 통과 = 1 |
| G-K2.13 | TC-K2.T6.f 사용액 0 키 | [L] `pnpm test:contract -t "TC-K2.T6.f"` | 통과 = 1 |
| G-K2.25 | TC-K2.T6.j limit 키 다시 켜기 | [L] `pnpm test:contract -t "TC-K2.T6.j"` | 통과 = 1 |
| G-K2.14 | TC-K2.T6.g 초과 폭 | [L] `pnpm test:contract -t "TC-K2.T6.g"` | 통과 = 1, 회원 총 사용액 ≤ 한도 × 2 + 0.004878 |
| G-K2.15 | TC-K2.T6.h 분배 소요 | [L] `node tests/bench/analytics.mjs --rebalance --assert` | 종료코드 0, 보통 ≤ 30,000ms · 날이 바뀐 첫 분배 ≤ 55,000ms |
| G-K2.26 | TC-K2.T6.k 오늘 창만 | `pnpm -C apps/server test -t "TC-K2.T6.k"` | 통과 = 1 |
| G-K2.27 ~ 29 | TC-K2.T7.a ~ c | `pnpm -C apps/server test -t "TC-K2.T7.<x>"` | 각 통과 = 1 |
| G-K2.30 | TC-K2.T7.d 저장 합 + 오늘 == 한 달 | [L] `pnpm test:contract -t "TC-K2.T7.d"` | 통과 = 1, 오차 1e-9 |
| G-K2.31 | TC-K2.T7.e usage_daily 다섯 DB | [L] `pnpm -C packages/db test:migrate -t "TC-K2.T7.e" --db sqlite,mysql,mariadb,pg,d1` | 통과 = 5 |
| G-K2.16 · 17 | TC-K2.T4.a · b | `pnpm -C apps/server test -t "TC-K2.T4.<x>"` | 각 통과 = 1 |
| G-K2.18 | 어댑터 밖 관리 호출 0 | grep `/api/(keys\|usage)` in `apps packages`, `packages/omniroute/**` 제외 | == 0 |
| G-K2.19 | 타입 검사 | `pnpm -r typecheck` | 종료코드 0 |
| G-K2.20 | TC-K2.T5.a CI 단계 잡 | grep `^\s+run: node scripts/gate\.mjs K2\b` in ci.yml | == 1 |
| G-K2.22 | TC-K2.T6.i 분배 1분 등록 | `pnpm -C apps/server test -t "TC-K2.T6.i" && pnpm -C apps/server test -t "TC-K1.T4.b"` | 통과 = 2 |
| G-K2.23 | 1분 주기 상수 | grep `name: "budget_rebalance", cron: "\* \* \* \* \*"` in `apps/server/src/jobs.ts` | == 1 |
| G-K2.21 | ruleset · TC-K2.T5.b | `node scripts/check-required-checks.mjs --repo henryj-dev/magnetosphere` | 종료코드 0 |
| G-K2.32 | TC-K2.T1.f 반올림 방향 (리뷰 L2) | `pnpm -C apps/server test -t "TC-K2.T1.f"` | 통과 = 1 |
| G-K2.33 ~ 36 | TC-K2.T7.f ~ i (리뷰 M1·L3·열린 질문) | `pnpm -C apps/server test -t "TC-K2.T7.<x>"` | 각 통과 = 1 |
| G-K2.37 ~ 40 | TC-K2.T6.l · m · o · p (리뷰 M2·L1·M3) | `pnpm -C apps/server test -t "TC-K2.T6.<x>"` | 각 통과 = 1 |
| G-K2.41 | TC-K2.T6.n clearBudget (계약, 리뷰 M3) | [L] `pnpm test:contract -t "TC-K2.T6.n"` | 통과 = 1 |
| G-K2.42 | clearBudget 은 무제한 전환 경로 한 곳 | grep `\.clearBudget\(` in `apps/server/src` | == 1 |
| G-K2.43 | TC-K2.T4.c 즉시 분배 실패 (리뷰 M4) | `pnpm -C apps/server test -t "TC-K2.T4.c"` | 통과 = 1 |
| G-K2.44 ~ 54 | 재현 빨강: TC-K2.T1.f · T7.f · T7.g · T7.h · T7.i · T6.l · T6.m · T6.o · T6.p · T4.c · T6.i | `node scripts/check-red.mjs --check <검사 ID> --since seal:K1` | 종료코드 0 |
| G-K2.55 | TC-K2.T7.j 지난달 분할 지움 (재검토 L-b) | `pnpm -C apps/server test -t "TC-K2.T7.j"` | 통과 = 1 |
| G-K2.56 ~ 60 | TC-K2.T6.t · u · q · r · s (재검토 H1·M-a·M-b·M-c·L-a) | `pnpm -C apps/server test -t "TC-K2.T6.<x>"` | 각 통과 = 1 |
| G-K2.61 ~ 66 | 재현 빨강: TC-K2.T7.j · T6.t · T6.u · T6.q · T6.r · T6.s | `node scripts/check-red.mjs --check <검사 ID> --since seal:K1` | 종료코드 0 |

`node scripts/gate.mjs K2 --seal`

가장 중요한 검사는 G-K2.11 이다. "여러 키로 나눠 써도 회원 한도에서 429"가 2단계 완료 기준 가운데 이 프로젝트가 새로 만드는 유일한 차단이다 (끈 키 거부·예산 차단 자체는 OmniRoute 기능이고 1단계 계약 시험이 이미 본다). 계산 함수 단위 TC 가 모두 초록이어도 분석의 `byApiKey` 묶음이 매핑과 어긋나면 이 계약 TC 만 빨개진다.

---

# K3 — 키 목표 상태·반영·정합성 점검 🔓 (K2 필요)

**브랜치** `p2/k3`.
**outputs** `apps/server/src/keys/**`, `apps/server/test/keys/**`, `apps/server/test/contract/keys/**`.

### ☑ K3.T1 — 목표 상태 함수
선행 없음 · 산출 `apps/server/src/keys/target.ts` · 되돌리기 커밋 1개

【작업】
1. `targetState({ keyState, disabledReason, userStatus, remaining })` → `deleted | off | on` (계획서 v5.6 5.7 식: 꺼짐 = 회원 status ≠ active 또는 disabled_reason ∈ {member, admin} 또는 남은 한도 0, `remaining` null 은 무제한). `disabled_reason` 넷(`member`·`admin`·`user_status`·`limit`)과 정지 해제·한도 회복 규칙. K1 의 최소 형태 `apps/server/src/queue/target.ts`(`keyTarget(api_keys.state, user.status)`, 작업 큐 `key.apply_state`가 실행할 때 부른다)를 이 함수로 바꾼다 — queue/target.ts 는 이 함수를 부르는 얇은 층이 된다. 커밋.

【테스트】
```
TC-K3.T1.a  조합 표가 계획서 v5.6 5.7 과 같다 (Q1 의존)
  단언:  keyState {active, disabled, deleted} × userStatus {pending, active, suspended, deleted} × remaining {null, 0, 0.5} 36 칸 == 기대 표 (deleted 는 keyState deleted 또는 userStatus deleted, on 은 userStatus active · keyState ≠ deleted · disabled_reason ∉ {member, admin} · remaining ≠ 0 뿐)
  검출:  pending 회원 키를 켜짐으로 계산해 승인 전 회원이 키를 쓰는 것, 남은 한도 0 을 무시해 limit 으로 끈 키를 반영·점검이 다시 켜는 것
TC-K3.T1.b  정지를 풀면 user_status 때문에, 한도가 생기면 limit 때문에 꺼진 키만 켠다 (Q1 의존)
  단언:  키 넷(disabled_reason member · admin · user_status · limit), 회원 suspended → active (remaining 0.5) → user_status·limit 키만 목표 on, member·admin off 유지. remaining 0 이면 넷 모두 off
  검출:  정지 해제·한도 상향이 회원 스스로 끈 키·관리자가 끈 키까지 켜는 것
```

【통과】
- [x] G-K3.1 · G-K3.2 통과

### ☑ K3.T2 — 반영: 즉시 실행, 실패하면 큐
선행 K3.T1 · 산출 `apps/server/src/keys/apply.ts` · 되돌리기 커밋 1개 · 장치 요구 `Red: TC-K3.T2.f`, `Red: TC-K3.T2.i`

【작업】
1. `applyKey(keyId)`: 목표 계산 → OmniRoute 상태가 다르면 즉시 `setKeyActive`. 목표가 삭제됨이면 즉시 `setKeyActive(false)` 하고 `key.delete` 작업을 끈 시각 + 2분 뒤로 잡는다 (계획서 v5.6 5.2, V18: 끈 뒤 60초가 지나야 DELETE 해도 옛 원문 키가 다시 열리지 않는다). 켜기 직전 `rebalanceMember`(K2.T4)로 예산을 먼저 건다. 2xx 면 `sync_state = synced`, 실패하면 `pending` + `key.apply_state` 작업(첫 재시도 1분, Q2). K2.T6 분배의 limit 끄기·켜기를 이 함수로 바꾼다. 끄기·정지는 반영이 끝나야 "완료" — API 응답은 `sync_state`를 그대로 준다 (화면 "반영 중" 표시는 4단계·7단계). 커밋.

【테스트】
```
TC-K3.T2.a  끄기는 응답 전에 OmniRoute 에 반영된다
  단언:  applyKey(목표 off) → 응답 전 setKeyActive(false) 1건, sync_state synced
  검출:  끄기를 큐에만 넣어 최대 1분 동안 끈 키가 동작하는 것 (V11: OmniRoute 는 PATCH 직후부터 403)
TC-K3.T2.b  OmniRoute 실패면 반영 중으로 남고 1분 뒤 재시도가 잡힌다 (Q2 의존)
  단언:  setKeyActive → OmniRouteError 503 → sync_state pending, key.apply_state 작업 1개, next_run_at − now == 60,000ms
  검출:  실패를 삼켜 synced 로 기록해 정합성 점검(5분) 전까지 꺼야 할 키가 켜져 있는 것
TC-K3.T2.c  목표가 켜짐이 아니면 켜지 않는다
  단언:  회원 suspended, 키 disabled_reason member → 회원이 켜기 요청 → 409, setKeyActive 0건
  검출:  회원이 자기 키를 켜는 경로로 정지를 우회하는 것
TC-K3.T2.d  켜기 전에 예산을 건다
  단언:  켜기 반영의 어댑터 호출 순서 == [getAnalytics, setBudget, setKeyActive(true)]
  검출:  한도를 다 쓴 회원의 꺼진 키를 켤 때 옛 예산(더 큰 값)으로 먼저 켜져 1분 분배 전까지 한도 밖 사용이 열리는 것
TC-K3.T2.e  삭제는 끄기 먼저, DELETE 는 끈 뒤 2분이 지나서다 (V18 의존)
  단언:  목표 삭제됨 → 응답 전 setKeyActive(false) 1건·deleteKey 0건, key.delete 작업 next_run_at − 끈 시각 == 120,000ms, 그 작업 실행 → deleteKey 1건
  검출:  바로 DELETE 해 OmniRoute 키 검증 캐시(60초) 동안 옛 원문 키가 예산·기록 없이 통과하는 것 (V18 rawKeyAfterDelete 200)
TC-K3.T2.f  작업 큐가 삭제 목표 키를 끄면 key.delete 를 끈 뒤 2분으로 잡는다 (V18 의존)
  단언:  state deleted 키의 key.apply_state 실행 → setKeyActive(false) 1건, key.delete 작업 next_run_at − 끈 시각 == 120,000ms, sync_state synced
  검출:  K1 핸들러가 삭제 목표 키를 끄기만 하고 key.delete 를 잡지 않아, 즉시 반영의 끄기가 실패해 큐로 넘어간 삭제가 OmniRoute 에 꺼진 키로 영영 남는 것
TC-K3.T2.g  정지·해제 반영이 admin 이유를 건드리지 않는다 (네 DB, K3 리뷰 #9)
  단언:  회원 suspended, 키 둘(disabled·admin, active) → applyKey 둘 → (disabled, admin)·(disabled, user_status) → 회원 active → applyKey 둘 → (disabled, admin)·(active, NULL)
  검출:  normalize 가 이유를 가리지 않고 user_status 로 덮어, 정지 해제가 관리자가 끈 키까지 켜는 것
TC-K3.T2.h  1분 분배의 limit 켜기가 실패하면 active·pending 으로 남고 큐가 1분 뒤 다시 켠다 (K3 리뷰 #9)
  단언:  limit 키, 한도 회복 → [getAnalytics, setBudget, setKeyActive(true)] 중 마지막 503 → state active·disabled_reason NULL·sync_state pending, key.apply_state next_run_at − 분배 시각 == 60,000ms
  검출:  DB 를 먼저 active 로 적은 뒤 켜기 실패를 삼켜, 꺼진 키가 "켜짐·synced" 로 보이거나 아무도 다시 켜지 않는 것
TC-K3.T2.i  OmniRoute 에서 사라진 키 하나가 회원의 다른 키 켜기를 막지 않는다 (K3 리뷰 #6)
  단언:  월 한도 5 회원, 켤 키 A·setBudget 이 404 인 키 B → applyKey(A) → A 켜짐·synced, B sync_state missing, alert.key_missing 1행(target B, 두 번 반영해도 1행)
  검출:  404 를 일반 실패로 세어 rebalanceMember 가 던지고, 사라진 키 하나 때문에 그 회원의 다른 키가 영영 켜지지 않는 것
```

【통과】
- [x] G-K3.3 ~ G-K3.6 · G-K3.18 · G-K3.20 · G-K3.22 통과
- [x] G-K3.24 ~ G-K3.26 · G-K3.33 통과 (K3 리뷰)

### ☑ K3.T3 — 정합성 점검 (5분)

> K1 메모 (K1 재검토): 작업 큐는 두 경우를 스스로 끝까지 맞추지 않고 이 점검에 맡긴다. (1) `key.apply_state` 핸들러의 "걸고 다시 읽기"는 두 번까지라, 그 사이 목표가 계속 바뀌면 어긋남이 남을 수 있다. (2) 한 tick 안에서 앞 작업이 오래 걸려 뒤 작업의 실패가 늦게 적히면, 다음 시도 전까지 OmniRoute 상태가 목표와 어긋난 채 남는다. 이 점검이 5분마다 모든 키를 목표 상태로 맞추므로 두 어긋남은 최대 5분이다. 이 단계의 TC 는 이 두 경우를 덮어야 한다.
선행 K3.T2 · 산출 `apps/server/src/keys/reconcile.ts`, `apps/server/test/contract/keys/**` · 되돌리기 커밋 1개 · 장치 요구 `Red: TC-K3.T3.f`, `Red: TC-K3.T3.i·j·l·m·n`

【작업】
1. `reconcile` 본문: `listKeys()` → 매핑된 키마다 실제 `isActive`를 목표와 비교해 `applyKey` (`sync_state failed` 키 포함, Q3). 매핑 없는 `m_` 키 → `audit_log` `alert.unknown_m_key` (Q6), 삭제·변경 없음. `m_` 키 중 `scopes`에 `manage`·`admin`이 있으면 끄고 `alert.manage_scope_key` (5.8). 회원 상태 변화(DB 에서 바뀐 정지·탈퇴)도 이 점검이 반영한다. 임대·펜싱 아래서 돈다. `JOBS`에 `{ name: "reconcile", cron: "*/5 * * * *" }`를 등록한다 (1단계 `JOB_CRON`과 wrangler crons 의 `"*/5 * * * *"`가 이미 있다). 커밋.

【테스트】
```
TC-K3.T3.a  OmniRoute 에서 켜진 키의 목표가 꺼짐이면 점검이 끈다 (계약)
  단언:  매핑 키를 어댑터(대시보드 쿠키 자격)로 setKeyActive(true) → 회원 status suspended(DB) → reconcile 1회 → listKeys 의 그 키 isActive false, 요청 403
  검출:  반영 실패·수동 조작으로 어긋난 상태가 영원히 남는 것 (정지한 회원이 계속 쓰는 것)
TC-K3.T3.b  매핑 없는 m_ 키는 알리기만 한다 (Q6 의존)
  단언:  OmniRoute 에 m_deadbeef_cafebabe 키(매핑 없음)와 다른 이름 키 하나 → audit_log action "alert.unknown_m_key" 1행(target 그 키 id), deleteKey·setKeyActive 0건
  검출:  자동 삭제로 운영자가 OmniRoute 에서 직접 만든 키나 복구 중인 매핑을 지우는 것
TC-K3.T3.c  scopes 에 manage 가 붙은 m_ 키는 끄고 알린다 (계약, V10)
  단언:  매핑 키에 scopes ["manage"]를 붙인다(시험 도구 tests/contract 의 대시보드 쿠키 호출, 어댑터는 scopes 를 못 보낸다) → reconcile 1회 → 그 키 isActive false, audit_log "alert.manage_scope_key" 1행, 회원 앱이 보낸 요청 본문에 scopes 0건
  검출:  write 토큰으로 회원 키에 manage 를 붙여 admin 토큰을 만드는 권한 상승(V10 privilegeEscalation)을 점검이 놓치는 것
TC-K3.T3.d  점검은 임대를 잃으면 멈춘다
  단언:  reconcile 중 renewLease false → 그 뒤 setKeyActive·deleteKey 0건
  검출:  두 인스턴스 점검이 같은 키를 번갈아 켜고 끄는 것
TC-K3.T3.f  정합성 점검은 5분마다 등록된다
  단언:  JOBS 의 reconcile cron == "*/5 * * * *", TC-K1.T4.b 재실행 통과
  검출:  점검을 1분 cron 에 걸어 OmniRoute 키 목록 전체를 매분 읽거나, 등록을 빠뜨려 어긋난 상태가 영영 안 맞춰지는 것
TC-K3.T3.e  탈퇴 회원 키는 점검이 삭제한다 (V18 의존)
  단언:  회원 status deleted(DB) → reconcile 1회 → setKeyActive(false) 1건·key.delete 작업(끈 뒤 2분) 1개 → 그 작업 실행 → deleteKey 1건, api_keys.state deleted, deleted_at 설정, 행은 남음
  검출:  탈퇴 회원 키가 OmniRoute 에 켜진 채 남거나, 매핑 행을 지워 그 키 사용액이 분석 합계에서 빠지는 것
TC-K3.T3.g  재시도를 다 쓴 키도 점검이 다시 맞춘다 (Q3 의존)
  단언:  sync_state failed 인 키(목표 off, OmniRoute isActive true) → reconcile 1회 → setKeyActive(false) 1건, sync_state synced
  검출:  failed 를 "포기"로 읽어 정지한 회원의 키가 다음 점검에서도 켜진 채 남는 것
TC-K3.T3.h  작업 큐가 남긴 어긋남을 점검이 맞춘다 (K1 메모)
  단언:  ① key.apply_state 실행 중 목표가 매번 뒤집혀 핸들러가 다시 읽기 상한(APPLY_ROUNDS)에서 끝나 OmniRoute ≠ 목표 ② 끄기 재시도가 10분 뒤로 잡힌(늦게 적힌 실패) 키 → reconcile 1회 → 둘 다 목표대로, sync_state synced
  검출:  점검이 sync_state·실제 isActive 를 보지 않고 큐에 맡겨, 큐가 스스로 끝까지 맞추지 않는 두 경우의 어긋남이 다음 시도(최대 30분)나 영영 남는 것
TC-K3.T3.i  manage 범위 키는 꺼진 이유와 상관없이 admin 으로 고정한다 (K3 리뷰 #1, V10)
  단언:  회원이 끈 키(member)에 scopes [manage] → reconcile → disabled_reason admin, alert.manage_scope_key 1행, 회원 켜기 요청 → KeyConflictError(409)
  검출:  member 로 꺼진 키는 admin 으로 바꾸지 않아, 회원이 다시 켜면 admin 급 키가 다음 점검까지 최대 5분 열리는 것
TC-K3.T3.j  점검은 시간 예산 안에서 멈추고 다음 실행이 이어 가며, 끊겨도 꺼진 키의 알림은 남는다 (K3 리뷰 #2)
  단언:  어긋난 키 다섯·한 실행에 셋(budgetMs) → 첫 실행 stopped true, 두 번째 stopped false, 다섯 모두 꺼짐. 매핑 없는 manage 키를 끈 다음 키에서 임대를 잃음 → 점검 실패, alert.manage_scope_key 1행
  검출:  시간 예산·이어 갈 위치가 없어 Workers 실행 시간 상한에 매번 앞쪽 키만 보고 끊기는 것, 알림을 끝에 몰아 써서 끊기면 키는 꺼졌는데 알림이 없는 것
TC-K3.T3.k  listKeys 는 limit 없이 모든 키를 한 번에 받는다 (계약, V28)
  단언:  OmniRoute 키 120개 이상 → listKeys 한 번 → 만든 키가 모두 있고 개수 ≥ 120
  검출:  목록이 기본 개수에서 잘려 뒤쪽 키(정지 회원 키·manage 키)를 점검이 영영 보지 못하는 것
TC-K3.T3.l  키 목록이 total 보다 적으면 형식 오류로 끝낸다 (V28, fail-closed)
  단언:  { keys 1개, total 2 } → OmniRouteFormatError, total 없음도 오류. 대조 { keys 1개, total 1 } → 그 키
  검출:  OmniRoute 가 페이지를 나누기 시작해도 잘린 목록을 전부로 읽는 것
TC-K3.T3.m  옛 목록 값으로 synced 를 적지 않는다 (K3 리뷰 #4)
  단언:  sync_state pending·목표 off 키, 목록 isActive false(옛 값)·실제 켜짐 → reconcile → setKeyActive(false) 1건, 실제 꺼짐, synced
  검출:  점검 시작 때 읽은 목록 값만 믿고 부르지 않은 채 synced 로 적어, 켜진 키가 "맞춰짐"으로 남는 것
TC-K3.T3.n  disabled 인데 이유가 없는 키는 alert.key_stuck 을 하루 한 번 남긴다 (K3 리뷰 #8)
  단언:  state disabled·disabled_reason NULL 키 → reconcile 두 번(같은 날) → alert.key_stuck 1행, setKeyActive 0건
  검출:  누가 왜 껐는지 모르는 키가 fail-closed 로 영영 꺼진 채 아무도 모르는 것
```

【통과】
- [x] G-K3.7 ~ G-K3.11 · G-K3.16 · G-K3.17 · G-K3.19 · G-K3.21 · G-K3.23 통과
- [x] G-K3.27 ~ G-K3.32 · G-K3.34 ~ G-K3.38 통과 (K3 리뷰)

### ◐ K3.T4 — K3 CI 잡과 봉인
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
| G-K3.1 · 2 | TC-K3.T1.a · b | `pnpm -C apps/server test -t "TC-K3.T1.<x>"` | 각 통과 = 1 (a 는 36 칸 표 한 테스트) |
| G-K3.3 ~ 6 | TC-K3.T2.a ~ d | `pnpm -C apps/server test -t "TC-K3.T2.<x>"` | 각 통과 = 1, b 는 next_run_at − now == 60,000ms |
| G-K3.18 | TC-K3.T2.e 삭제 순서 | `pnpm -C apps/server test -t "TC-K3.T2.e"` | 통과 = 1, 끄기 뒤 120,000ms |
| G-K3.20 | TC-K3.T2.f 큐의 삭제 반영 | `pnpm -C apps/server test -t "TC-K3.T2.f"` | 통과 = 1 |
| G-K3.24 | TC-K3.T2.g admin 이유 유지 | [L] `pnpm -C apps/server test:db -t "TC-K3.T2.g" --db sqlite,mysql,mariadb,pg` | 통과 = 4 |
| G-K3.25 · 26 | TC-K3.T2.h · i | `pnpm -C apps/server test -t "TC-K3.T2.<x>"` | 각 통과 = 1 |
| G-K3.7 | TC-K3.T3.a 어긋난 상태 맞춤 | [L] `pnpm test:contract -t "TC-K3.T3.a"` | 통과 = 1 |
| G-K3.8 | TC-K3.T3.b 매핑 없는 m_ 키 | `pnpm -C apps/server test -t "TC-K3.T3.b"` | 통과 = 1 |
| G-K3.9 | TC-K3.T3.c scopes manage 감지 | [L] `pnpm test:contract -t "TC-K3.T3.c"` | 통과 = 1 |
| G-K3.10 | TC-K3.T3.d 임대 잃으면 멈춤 | `pnpm -C apps/server test -t "TC-K3.T3.d"` | 통과 = 1 |
| G-K3.11 | TC-K3.T3.e 탈퇴 회원 키 | [L] `pnpm -C apps/server test:db -t "TC-K3.T3.e" --db sqlite,mysql,mariadb,pg` | 통과 = 4 |
| G-K3.19 | TC-K3.T3.g failed 키 다시 맞춤 | `pnpm -C apps/server test -t "TC-K3.T3.g"` | 통과 = 1 |
| G-K3.21 | TC-K3.T3.h 큐가 남긴 어긋남 | `pnpm -C apps/server test -t "TC-K3.T3.h"` | 통과 = 1 |
| G-K3.27 · 28 | TC-K3.T3.i · j | `pnpm -C apps/server test -t "TC-K3.T3.<x>"` | 각 통과 = 1 |
| G-K3.29 | TC-K3.T3.k 목록 전부 (V28) | [L] `pnpm test:contract -t "TC-K3.T3.k"` | 통과 = 1 |
| G-K3.30 | TC-K3.T3.l 목록 개수 검사 | `pnpm -C packages/omniroute test -t "TC-K3.T3.l"` | 통과 = 1 |
| G-K3.31 · 32 | TC-K3.T3.m · n | `pnpm -C apps/server test -t "TC-K3.T3.<x>"` | 각 통과 = 1 |
| G-K3.12 | 어댑터 키 수정 본문에 scopes 없음 (1단계 회귀) | [L] `pnpm test:contract -t "TC-S5.T2.i"` | 통과 = 2 (TC-S5.T2.i 는 테스트 둘) |
| G-K3.13 | 타입 검사 | `pnpm -r typecheck` | 종료코드 0 |
| G-K3.14 | TC-K3.T4.a CI 단계 잡 | grep `^\s+run: node scripts/gate\.mjs K3\b` in ci.yml | == 1 |
| G-K3.16 | TC-K3.T3.f 점검 5분 등록 | `pnpm -C apps/server test -t "TC-K3.T3.f" && pnpm -C apps/server test -t "TC-K1.T4.b"` | 통과 = 2 |
| G-K3.17 | 5분 주기 상수 | grep `name: "reconcile", cron: "\*/5 \* \* \* \*"` in `apps/server/src/jobs.ts` | == 1 |
| G-K3.22 · 23 | 재현 빨강 TC-K3.T2.f · TC-K3.T3.f | `node scripts/check-red.mjs --check G-K3.20 · G-K3.16 --since seal:K2` | 종료코드 0 |
| G-K3.33 ~ 38 | 재현 빨강 TC-K3.T2.i · T3.i · T3.j · T3.l · T3.m · T3.n | `node scripts/check-red.mjs --check G-K3.26 · 27 · 28 · 30 · 31 · 32 --since seal:K2` | 종료코드 0 |
| G-K3.15 | ruleset · TC-K3.T4.b | `node scripts/check-required-checks.mjs --repo henryj-dev/magnetosphere` | 종료코드 0 |

`node scripts/gate.mjs K3 --seal`

가장 중요한 검사는 G-K3.9 다. 계획서 5.8 이 적은 대로 `write` 토큰의 범위 제한은 침해 시 피해를 줄여 주지 못한다. 회원 키에 `manage`가 붙는 일을 잡는 장치는 이 점검 하나뿐이고, 그것이 계약 환경에서 실제로 재현돼야 의미가 있다.

---

# K4 — 키 수명주기와 회원 키 API 🔒 (K3 필요)

**브랜치** `k4/keys-api` (실행판을 쓸 때 정한 이름은 `p2/k4`).
**outputs** `apps/server/src/routes/**`, `apps/server/test/routes/**`, `apps/server/test/contract/routes/**`. 라우터를 거는 `apps/server/src/app.ts`는 공용 파일이라 넣지 않는다.

### ☑ K4.T1 — 발급 `POST /api/me/keys`
선행 없음 · 산출 `apps/server/src/routes/keys.ts` · 되돌리기 커밋 1개

【작업】
1. 경로는 `/api/me/keys` (0절 G-S5.9 제약). 회원 세션 필요. 확인(계획서 5.2 1번): 회원 status `active`, `emailVerified`, 키 수(활성 + 비활성, 삭제 제외) < `user.max_keys ?? app_settings.default_max_keys`, 남은 한도 > 0 (한도 NULL 이면 통과). 순서: `createKey(이름)` → `setKeyActive(false)` → 예산(K2 계산) → `setKeyActive(true)` → `api_keys` 행 → `rebalanceMember` → 원문을 응답에 한 번. 2~5 중 실패 → `deleteKey`로 되돌리고 502, 되돌리기도 실패 → `key.rollback` 작업. 이름 `m_<회원 id 앞 8자리>_<키 id 앞 8자리>`, DB 에는 `omniroute_key_id`와 끝 4자리만. 최대 개수 경쟁은 DB 한 문장 조건(D1 은 대화형 트랜잭션이 없으므로 조건부 INSERT 또는 batch)으로 막는다. 커밋.
   구현 (`routes/issue.ts`): 최대 개수 판정을 OmniRoute 호출 앞에 두려고 `api_keys` 행을 createKey 앞에서 자리 행(`omniroute_key_id = pending-<id>`, disabled·member)으로 먼저 넣는다. SQLite·D1 은 조건부 INSERT 한 문장, MySQL·Postgres 는 회원 행 `FOR UPDATE` 트랜잭션 안에서 세고 넣는다. 예산 단계는 행을 disabled·limit 으로 바꾼 뒤 `rebalanceMember` 하나로 한다 (분배가 limit 키에 예산을 건 뒤 켠다 — 예산이 성공한 뒤에만 켠다). 남은 한도 확인은 저장값만으로 0 이면 OmniRoute 를 부르지 않고, 아니면 그 회원 키의 오늘 창 분석(읽기) 한 번을 부른다.

【테스트】
```
TC-K4.T1.a  발급 순서가 계획서 5.2 와 같다
  단언:  가짜 어댑터 호출 기록 == [createKey, setKeyActive(false), setBudget, setKeyActive(true)], 응답 201 에 원문 1회·Cache-Control no-store (리뷰 L1). 예산이 성공한 뒤에만 켠다: 예산 단계(setBudget·rebalanceMember)가 성공한 뒤에만 setKeyActive(true) — rebalanceMember 는 반영 실패면 던진다 (K2 리뷰 M4, TC-K2.T4.c). 대조: setBudget 실패 → setKeyActive(true) 0건
  검출:  createKey 직후 켜진 채로 예산을 거는 순서라, 예산 단계가 실패하면 한도 없는 키가 켜진 채 남는 것
TC-K4.T1.b  2~5 단계 어디서 실패해도 만든 키를 지운다
  단언:  실패 위치 셋(끄기·예산·켜기) 각각 → deleteKey 1건, api_keys 행 0, 응답 502
  검출:  되돌리기를 첫 실패 위치에서만 해 예산 단계 실패 때 OmniRoute 에 m_ 키가 남는 것
TC-K4.T1.c  되돌리기도 실패하면 큐에 넣고 켜진 채 남지 않는다
  단언:  예산 실패 + deleteKey 가 OmniRouteError 503 → key.rollback 작업 1개, 그 키는 isActive=false 상태(끄기 단계까지만 진행)
  검출:  되돌리기 실패를 로그만 남겨 OmniRoute 에 매핑 없는 키가 남고 정합성 점검이 알리기만 해 영원히 남는 것
TC-K4.T1.d  거부 조건은 OmniRoute 를 부르지 않는다
  단언:  pending → 403, suspended → 403, emailVerified false → 403, 남은 한도 0 → 409 limit_exhausted, 최대 개수 → 409 max_keys. 각 경우 OmniRoute 호출 0. 남은 한도 0 을 오늘 창으로만 알 수 있으면 분석(읽기) 1건만, 키 쓰기 호출 0
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
TC-K4.T1.j  오래된 자리 행은 정합성 점검이 지운다 (K4 보안 리뷰 M2)
  단언:  created_at 이 10분(STALE_SLOT_MS 600,000)보다 오래된 pending- 자리 행 → reconcile 1회 → 행 0. 대조: 5분 된 자리 행은 그대로
  검출:  createKey 앞에서 죽은 발급의 자리 행이 최대 개수 한 칸을 영원히 차지해 회원이 키를 더 받지 못하는 것
TC-K4.T1.k  createKey 직후 죽어 남은 매핑 없는 m_ 키는 끄고 2분 뒤 지운다 (K4 보안 리뷰 M2)
  단언:  10분 넘은 자리 행과 이름 m_<회원8>_<자리 행8> 이 맞는 매핑 없는 키 → setKeyActive(false), key.delete next_run_at == 지금 + 120,000ms, 행 0, alert.unknown_m_key 0. 대조: 10분 안 된 자리 행의 키·id 가 안 맞는 m_ 키는 끄지 않고 알리기만. 끄기 실패면 행을 남겨 다음 점검이 다시 본다
  검출:  정합성 점검이 알리기만 해(Q6) 회원 앱이 만든 키가 예산 없이 켜진 채 남는 것
TC-K4.T1.l  자리 잡기 reserveSlot 을 직접 10건 동시에 불러도 최대 개수를 넘지 않는다 (K4 보안 리뷰 시험 보강)
  단언:  HTTP·앞 확인 없이 연결 둘에서 reserveSlot 10건 (최대 2) → true 정확히 2, 옛 키를 뺀 재발급 자리는 1 (sqlite·mysql·mariadb·pg·d1)
  검출:  앞 확인(liveKeyCount)이 경쟁을 우연히 막아 TC-K4.T1.f 는 초록인데 조건부 INSERT·행 잠금이 빠져 있는 것
```

【통과】
- [x] G-K4.1 ~ G-K4.9 통과
- [x] G-K4.31 · 32 · 35 · 36 통과

### ☐ K4.T2 — 이름 변경·끄기·켜기·재발급·삭제 (폐기)
v5.6 에서 폐기 (V18·V19). `regenerate`와 바로 `DELETE`는 옛 원문 키를 최대 60초 동안 예산·기록 없이 통과시킨다. 재발급·삭제 방식을 바꾼 K4.T7 이 대신한다. TC-K4.T2.a~e 는 쓰지 않는다.

### ☑ K4.T7 — 이름 변경·끄기·켜기·재발급·삭제 (v5.6)
선행 K4.T1 · 산출 `apps/server/src/routes/keys.ts` · 되돌리기 커밋 1개

【작업】
1. `PATCH /api/me/keys/:id {label}`(DB 만), `POST /api/me/keys/:id/disable`·`enable`(K3 `applyKey`, `disabled_reason member`), `POST /api/me/keys/:id/regenerate`(계획서 v5.6 5.2: 새 키를 K4.T1 발급 순서로 만들고 옛 키를 아래 삭제 순서로 지운다. 발급 조건은 발급과 같고 최대 개수는 옛 키를 빼고 센다. 새 원문 1회, `rebalanceMember`. OmniRoute `regenerate`는 부르지 않는다), `DELETE /api/me/keys/:id`(`state deleted`, `deleted_at`, 행 유지 → K3 `applyKey`가 즉시 끄고 `key.delete`를 끈 뒤 2분으로 잡는다). 남의 키는 모두 404. 커밋.

【테스트】
```
TC-K4.T7.a  이름 변경은 OmniRoute 를 부르지 않는다
  단언:  PATCH label → 200, OmniRoute 호출 0
  검출:  label 을 OmniRoute 키 이름에 써 개인정보 규칙(m_ 이름)을 깨는 것
TC-K4.T7.b  삭제는 바로 끄고, 행을 남기고, DELETE 는 2분 뒤다 (V18 의존)
  단언:  DELETE → 응답 전 setKeyActive(false) 1건·deleteKey 0건, state deleted, deleted_at 설정, key.delete 작업 next_run_at == 끈 시각 + 120,000ms, 다음 분배의 분석 apiKeyIds 에 그 id 포함
  검출:  행을 지워 그 키의 이번 달 사용액이 회원 합계에서 빠지는 것, 바로 DELETE 해 옛 원문 키가 60초 동안 예산·기록 없이 통과하는 것
TC-K4.T7.c  재발급은 새 키 + 옛 키 삭제이고 한도를 초기화하지 않는다 (V19 의존)
  단언:  재발급 → 어댑터 호출 == [createKey, setKeyActive(false), setBudget, setKeyActive(true), setKeyActive(false) (옛 키)], regenerate 경로 호출 0, 응답 새 원문(Cache-Control no-store, 리뷰 L1), 옛 행 state deleted, 다음 분배 분석 apiKeyIds 에 옛 id·새 id 둘 다
  검출:  OmniRoute regenerate 를 써 옛 원문 키가 60초 동안 통과하거나(V19 oldKeyStatus 200), 옛 id 를 버려 사용액이 0 에서 시작하는 것
TC-K4.T7.d  남의 키는 404 이고 OmniRoute 를 부르지 않는다
  단언:  회원 B 세션으로 A 키에 disable·enable·regenerate·DELETE·PATCH → 모두 404, OmniRoute 0
  검출:  키 id 만으로 조회해 다른 회원 키를 끄거나 재발급해 원문을 가져가는 것
TC-K4.T7.e  회원이 끈 키는 회원이 켤 수 있다
  단언:  disable(member) → enable → 200, setKeyActive(true) 1건. admin 이 끈 키 → enable 403, limit 으로 꺼진 키 → enable 409 limit_exhausted, 이메일 미인증 회원 → enable 403 email_unverified (리뷰 L2)
  검출:  관리자가 끈 키나 한도 때문에 꺼진 키를 회원이 다시 켜는 것, 발급 조건(이메일 인증)을 켜기로 비켜 가는 것
TC-K4.T7.f  재발급도 발급 조건을 본다
  단언:  최대 2·키 2개에서 재발급 → 201 (옛 키를 빼고 셈), 남은 한도 0 → 409 limit_exhausted·OmniRoute 0
  검출:  재발급을 발급 조건 없이 열어 한도를 다 쓴 회원이 새 키를 받거나, 최대 개수에 막혀 키를 교체하지 못하는 것
TC-K4.T7.g  발급 중인 자리 행은 회원이 바꾸지 못한다 (K4 보안 리뷰 M1)
  단언:  발급 도중 GET → 그 행 state issuing(remainingSlots 에 듦), enable·disable·PATCH·regenerate·DELETE → 409 issuing, pending- id 로 OmniRoute 호출 0·alert.key_missing 0, 발급은 201. 예산 단계 전에 행이 바뀌면 → 409·[createKey, setKeyActive(false), deleteKey]·행 0. K3 markMissing 은 pending- id 에 쓰지 않는다
  검출:  목록으로 얻은 자리 행 id 로 enable 해 pending- id 에 예산·켜기를 보내고(404 → 거짓 alert.key_missing), 조건 없는 UPDATE 가 active·limit 모순 상태를 만드는 것
```

【통과】
- [x] G-K4.10 ~ G-K4.14 · G-K4.28 · G-K4.30 통과

### ☑ K4.T3 — 관리자 한도·최대 개수 API
선행 K4.T1 · 산출 `apps/server/src/routes/admin-limits.ts` · 되돌리기 커밋 1개

【작업】
1. `PATCH /api/admin/users/:id {monthlyLimitUsd?, maxKeys?}` (관리자 세션). 값 검사(한도 null 또는 0 이상 `DECIMAL(12,6)` 범위·소수 6자리 이하, maxKeys null 또는 0 이상 정수). 저장 → `rebalanceMember` → `audit_log` 1행. 커밋.

【테스트】
```
TC-K4.T3.a  관리자만 바꾸고, 바꾸면 즉시 분배한다
  단언:  회원 세션 → 403, 세션 없음 → 401, 관리자 → 200 + rebalanceMember 1회 + audit_log(action limits.update) 1행. 한도를 null 로 바꾸면 clearBudget 1건 (리뷰 시험 보강)
  검출:  회원이 자기 한도를 올리는 것, 또는 한도를 내려도 1분 분배까지 옛 예산이 남는 것
TC-K4.T3.b  잘못된 값은 400 이다
  단언:  -1 · NaN · "5" · 1e13 · 0.0000001 · maxKeys 1.5 · maxKeys -1 → 각각 400, DB 변화 0
  검출:  음수 한도가 저장돼 남은 한도 계산이 모든 키를 막거나, 1e13 이 DECIMAL(12,6) 를 넘어 MySQL 에서 잘려 저장되는 것
```

【통과】
- [x] G-K4.15 · G-K4.16 통과

### ☑ K4.T4 — 변경 API 의 CSRF 와 발급 요청 수 제한
선행 K4.T1 · 산출 `apps/server/src/routes/guard.ts` · 되돌리기 커밋 1개

【작업】
1. `/api/me/keys*`·`/api/admin/*`의 GET 아닌 요청은 `Origin`이 `BETTER_AUTH_URL` 출처와 같아야 한다 (7장 "회원 앱 변경 API는 CSRF 보호"). 키 발급·재발급 요청 수 제한은 계획서 v5.6 Q4: 회원당 1시간 10회, 클라이언트 IP 당 1시간 30회, 넘으면 429. `rate_limit` 테이블(여러 인스턴스 공유)을 쓴다. 커밋.

【테스트】
```
TC-K4.T4.a  다른 출처의 변경 요청은 403 이다
  단언:  Origin https://evil.example 로 POST /api/me/keys · DELETE /api/me/keys/:id → 403, OmniRoute 0. Origin 없음 → 403. 같은 출처 → 정상
  검출:  SameSite=Lax 쿠키만 믿어, 같은 사이트의 다른 하위 도메인 페이지가 회원 키를 발급·삭제하는 것
TC-K4.T4.b  발급 요청 수 제한을 넘으면 429 다 (Q4 의존)
  단언:  같은 회원이 1시간 안에 발급·재발급 11번(최대 개수 넉넉히) → 11번째 429·OmniRoute 호출 없음, 다른 인스턴스(같은 DB)에서도 같은 계산. 같은 IP 의 회원 넷이 합쳐 31번 → 31번째 429 (sqlite·mysql·mariadb·pg)
  검출:  인스턴스 메모리로 세어 인스턴스 수만큼 한도가 늘거나, 발급·삭제 반복으로 OmniRoute 에 키 생성 요청을 퍼붓는 것
TC-K4.T4.c  키 변경 요청은 회원당 분당 30회까지다 (K4 보안 리뷰 L3)
  단언:  이름 변경 30번 → 200, 31번째부터 disable·enable·regenerate·DELETE·PATCH → 429 too_many_requests, OmniRoute 호출 0. 다른 회원은 200
  검출:  켜기·끄기·삭제를 끝없이 보내 회원 하나가 OmniRoute 호출과 작업 큐를 채우는 것
TC-K4.T4.d  발급 요청 수 제한의 IP 칸은 IPv6 를 /64 로 묶는다 (K4 보안 리뷰 L4)
  단언:  ipBucket: 같은 /64 의 다른 표기·주소 → 같은 칸, 다른 /64 → 다른 칸, ::ffff:a.b.c.d == a.b.c.d. 같은 /64 의 주소 30개로 회원 셋이 30번 → 넷째 회원 31번째 429, 다른 /64 는 201
  검출:  IPv6 회선이 /64 안에서 주소를 바꿔 IP 당 제한을 비켜 가는 것
```

【통과】
- [x] G-K4.17 · G-K4.18 · G-K4.33 · G-K4.34 통과

### ☑ K4.T5 — 실제 OmniRoute 로 수명주기 (계약)
선행 K4.T1 · K4.T3 · K4.T4 · K4.T7 · 산출 `apps/server/test/contract/routes/**` · 되돌리기 커밋 1개

【작업】
1. 회원 앱(계약 환경 OmniRoute 에 연결)으로 발급 → 그 원문으로 `/v1/messages`(모델 `mka/claude-mock`) → 끄기 → 켜기 → 삭제 → `key.delete` 작업 실행(가짜 시계 + 2분, 실제 대기 65초 — OmniRoute 키 검증 캐시 60초). 커밋.

【테스트】
```
TC-K4.T5.a  발급한 키로 Anthropic 형식 요청이 되고, 끄면 403, 지우면 바로 거부되고 DELETE 뒤 401 이다 (V18 의존)
  단언:  POST /api/me/keys → 원문 → /v1/messages 200 → disable → 다음 요청 403 permission_denied(지연 0ms, V11) → enable → 200 → DELETE /api/me/keys/:id → 다음 요청 403 (끈 상태) → 65초 뒤 key.delete 실행 → listKeys 에 그 키 없음, 다음 요청 401
  검출:  발급 순서의 마지막 켜기가 빠지거나 끄기가 큐로만 가서 "끈 키 거부"(완료 기준)가 지연되는 것
TC-K4.T5.b  남은 한도 0 인 회원은 발급이 막히고 OmniRoute 에 키가 늘지 않는다
  단언:  한도 0.01, 키 하나로 요청 3건 → 분배 → 키 삭제 → 새 발급 409 limit_exhausted, listKeys 의 그 회원 m_ 키 수 변화 0
  검출:  "삭제·재발급으로 한도가 초기화되지 않음"(완료 기준)을 발급 거부가 아니라 1분 분배에만 맡겨 새 키로 1분 동안 쓰는 것
```

【통과】
- [x] G-K4.19 · G-K4.20 통과

### ◐ K4.T6 — K4 CI 잡과 봉인
선행 K4.T1 · K4.T3 ~ K4.T5 · K4.T7 · 산출 `.github/workflows/ci.yml` · 되돌리기 커밋 1개

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
| G-K4.10 ~ 14 | TC-K4.T7.a ~ e | `pnpm -C apps/server test -t "TC-K4.T7.<x>"` | 각 통과 = 1. b 는 끄기 뒤 120,000ms |
| G-K4.28 | TC-K4.T7.f 재발급 조건 | `pnpm -C apps/server test -t "TC-K4.T7.f"` | 통과 = 1 |
| G-K4.15 · 16 | TC-K4.T3.a · b | `pnpm -C apps/server test -t "TC-K4.T3.<x>"` | 각 통과 = 1 |
| G-K4.17 | TC-K4.T4.a CSRF | `pnpm -C apps/server test -t "TC-K4.T4.a"` | 통과 = 1 |
| G-K4.18 | TC-K4.T4.b 발급 요청 수 제한 | [L] `pnpm -C apps/server test:db -t "TC-K4.T4.b" --db sqlite,mysql,mariadb,pg` | 통과 = 4 |
| G-K4.19 | TC-K4.T5.a 발급·끄기·삭제 | [L] `pnpm test:contract -t "TC-K4.T5.a"` | 통과 = 1, 끈 뒤 첫 요청 403, 삭제 뒤 첫 요청 403 |
| G-K4.20 | TC-K4.T5.b 한도 0 발급 거부 | [L] `pnpm test:contract -t "TC-K4.T5.b"` | 통과 = 1 |
| G-K4.21 | 발급 순서 (5.2 의 2~5번) 기대값 | grep `"createKey", "setKeyActive\(false\)", "setBudget", "setKeyActive\(true\)"` in `apps/server/test/routes` | == 1 |
| G-K4.22 | 원문 키 저장 칼럼 없음 | grep `\b(key_raw\|raw_key\|secret_key)\b` in `packages/db/src/schema` | == 0 |
| G-K4.23 | 어댑터 밖 관리 호출 0 (1단계 G-S5.9 와 같은 규칙) | grep `/api/(keys\|usage)` in `apps packages`, `packages/omniroute/**` 제외 | == 0 |
| G-K4.24 · 29 | 시드 기본값 (최대 키 2, 월 한도 $5) | grep `default_max_keys: 2,` · `default_limit_usd: 5,` in `packages/db/src/seed.ts` | 각 == 1 |
| G-K4.25 | 타입 검사 | `pnpm -r typecheck` | 종료코드 0 |
| G-K4.26 | TC-K4.T6.a CI 단계 잡 | grep `^\s+run: node scripts/gate\.mjs K4\b` in ci.yml | == 1 |
| G-K4.30 | TC-K4.T7.g 발급 중인 자리 행 (리뷰 M1) | `pnpm -C apps/server test -t "TC-K4.T7.g"` | 통과 = 1 |
| G-K4.31 · 32 | TC-K4.T1.j · k 죽은 발급 정리 (리뷰 M2) | `pnpm -C apps/server test -t "TC-K4.T1.<x>"` | 각 통과 = 1 |
| G-K4.33 · 34 | TC-K4.T4.c · d 변경 요청 수·IPv6 /64 (리뷰 L3·L4) | `pnpm -C apps/server test -t "TC-K4.T4.<x>"` | 각 통과 = 1 |
| G-K4.35 | TC-K4.T1.l 자리 잡기 직접 동시 (Node DB 넷) | [L] `pnpm -C apps/server test:db -t "TC-K4.T1.l" --db sqlite,mysql,mariadb,pg` | 통과 = 4 |
| G-K4.36 | TC-K4.T1.l 자리 잡기 직접 동시 (D1) | [L] `pnpm -C apps/server test:workers -t "TC-K4.T1.l"` | 통과 = 1 |
| G-K4.37 ~ 45 | 재현 빨강 TC-K4.T1.c · T7.g · T1.j · T1.k · T1.a · T7.c · T7.e · T4.c · T4.d | `node scripts/check-red.mjs --check G-K4.3 · 30 · 31 · 32 · 1 · 12 · 14 · 33 · 34 --since seal:K3` | 종료코드 0 |
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
  단언:  키 둘로 번갈아 요청해 회원 총 사용액이 한도($0.02)에 닿으면 곧바로 두 키로 몰아 쓴다 (키마다 연달아, 거부될 때까지) →
         두 키 모두 거부 (isBudgetBlocked 또는 limit 끄기의 403), 몰아 쓴 뒤 총 사용액 ≤ 0.02 × 2 + 0.004878.
         한도에 닿은 시각부터 125,000ms 안에 분배가 두 키를 limit 으로 끈다 (비용 없는 탐침이 403 permission_denied, v5.6 Q1)
  검출:  한 조합의 분배 작업이 돌지 않는 것 (Workers crons 에 "* * * * *" 누락, MySQL 임대 판정 오류 등) — 그 조합에서만 한도가 안 걸린다.
         분배가 키 예산을 "그 키 사용액 + 남은 한도"가 아니라 "그 키 사용액 + 한도 전체"로 거는 것 — 몰아 쓰면 한도 × 2 를 넘는다 (K5 리뷰 M1)
TC-K5.T2.c  삭제·재발급으로 한도가 초기화되지 않는다 (여섯 조합)
  단언:  b 뒤 두 키 삭제 → 새 발급 409 limit_exhausted. 한도 $0.06 으로 올린 뒤 발급 → 그 키 예산 == 0.06 − 총 사용액 (오차 1e-6).
         올린 한도는 b 의 몰아 쓴 뒤 총 사용액 상한(0.044878)보다 커야 한다 (K5 리뷰 M1 뒤 $0.04 는 총 사용액보다 작을 수 있다)
  검출:  삭제 키 사용액이 회원 합계에서 빠지는 조합(매핑 행 삭제, 분석 apiKeyIds 누락)
TC-K5.T2.d  재발급으로 한도가 초기화되지 않는다 (여섯 조합, V19 의존)
  단언:  한도 도달 뒤 남은 키 재발급 → 409 limit_exhausted, 옛 원문의 다음 요청 403. 한도를 올린 뒤 재발급 → 새 원문 200·옛 원문 바로 403·그 키 예산 == 한도 − 총 사용액 (옛 id 사용액 포함, 오차 1e-6)
  검출:  재발급이 누적 지출 0 인 새 키를 만들어 한도를 다 쓴 회원이 다시 쓰거나, OmniRoute regenerate 로 옛 원문이 60초 동안 기록 없이 통과하는 것
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
| G-K5.3 | TC-K5.T2.a~d docker-sqlite | [L] `pnpm e2e --combo docker-sqlite --scenario keys` | 종료코드 0 — 끈 뒤 첫 요청 403, 분배가 키를 끄기까지 ≤ 125,000ms (지출 기록 60초 + 분배 1분 + 5초), 몰아 쓴 뒤 초과 폭 ≤ 0.02 × 2 + 0.004878, 삭제 뒤 발급 409 |
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

**K5 리뷰에서 넘김 (L4·L5·L6)** K5 리뷰의 낮은 등급 지적 셋은 K5 에서 고치지 않고 이 단계에서 검토한다. L6 의 근거가 되는 조합별 한도 반영 시간(reactMs)은 K5 PR(#10) 본문 표에 남겼다.

**백로그 (K1 리뷰 #9)** 끝난 작업(`omniroute_jobs.done_at`) 정리: 기본 30일이 지난 완료 작업을 지우는 주기 정리를 둘지, 감사 로그(`audit_log`)로 대신할 수 있는지(완료 작업에 남는 정보가 감사 로그에 이미 있는가) 검토하고 정한다. 실패 작업(`failed_at`)은 정리하지 않는다 (오래 실패 화면, 7단계).
- **결정: 주기 정리 (K6.T4)**. 감사 로그로는 대신하지 못한다 — 끝난 작업이 담은 것(action·payload 의 키 id·시도 횟수·끝난 시각)은 `audit_log`에 없다. 큐가 `audit_log`에 쓰는 것은 실패(`alert.job_failed`)뿐이고, 키 API 는 끄기·켜기·삭제를 `audit_log`에 쓰지 않는다. 그래도 끝난 행은 아무도 다시 읽지 않는다: 미완료 작업 찾기(`runDue`·키별 합치기·delete 우선)는 모두 `done_at IS NULL` 이고, 반영 결과는 `api_keys`(state·sync_state)에 남는다. 남겨 둘 값이 없는 행이 키 삭제마다(`key.delete`) 하나씩 끝없이 쌓이므로, 운영자가 최근 반영 이력을 볼 수 있는 30일만 두고 지운다. 정리는 1분 작업 큐 실행기 안에서 같은 임대로 펜싱해 한 문장 `DELETE` 로 한다 (작고, 새 주기·cron 을 더하지 않는다).

### ☑ K6.T1 — 임시 코드 회수
선행 없음 · 산출 없음 (검사만) · 되돌리기 해당 없음

【작업】
1. K1~K5 가 시험을 위해 넣은 주입점은 함수 인자(`now`, `fetch`, `signal`)만 허용한다. 환경 변수로 켜는 시험 갈림길·가짜 시계를 운영 코드에서 지운다. 꺼진 테스트·미구현 표식도 0 으로. 커밋.
   - 결과: 시작할 때 이미 둘 다 0 이었다. 운영 코드(`apps/server/src`·`packages/*/src`)가 읽는 환경 변수는 `DATABASE_URL`(마이그레이션)과 런타임 설정 값(`PORT`·`HOST`·`TRUSTED_PROXIES` 등)뿐이고, 시험은 시계·`fetch`·신호를 함수 인자로 넘긴다 (예: `runDue(h, handlers, now, { clock })`). 지울 코드가 없어 검사(G-K6.1·2)만 넣었다.
   - 음성 대조 (커밋 안 함): `packages/runtime/src/types.ts` 에 `process.env.E2E_FAST` 한 줄 → G-K6.1 실패 (1 / == 0). `test/` 에 `it.skip(` 파일 하나 → G-K6.2 실패 (1 / == 0). 두 번째는 1단계 G-S7.3 이 보지 않던 `test/` 경로다.

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
- [x] G-K6.1 · G-K6.2 통과

### ☑ K6.T2 — 운영 문서에 5.3 한계
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
- [x] G-K6.3 · G-K6.14 통과 (G-K6.14 는 TC 단언의 둘째 줄 "추정 ≥ 1" 이다)
- 음성 대조 (커밋 안 함): 두 문장을 "남은 한도 곱하기 키 수"·"값" 으로 바꾸면 G-K6.3 (0 / == 1)·G-K6.14 (0 / >= 1) 실패

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

### ☑ K6.T4 — 끝난 작업 정리 (K1 리뷰 #9)
선행 없음 · 산출 없음 (기존 `apps/server/src/queue/index.ts`·`runner.ts`) · 되돌리기 커밋 2개 · 장치 요구 `Red: TC-K6.T4.a, TC-K6.T4.b`

【작업】
1. 재현 시험 `apps/server/test/queue/prune.db.test.ts`(네 DB)·`prune.test.ts`. 꼬리줄 `Red: TC-K6.T4.a, TC-K6.T4.b`. 커밋.
2. `pruneDone(h, now, { lease })`: `done_at IS NOT NULL AND failed_at IS NULL AND done_at < now − DONE_RETENTION_MS(30일)` 을 지운다. 임대를 주면 `fenced()`. `queueJob`이 OmniRoute 연결 확인보다 먼저 부른다 (정리가 실패하면 경고만 남기고 재시도는 그대로 돈다). 커밋.

【테스트】
```
TC-K6.T4.a  done_at 이 30일 넘은 작업만 지운다 (네 DB)
  단언:  done_at = now − 30일 − 1초 · now − 30일 + 1초 · failed_at 만 90일 전 · 둘 다 60일 전 · 미완료 → pruneDone == 1, 남은 행 = 뒤 넷. 다른 실행기가 임대를 가져간 뒤 옛 임대로 pruneDone → 0, 60일 전 끝난 행 남음
  검출:  실패 작업까지 지워 오래 실패 화면(7단계)과 alert.job_failed 의 대상이 사라지는 것, 임대를 잃은 실행기가 펜싱 없이 지우는 것, timestamp 비교가 DB 방언마다 달라 30일 안 작업을 지우는 것
TC-K6.T4.b  1분 작업 큐 실행기가 정리를 부른다
  단언:  OMNIROUTE_URL 없는 Runtime 으로 queueJob 한 번 → done_at 31일 전 행 0, 1일 전 행·실패 행 남음
  검출:  pruneDone 은 있는데 어디서도 부르지 않아 omniroute_jobs 가 계속 커지는 것
```

【통과】
- [x] G-K6.10 ~ G-K6.13 통과
- 음성 대조 (커밋 안 함): `failed_at IS NULL` 조건 제거 · 펜싱 제거 · 보존 29일 → TC-K6.T4.a 네 DB 모두 실패. `queueJob` 에서 호출 제거 → TC-K6.T4.b 실패

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
| 삭제·재발급 뒤 옛 원문 키 | 첫 요청부터 거부 (403) | G-K4.19, G-K4.10 ~ 14, TC-K5.T2.d |
| 삭제·재발급으로 한도 초기화 | 0 / 6 조합 | G-K5.3 ~ 8 (TC-K5.T2.c·d), G-K4.20 |
| 한도 반영 시간 | ≤ 125,000ms (지출 기록 60초 + 분배 1분 + 5초) | TC-K5.T2.b |
| 초과 폭 | ≤ 한도 × 최대 키 2 + 요청 1건 | G-K2.14, TC-K5.T2.b |
| 최대 키 기본값 | 2 (활성 + 비활성, 삭제 제외) | G-K4.5, G-K4.24 |
| 동시 발급 최대 개수 초과 | 0 (다섯 DB) | G-K4.6, G-K4.7 |
| 분배 주기 · 정합성 점검 주기 | 1분 · 5분 | G-K2.22, G-K2.23, G-K3.16, G-K3.17, G-K1.13 |
| 재시도 간격 | 1분 · 2분 · 10분 · 30분 (첫 반영 실패 뒤 1분, v5.6 Q2) | G-K1.7, G-K1.17, G-K3.4 |
| 삭제 뒤 DELETE | 끈 시각 + 2분 (OmniRoute 키 검증 캐시 60초, V18) | G-K3.18, G-K4.10 ~ 14 |
| 분석 API (기록 300,000 · 키 300) | 오늘 창 p95 ≤ 2,000ms · 회원 p95 ≤ 1,000ms · 대조 ≤ 55,000ms (v5.7) | G-K0.19 ~ G-K0.23, G-K0.39 |
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
| TC-K0.T7.a, TC-K2.T6.h, TC-K2.T6.k, TC-K2.T7.a ~ d | V15 측정·호출 방식 (v5.7: 오늘 창 + usage_daily) | 계획서 5.3 실행 시점 개정 |
| TC-K2.T6.e | V18 삭제 키 기록 유지 | 계획서가 대안(삭제 전 사용액 보존) 결정, K1 스키마 |
| TC-K0.T9.a, TC-K4.T7.c, TC-K5.T2.d | V19 regenerate id·지출 유지·옛 원문 키 | 계획서 5.2 개정 (v5.6: 재발급 = 새 키 + 옛 키 삭제), K4 재발급 |
| TC-K0.T8.a, TC-K3.T2.e, TC-K3.T2.f, TC-K3.T3.e, TC-K4.T7.b, TC-K4.T5.a | V18 삭제 뒤 옛 원문 키·키 검증 캐시 60초 | 계획서 5.2 개정 (v5.6: 끄고 60초 뒤 DELETE), K3 반영·K4 삭제 |
| TC-K3.T3.k, TC-K3.T3.l | V28 키 목록은 limit 없이 전부·total | K3 리뷰 #3 (설계를 막지 않음) |
| TC-K0.T10.a·b·c, TC-K2.T2.a | V20 시간대·경계값 | 계획서 5.3 개정 (Q1 과 함께) |
| TC-K1.T3.a, TC-K1.T4.a, TC-K3.T2.b | Q2 재시도 간격 1분·2분·10분·30분, 실행기 1분 | 계획서 v5.6 5.7 |
| TC-K1.T3.b, TC-K3.T3.g | Q3 재시도 소진 → failed, 점검이 다시 맞춤, 30분 오래 실패 | 계획서 v5.6 5.7 |
| TC-K2.T1.b, TC-K2.T1.d, TC-K2.T6.f, TC-K2.T6.j, TC-K3.T1.a, TC-K3.T1.b | Q1 남은 한도 0 이면 키 끄기(limit), 회복하면 켜기 | 계획서 v5.6 5.3·5.7 |
| TC-K2.T2.c | Q5 1분 분배가 달 바뀜 판단 | 계획서 v5.6 5.3 |
| TC-K1.T3.b, TC-K3.T3.b, TC-K3.T3.c, TC-K3.T2.i, TC-K3.T3.n | Q6 알림 = audit_log alert.<종류> | 계획서 v5.6 5.7 |
| TC-K4.T4.b | Q4 발급 요청 수 회원 10회·IP 30회 / 1시간 | 계획서 v5.6 5.2·7장 |

## 코드 미확인 TC 목록

1단계 코드(`packages/omniroute/src/index.ts`, `packages/runtime/src/{lease,node,workers,types}.ts`, `apps/server/src/{jobs,workers}.ts`, `apps/server/wrangler.toml`, `packages/db/src/schema/common.ts`·`seed.ts`, `scripts/gate.mjs`·`check-ci-matrix.mjs`·`check-verify.mjs`, `tests/contract/*`)는 열어 보고 검출줄에 그 사실을 적었다. 아래는 기대는 코드나 동작이 아직 없어 열어 보지 못한 것이다.

| TC | 열어 보지 못한 것 | 처음 확인되는 곳 |
|---|---|---|
| TC-K0.T10.c | OmniRoute 3.8.51 의 월 예산 기간 시작 계산 함수와 그 값을 읽는 방법 | K0.T10 (이미지 안 소스) |
| TC-K0.T7.a | OmniRoute 기록 저장 테이블(직접 삽입 시) | K0.T7 |
| TC-K1.T4.c | `wrangler dev --test-scheduled`의 `/__scheduled` 경로가 이 저장소 wrangler 버전에서 cron 별로 동작하는지 | K1.T4 |
| TC-K5.T1.a | 고정할 `@anthropic-ai/claude-code` 버전의 인자(`--setting-sources`, `--max-turns`)가 V16 때와 같은지 | K5.T1 |
| TC-K5.T2.a ~ d | `tests/e2e/run.mjs`에 `--scenario` 인자를 더할 자리 (지금은 조합 하나의 고정 흐름) | K5.T2 |
