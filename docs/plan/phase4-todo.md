# Magnetosphere 4단계 "회원 화면·사용량" — 실행 목록

계획은 [`../design/omniroute-member-layer.md`](../design/omniroute-member-layer.md) (v5.8, A2 가 v5.9 로 올림) 와 통합 계획(자체 회원 기반과 선택형 SSO, 4절 A·A1·B, 1절 결정 표)이다. 이 문서는 4단계의 순서·통과 조건·잠금만 적는다. 관리자 MFA 설계는 [`phase4-a1-admin-mfa.md`](phase4-a1-admin-mfa.md) 다.

## 확정 사항과 사용자에게 묻는 설계 질문

### 확정 사항 (바꾸려면 사용자 결정이 다시 필요하다)

| 항목 | 내용 | 근거 |
|---|---|---|
| 순서 | A1 관리자 MFA → A2 공통 회원 수치 정렬 → U1 기본 회원 화면·최소 관리자 화면 → U2 사용량 계약 확인 → U3 사용량 API → U4 분석 화면 → U5 브라우저 시험·완료 기준 | 사용자 결정. A1 은 U1 의 필수 선행 (통합 계획 4절 B) |
| 관리자 MFA | 1차 필수. 자체 TOTP. Better Auth `twoFactor` 플러그인은 켜지 않고 앱 소유 모듈로 만든다 | 공통 사용자 결정 1차(10-18), A1 설계 1절 |
| MFA 수치 | TOTP 30초·6자리·SHA-1·앞뒤 1 step·재사용 금지, 최근성 10분, 관리자 세션 유휴 30분·절대 12시간, 5회 실패 뒤 1초부터 지수 지연·상한 15분·15분 뒤 초기화, 복구 코드 10개. **등록 24시간**은 공통안 원문 "TOTP 등록 코드 24시간"이라 MFA enrollment grant 의 수명이다 (이메일 확인 링크 수명이 아니다). seed 길이는 Q12 | 공통 회원 수치 1차 (2026-10-18), Q9 |
| 비밀번호 | 최소 8자. 영소·영대·숫자·특수 4종 중 3종. 최대 길이 없음 (요청 본문 상한 64KiB 가 사실상 상한). 검사·해시 전에 NFC 정규화 | 공통 회원 수치 1차 (사용자 결정 2026-10-18) |
| 해시 | 앱 소유 hasher, scrypt N=2^16·r=8·p=2, salt ≥ 16B·출력 ≥ 32B, 매개변수를 해시 문자열에 저장. 로그인 성공 때 재해시하되 재해시는 자격 변경이 아니라서 세션을 끊지 않는다. 예비안 N=2^15·r=8·p=3 은 공통안 원문대로 "메모리 오류가 나면 예비안으로 내리고 orc 에 알린다" (V33 이 정한다) | 같음 |
| 세션 | 유휴 30분, 절대 12시간 | 같음 |
| 로그인 시도 제한 | 계정+IP 칸. 5회 실패 뒤 1초부터 지수 지연, 상한 15분, 마지막 실패 15분 뒤 초기화. 저장소는 DB 공유 (`rate_limit`처럼 여러 인스턴스가 함께 센다) | 같음 |
| 만료 | 초대 72시간 고정 (관리자 조절 없음, 이미 발급된 초대는 원래 만료 유지). 비밀번호 재설정 30분 | 같음. 3단계 Q4(기본 7일·최대 30일)를 대체 |
| 보존 | 감사 기록 1년 (정리 작업 추가). 백업 30일 | 같음. 3단계 Q17(무기한)을 대체 |
| MFA 배포 템플릿 값 | seed 20바이트(Q12), 부분 세션 challenge TTL 600초, 등록 시작 → 확인(pending) TTL 600초, `/admin-mfa/**` 클라이언트 IP·경로마다 분당 20회. 앞 셋은 `MFA_*` 배포 설정, 요청 수 제한은 `RATE_LIMIT_RULES` | 사용자 결정 (2026-10-19) |
| 관리자 초대 수락 | 이메일 지정 관리자 초대(role=admin)를 수락하면 그 응답에 MFA 등록 grant(promotion, 발급자 = 초대 만든 관리자)를 한 번 넣는다. 수락 마무리와 같은 원자 단위에서 발급한다. 응답 키는 `mfaGrant.grant` (DTO 의 `token` 키 금지와 구분) | 사용자 결정 (2026-10-19) |
| 수치의 자리 | 위 수치는 코드 기본값이 아니라 **배포 설정(env·wrangler vars)의 필수값**이다. 값이 없거나 범위 밖이면 그 기능이 fail-closed 로 닫힌다 (A1 정책 모듈과 같은 방식). 1차 결정 값은 배포 템플릿과 운영 문서에 적는다 | 사용자 결정 |
| 범위 밖 | SSO(5단계)·SAML(6단계)·전체 관리 화면(7단계)·공개 준비(8단계) | 통합 계획 4절 C~F |
| 사용량 원칙 (orc 공유) | 관리 화면 장애가 OmniRoute 중계를 멈추지 않는다. 인증·철회는 설치 DB 를 요청마다 동기로 확인한다. 사람 세션과 서비스 키(OmniRoute API 키)를 섞지 않는다 | orc 공유 원칙 |
| 브라우저 시험 조합 | Docker SQLite 한 조합 | 기존 사용자 확정 (통합 계획 1절) |

### 질문 (결정 필요)

아래 본문은 모두 **(추천)** 선택지로 썼고, 질문에 기댄 곳에 `(Q<n> 의존)`을 붙였다. 질문마다 마지막 줄은 `- 결정: 미정 (<그 결정이 필요한 단계>)`이다. 고르면 `- 결정: <선택지> (<날짜>)`로 바꾼다. 각 단계 GATE 의 「미정 질문 0」 검사가 그 단계 표시가 붙은 미정 줄 0개를 요구한다. 다른 문서에서 이 질문을 부를 때는 `4단계 Q<n>`이라 쓴다.

### Q1 — 로그인 시도 제한의 세부
- (가) **칸 키는 `정규화한 이메일 | 클라이언트 IP 칸`(`ipBucket`)이다. 없는 이메일도 같은 칸을 만든다. 지연 중에는 맞는 비밀번호도 429 `login_throttled`·`Retry-After`다. 로그인 성공은 그 칸을 지운다 (추천)**.
- (나) 지연 중 맞는 비밀번호는 통과시킨다. 대입 공격을 늦추는 효과가 약해진다.
- 영향: TC-A2.T5.a~e 의 단언, 봉인 시험 중 틀린 비밀번호를 여러 번 넣는 시험(A2 영향표).
- 결정: (가) (2026-10-19 사용자)

### Q2 — 재해시와 credential 지문
- 사실: 세션·H1 확인 링크·자기 탈퇴 proof 는 `account.password` 해시 문자열에서 만든 credential 지문에 묶인다 (`packages/auth/src/signup-confirmation.ts` `fingerprint`). 재해시는 해시 문자열을 바꾸므로 그대로 두면 모든 세션이 끊긴다.
- (가) **재해시는 credentialWriter 가 아닌 별도 경로다. 한 트랜잭션·batch 에서 `account.password`를 바꾸고, 옛 지문과 같은 그 회원의 세션 지문을 새 지문으로 옮긴다. `auth_version`은 올리지 않는다. 진행 중인 H1 확인 링크·자기 탈퇴 proof 는 무효가 되고 다시 받게 한다. 재해시가 실패하면 로그인은 성공으로 두고 경고만 남긴다 (추천)**.
- (나) 지문 입력을 해시 문자열이 아니라 비밀번호가 바뀔 때만 올리는 새 칼럼으로 바꾼다. 마이그레이션이 필요하고 봉인된 M2·M4 시험의 지문 단언이 바뀐다.
- 영향: V34, TC-A2.T3.d~f.
- 결정: (가) (2026-10-19 사용자)

### Q3 — 비밀번호 문자 종류의 정의와 적용 범위
- (가) **NFC 정규화 뒤 영소 `[a-z]`·영대 `[A-Z]`·숫자 `[0-9]`·특수 = 그 밖의 모든 문자(공백·한글 포함)로 센다. 길이는 NFC 뒤 코드 포인트 수다. 규칙은 새로 정하는 비밀번호(가입·H1 확인·재설정·변경·설치 관리자·초대 수락)에만 걸고, 기존 비밀번호의 로그인은 막지 않는다 (추천)**.
- (나) 특수를 ASCII 기호로만 센다. 한글 비밀번호는 3종을 채우기 어렵다.
- 영향: TC-A2.T2.a~c.
- 결정: (가) (2026-10-19 사용자)

### Q4 — 세션 유휴 30분의 "활동"
- (가) **보호 API 요청과 `get-session` 모두 활동이다. 활동 시각 쓰기는 1분에 한 번까지로 줄인다 (판정 오차 ≤ 1분). 절대 12시간은 세션을 만든 시각에서 센다. 관리자 MFA 의 `MFA_ADMIN_SESSION_ABSOLUTE_TTL_S`는 12시간 이하만 받는다 (추천)**.
- (나) 사람이 하는 화면 요청만 활동으로 센다. 서버가 요청 종류를 나눠야 한다.
- 영향: V35, TC-A2.T4.a~d.
- 결정: (가) (2026-10-19 사용자)

### Q5 — 감사 1년·백업 30일의 뜻
- (가) **감사 기록은 `created_at`이 365일(UTC) 지난 행을 1분 작업 큐에서 500행씩 지운다 (`alert.*` 포함, M3.T3·M6.T5.f 와 같은 자리). 앱은 백업을 만들지 않는다. 운영 문서에 백업 보존 30일과 30일보다 오래된 백업을 지우는 운영자 절차, Workers D1 의 시점 복구 한계를 적는다 (추천)**.
- (나) 앱이 백업 내보내기·정리 작업을 갖는다. 새 저장소 연결과 비밀 값이 필요해 4단계 범위를 넘는다.
- 영향: TC-A2.T6.a~d, 운영 문서.
- 결정: (가) (2026-10-19 사용자)

### Q6 — 초대 API 가 `expiresInDays`를 받으면
- (가) **400 `invalid_expires`. 본문 허용 목록에서 뺀 필드라도 기존 오류 코드를 그대로 쓴다 (TC-M3.T1.c 의 오류 모양이 남는다) (추천)**.
- (나) 조용히 무시하고 72시간으로 만든다. 호출자가 다른 만료를 받았다고 착각한다.
- 영향: TC-M3.T1.c 단언 갱신, TC-A2.T7.a.
- 결정: (가) (2026-10-19 사용자)

### Q7 — 봉인 시험의 입력 값을 바꿔도 되나
- 사실: 봉인 시험 여럿이 2종짜리 비밀번호(예: `correct-horse-battery-staple`, `submitted-password`)로 가입한다. 새 규칙에서는 400 이 된다.
- (가) **시험 이름·`-t` 선택식·`expectPassed`·검사 정의는 그대로 두고, 입력 상수(비밀번호 값)·공용 fixture(정책 설정 값)·단언만 바꾼다. 바꾼 시험 목록은 A2 영향표에 남긴다 (추천)**.
- (나) 단언만 바꾸고 입력은 두지 않는다. 그러면 가입 시험이 새 규칙에서 성립하지 않는다.
- 영향: A2 의 봉인 시험 갱신 방식 전체 (A2 절 「봉인 시험 갱신 방식」).
- 결정: (가) (2026-10-19 사용자)

### Q8 — 웹 시험 도구 (새 의존성)
- 사실: `apps/web`에는 시험 실행기가 없다 (`package.json` devDependencies 에 vitest·Playwright 없음).
- (가) **U1 에서 `vitest`·`@testing-library/svelte`·`jsdom`을 `apps/web` devDependencies 로, U5 에서 `@playwright/test`를 루트 devDependencies 로 더한다. 버전은 고정하고 설치는 각 단계에서 승인받는다 (추천)**.
- (나) 컴포넌트 시험 없이 브라우저 시험(U5)만 둔다. 화면 상태 분기를 브라우저에서만 보게 되어 느리고 성기다.
- 결정: (가). 설치는 U1·U5 에서 각각 따로 승인받는다 (2026-10-19 사용자)

### Q9 — A1 설계 9절의 MFA 수치와 전환 절차
- 사실: A1 시험은 시험 전용 정책 값으로 돈다. 배포 템플릿의 실제 값(TOTP step·window·seed 길이·최근성·TTL·실패 제한·복구 코드 수)과 기존 관리자 전환 CLI 절차는 정해지지 않았다.
- (가) **A1 봉인은 시험 전용 값으로 한다. 실제 값과 전환 절차는 U5(4단계 완료 기준) 전에 정해 배포 템플릿·운영 문서에 넣는다. 그 전에는 배포 템플릿에 값을 비워 둬 관리자 기능이 503 으로 닫힌다 (추천)**.
- (나) A1 봉인 전에 정한다. A1 이 그만큼 늦어진다.
- 결정: (가). 실제 값은 회원 공통 수치 1차(2026-10-18 사용자 결정, orc 전달)를 쓴다: TOTP 30초·6자리·SHA-1·앞뒤 1 step·재사용 금지, 최근성 10분, 관리자 세션 유휴 30분·절대 12시간, 5회 실패 뒤 1초부터 지수 지연·상한 15분·15분 뒤 초기화, 등록 코드 24시간(MFA enrollment grant 수명), 복구 코드 10개. seed 길이는 Q12 로. 기존 관리자 전환은 운영자 CLI grant (2026-10-18 사용자) (2026-10-19 사용자)

### Q10 — 사용량 조회 범위 상한
- 사실: 기간 최대 길이·`call-logs` 페이지 상한·정렬은 OmniRoute 계약 확인(U2, V36·V37)과 측정(V38) 전이다. 캐시 TTL 60초와 권한·상태 변경 때 무효화는 초안에서 필수로 정했다.
- (가) **U2 확인 결과로 수치를 고른다. 그 전에는 U3 의 TC 단언을 「(V36·V37 의존)」으로 둔다 (추천)**.
- 결정: 미정 (U3)

### Q11 — `byModel`·일별 추세
- (가) **OmniRoute 응답 계약이 확인된 지표만 보인다. 확인되지 않은 `byModel`·추세는 API 가 `unsupported`로 내고 화면은 감춘다. 0·빈 배열·추정값으로 채우지 않는다 (추천)**.
- 결정: 미정 (U3)

### Q12 — TOTP seed 길이
- 사실: 공통 회원 수치 1차에 seed 길이가 없다. A1 정책은 `MFA_SEED_BYTES`를 필수 설정으로 받고 기본값이 없다. 참고 근거는 RFC 4226 §4 R6 (최소 128비트, 160비트 권장)이며 기본값이 아니다.
- (가) **20바이트(160비트, SHA-1 HMAC 블록 출력과 같은 길이) (추천)**.
- (나) 32바이트. 일부 인증 앱의 QR 길이·호환성을 따로 확인해야 한다.
- 영향: 배포 템플릿의 `MFA_SEED_BYTES`, U5.T3.
- 결정: 20바이트(160비트, RFC 4226 §4 R6) (2026-10-19 사용자)

---

## 0. 체계

이 절의 정의가 이 문서의 유일한 규칙이다. 3단계 실행판 0절과 같은 장치를 쓰고, 다른 점만 적는다.

**단계와 ID**
- 단계는 `A1`·`A2`·`U1`~`U5`. A 는 인증 기반, U 는 화면·사용량이다. 1단계 `S`, 2단계 `K`, 3단계 `M`과 겹치지 않는다.
  - `A1`은 A1 설계와 p4/a1-mfa 브랜치가 이미 쓰는 TC 접두 `TC-A1.T{n}.{x}`와 같다.
  - 3단계 실행판의 백로그 표시 `U1`·`U3`(M6.T5 의 "(U1)" 등)은 단계 키가 아니다. 그 문서 안에서만 뜻이 있다.
- 작업 ID `A1.T<m>`, 검사 ID `G-A1.<k>`, 테스트케이스 ID `TC-A1.T<m>.<소문자>` (A2·U 도 같은 꼴). 번호는 재사용하지 않고, 지운 작업은 `(폐기)`로 남긴다.
- 계획서 8장 확인 항목은 `V<번호>`. 4단계가 새로 여는 항목은 `V33`~`V38`이다 (A2 셋, U2 셋). 확인 결과 검사기 묶음은 `--set phase4`(A2.T1 이 더한다).

**상태 표기·작업 모양·TC 규칙·DB 범위**
- 3단계 0절과 같다: 작업 ☐·◐·☑, 단계 🔒·🔓·✅·⚠·➖, 머리 `선행 · 산출 · 되돌리기 · 장치 요구`, 본문 【작업】【테스트】【통과】, TC 는 이름·`단언:`·`검출:` 세 줄 (이 문서의 뒤 단계 TC 는 그 단계를 시작할 때 세 줄을 다 채운다).
- `(V<n> 의존)`·`(Q<n> 의존)`·`(코드 미확인)` 표기도 같다. 목록은 문서 끝.
- 동시성·원자성 TC 는 D1 을 포함한 다섯 DB 에서 돈다. Node DB 넷은 `test:db --db sqlite,mysql,mariadb,pg` 또는 `MG_TEST_DBS=…`, D1 은 `test:workers`(wrangler dev).

**GATE 와 봉인**
- 장치·명령·규칙 R1~R3·`strictTests`·`[L]`(requires local-services)는 3단계 0절과 같다.
- `--assert-order`는 잠긴 단계의 `outputs`를 처음 커밋부터 본다 (ci.yml `order` 잡, M6 의 G-M6.6). 그래서 4단계 `outputs`도 **그 단계가 처음 만드는, 이력에 한 번도 없던 경로만** 둔다. 이 문서를 쓸 때 모든 `outputs`가 `git log --all` 0건이었다 (2026-10-19, 이력 파일 589개).
- 잠기지 않은 단계(열린 단계)의 `outputs`·`checks`는 바꿀 수 있다. 그래서 뒤 단계의 마이그레이션 번호처럼 지금 정할 수 없는 경로는 그 단계가 열린 뒤 `outputs`에 더한다.
- **봉인된 단계는 바꾸지 않는다.** 봉인의 진위는 검사 ID 목록만 보지만(`sealProblem`), ci.yml 의 **봉인 단계 잡 전부**가 PR 마다 지금 코드로 봉인 단계 검사를 다시 돈다 (1단계 `unit`·`schema`·`auth`·`server`·`contract`·`deploy`·`e2e`·`guard`·`s1-seal`, 2단계 `p2-k*`, 3단계 `p3-m*`). 그래서 4단계가 봉인 단계의 시험 파일을 고치면 그 단계 검사의 선택식·통과 수가 그대로 맞아야 한다. A1.T5 의 `scripts/check-sealed-checks.mjs`가 봉인 단계 검사의 `desc`·`requires`를 뺀 **모든 필드**(`how`·`cmd`·`pattern`·`in`·`exclude`·`op`·`limit`·`expectPassed`·`expectExit`, json 검사의 `file`·`path`·`value`, `minFiles`·`since` 등)가 기준과 같은지 본다 (`desc`·`requires`는 보지 않는다 — 봉인 뒤 태그를 다는 선례가 있다).
- 봉인 단계 grep 검사 중 문서를 지금 파일로 읽는 것 (`gates.config.mjs`에서 패턴·개수를 확인함). A2 가 계획서·실행판·운영 문서를 고칠 때 아래 개수를 지킨다:

  | 파일 | 검사 | 패턴 | 개수 |
  |---|---|---|---|
  | `docs/design/omniroute-member-layer.md` | G-K0.28 | `^- v5\.6: .*Q1.*Q2.*Q3.*Q4.*Q5.*Q6` | == 1 |
  | 〃 | G-K0.29 · G-M0.10 | `^상태: 초안 v5\.([6-9]\|[1-9][0-9])` · `^상태: 초안 v5\.([8-9]\|[1-9][0-9])` | 각 == 1 |
  | 〃 | G-M0.9 | `^- v5\.8: .*Q1\b.*Q20\b` | == 1 |
  | `docs/plan/phase3-todo.md` | G-M0.11 | `^- 결정: 미정$` | == 0 |
  | `deploy/README.md` | G-S6.24 | `한 인스턴스` | ≥ 1 |
  | 〃 | G-S6.30 | `OmniRoute 20128 포트와 /api/\* 는 공개로 열지 않는다\|Workers 조합은 Cloudflare Tunnel·Access 로만 연결한다` | == 2 |
  | 〃 | G-K6.3 · G-K6.14 · G-K6.17 | `남은 한도 × 동시에 쓰는 키 수` · `OmniRoute 가격표로 계산한 추정치` · `동시 요청 수 × 요청 비용` | 각 == 1 |
  | 〃 | G-K6.18 | `fail-closed` | == 1 |
  | 〃 | G-M6.4 · G-M6.11 | `OmniRoute 호출 기록은 지워지지 않는다` · `회원 한도는 계정 단위` | 각 == 1 |

  - 계획서: v5.6·v5.8 줄과 상태 줄은 하나씩만 둔다. v5.8 줄은 고치지 않고 v5.9 줄을 더한다. 상태 줄은 `상태: 초안 v5.9 …` 한 줄로 바꾼다.
  - 3단계 실행판: Q4·Q17 의 결정 줄은 `- 결정: (가) … (v5.8) — 4단계 A2 가 대체 (v5.9)` 꼴로 고친다. `- 결정: 미정` 줄을 만들지 않는다.
  - `deploy/README.md`: 위 문구는 **새로 쓰지 않는다** (지우지도 않는다). 특히 A2 가 정책 수치·닫힘 동작을 적을 때 `fail-closed`라는 낱말을 쓰지 않고 "닫힌다"·"503 으로 거부한다"처럼 쓴다. 이 줄마다 쓴 뒤 grep 개수를 다시 센다.
- G-M6.1(시험 갈림길 0)·G-M6.2(꺼진 테스트·TODO 0)·G-M6.9(어댑터 밖 `/api/(keys|usage)` 0)는 p3-m6 잡이 PR 마다 돌아 4단계 코드에도 걸린다. 이름 함정 두 가지:
  - G-M6.9 는 `apps`·`packages` 전체(어댑터 `packages/omniroute` 제외)에서 `/api/keys`·`/api/usage` 문자열을 막는다. U3 의 회원 사용량 경로는 `/api/me/usage`처럼 그 문자열이 생기지 않는 꼴로 쓰고, 화면(U4)도 같다. U3 는 `packages/omniroute` 어댑터만 부른다.
  - G-M6.1 은 `apps/web/src`에서 `import.meta.env`를 막는다. U1·U4 웹 코드는 `import.meta.env`를 쓰지 않는다 (설정은 서버 API 응답으로 받는다).

**CI 단계 잡 규칙**
- 단계 봉인 파일을 커밋하는 순간부터 `.github/workflows/ci.yml`에 그 단계 게이트 잡이 있어야 한다 (`scripts/check-ci-matrix.mjs` `[stage-missing]`). 그래서 이 계획 브랜치(`p4/plan`)는 잡을 넣지 않고, 각 단계의 마지막 작업(`<단계>.T<끝>`)이 봉인 PR 에 잡 `p4-<단계 소문자>`를 넣는다 (예: `p4-a1`, 스텝 `run: node scripts/gate.mjs A1 --explain`).
- 단계 잡을 `--shard`로 나누면 분모가 같고 분자 1..n 이 정확히 한 번씩이어야 하며 나누지 않은 줄이 없어야 한다 (`[stage-partition]`). `--skip-requires` 금지, `--skip-ids`는 매트릭스가 대신 도는 E2E 검사만.
- 새 잡 이름은 main ruleset 필수 검사에 넣는다 `(사용자/메인 세션)`. `scripts/check-required-checks.mjs`가 확인한다.

**재현 빨강**
- 3단계와 같다: 기존 동작을 바꾸는 작업은 시험만 넣은 커밋(꼬리줄 `Red: <TC ID>`) 뒤에 고침 커밋. `check-red.mjs --check <검사> --since seal:<선행>`. 제품 코드를 약하게 만드는 커밋은 요구하지 않는다.

**면제**: 4단계 단계는 모두 `waivable: false`.

## 진행 현황

판정은 `node scripts/gate.mjs --status`가 한다 (1·2·3단계 `S0`~`S7`·`K0`~`K6`·`M0`~`M6`은 모두 ✅, main `6aca231`).

| 단계 | 제목 | 상태 | 게이트 명령 | 초기 checks |
|---|---|---|---|---|
| A1 | 관리자 MFA (자체 TOTP) | 🔓 | `node scripts/gate.mjs A1` | 22 (실제 시험 구조, 2026-10-19 교체. G-A1.7·11·15 폐기) |
| A2 | 공통 회원 수치 정렬 (비밀번호·해시·세션·시도 제한·만료·보존) | 🔒 | `node scripts/gate.mjs A2` | 0 |
| U1 | 기본 회원 화면·최소 관리자 화면 | 🔒 | `node scripts/gate.mjs U1` | 0 |
| U2 | 사용량 계약 확인 (OmniRoute analytics·call-logs·성능) | 🔒 | `node scripts/gate.mjs U2` | 0 |
| U3 | 사용량 API (권한·입력·캐시·데이터 연결) | 🔒 | `node scripts/gate.mjs U3` | 0 |
| U4 | 분석 화면 | 🔒 | `node scripts/gate.mjs U4` | 0 |
| U5 | 브라우저 시험·4단계 완료 기준·재발 방지 | 🔒 | `node scripts/gate.mjs U5` | 0 |

## 선행 관계

```
M6 ─▶ A1 ─▶ A2 ─▶ U1 ─▶ U2 ─▶ U3 ─▶ U4 ─▶ U5
```
- 전부 직렬이다. 동시 진행 상한 1 (A1 구현이 p4/a1-mfa 에서 이미 진행 중이다).
- A2 가 A1 뒤인 이유: A1 이 진행 중이라 A2 를 앞에 두면 A1 이 잠겨 그 PR 이 `--assert-order`에 걸린다. A2 는 A1 정책 모듈의 "배포 설정 필수값·fail-closed" 방식을 그대로 쓰고, 관리자 세션 절대 TTL 상한(Q4)을 A1 정책에 건다.
- U1 이 A2 를 기다리는 이유: 화면의 비밀번호 안내·세션 만료 안내·시도 제한 안내가 A2 의 확정 규칙과 오류 코드를 쓴다. 관리자 화면은 A1 의 서버 MFA 가드 없이 권한을 주지 않는다.
- U2 가 U1 을 기다리는 이유는 직렬 원칙뿐이다 (계약 확인 자체는 화면과 무관). 당기려면 needs 를 바꿔야 하는데, U2 가 잠긴 동안에는 바꿀 수 없으므로 이 PR 에서 정한다.
- U3 는 U2 계약이 확인된 지표만 연결한다. U4 는 U3 API 만 읽는다. U5 는 U1~U4 흐름을 브라우저로 본다.

## 4단계 범위 판단

| 계획 | 이 문서에서 | 근거 |
|---|---|---|
| 통합 계획 A1 관리자 MFA (자체 TOTP, 서버 가드, step-up, 복구 코드, bootstrap) | 함 (A1) | 1차 필수 |
| 공통 회원 수치 1차 (10-18) | 함 (A2) | 사용자 결정. 3단계 Q4·Q17 대체 |
| 통합 계획 B 기본 회원 화면·최소 관리자 화면 (MFA 등록·확인 화면 포함) | 함 (U1) | 3단계 Q2 가 4단계 앞머리로 넘김 |
| 4단계 사용량 화면 (회원별 요약·키별·최근 호출·기간) | 함 (U2~U4) | 계획서 9장 4단계 |
| IdP MFA 선택지 | 옮김 → 5단계 | 통합 계획 A1 "IdP MFA 는 D/E 에서 검증 후" |
| SSO·SAML·공급자 설정 화면 | 옮김 → 5·6·7단계 | 범위 밖 |
| 전체 관리 화면 (감사·실패 작업·전체 사용량) | 옮김 → 7단계 | 범위 밖 |
| 패스키·구체 역할 매핑 | 옮김 (공통안 대기) | 통합 계획 1절 미정 |

## 3단계에서 넘어온 백로그

| 항목 | 결정 | 자리 |
|---|---|---|
| 로그인·가입·초대 수락 화면 (3단계 Q2) | 함 | U1 |
| D1 비원자 가입 뒤 계정 없는 user 행 (M3 보안 리뷰 LOW) | 그대로 둔다 | 4단계 범위 밖. U5 에서 다시 본다 |
| 수락 응답 시간 ≥ 400ms 의 Workers 실측 (M3 LOW) | 함 (확인만) | U5.T3 |
| IP 를 못 정할 때 모든 요청이 `unknown` 칸 (M3 LOW) | 함 | A2.T5 (로그인 시도 제한도 같은 칸 문제를 가진다) |
| 관리자 비밀번호만으로 관리 API 를 부르는 봉인 시험 약 32개 (A1 설계 10절) | 함 | A1.T5 |

---

# A1 — 관리자 MFA (자체 TOTP) 🔓 (M6 필요)

**브랜치** `p4/a1-mfa` (진행 중, 기준 커밋 `461a194`. 봉인 전에 main `6aca231` 위로 맞춘다).
**outputs** `packages/auth/src/mfa/**`, `packages/auth/test/mfa-*`, `packages/db/migrations/*/0007_*`, `packages/db/migrations/*/meta/0007_snapshot.json`, `packages/db/test/migrate-0007.test.ts`, `apps/server/src/mfa/**`, `apps/server/test/mfa/**`, `apps/server/scripts/mfa-*`, `scripts/check-sealed-checks.mjs`, `test/check-sealed-checks.test.mjs`.
고칠 기존 파일(`outputs` 밖): `packages/db/src/schema/**`·생성 스키마·`migrations/*/meta/_journal.json`·`scripts/gen-schema.mjs`, `packages/auth/src/{index,rate-limit}.ts`·`package.json`, `apps/server/src/{app,config,node,workers}.ts`, `routes/guard.ts`, `admin/{members,guard-sql,self-delete,delete}.ts`, `invites/admin.ts`, `setup/{index,routes}.ts`, `audit/index.ts`, 봉인 단계 시험 파일.

설계는 [`phase4-a1-admin-mfa.md`](phase4-a1-admin-mfa.md) 1~10절이다. 이 절은 순서와 판정만 적는다.

🛡 보안 리뷰 대상: step CAS, 부분 세션 허용 경로, grant·proof·복구 코드 일회 소비, seed AAD, bootstrap 경로, 마지막 관리자 보호.

### ☑ A1.T1 — 저장소·TOTP·정책 모듈·마이그레이션 0007 (p4/a1-mfa, 미병합)
선행 없음 · 산출 `packages/auth/src/mfa/{totp,policy,store,session,unit,index}.ts`, `packages/db/migrations/*/0007_a1_mfa.sql`, 시험 셋 · 되돌리기 커밋 1~2개 · 장치 요구 없음 (순수 추가)

【작업】
1. A1 설계 2·3·5절대로 테이블 넷·세션 칼럼 넷·TOTP·정책 모듈을 만든다. 정책 수치는 `MFA_*` 배포 설정 필수값이고 기본값이 없다. 커밋.
2. `TC-S2.T3.a`(봉인 S2)의 테이블 수 단언을 14 → 18 로 고친다. 이름 앞머리 `TC-S2.T3.a`는 그대로다 (A2 절 「봉인 시험 갱신 방식」과 같은 규칙).

【테스트】 (p4/a1-mfa 에 있음)
```
TC-A1.T1.a~e·k2  RFC 4226 부록 D·RFC 6238 부록 B 벡터, base32, 시간창 경계, 여러 step 이 맞으면 가장 큰 step, otpauth URI
  단언:  벡터 일치, window 밖 거부, URI 에 secret·issuer·algorithm·digits·period 모두
  검출:  HMAC 절단·카운터 바이트 순서 실수로 표준 앱의 코드와 어긋나는 것
TC-A1.T1.f~h  정책 값 하나라도 없음 → unavailable(missing), 범위 밖 → unavailable, 정책 버전 = 정규화 SHA-256
  단언:  기본값을 채우지 않음, 이유에 값 원문 없음, 값이 바뀌면 버전이 바뀜
  검출:  빠진 값을 SDK·RFC 권장값으로 채워 정책 없이 MFA 가 켜지는 것
TC-A1.T1.i·j  다른 factor·회원 AAD 로 seed 복호화 거부, 오류·정책 상태에 seed·코드 원문 없음
  검출:  AAD 없이 암호화해 한 행의 seed 를 다른 회원 행에 옮겨 쓰는 것
TC-A1.T1.k~t  같은 step 두 번 거부, 과거 step 거부, 같은 step 동시 N 건 CAS 1건, 복구 코드 동시 소비 1건·해시만 저장,
              grant·proof 일회 소비·조건 일치, 회원당 active·pending 하나, changedRows 행 수, 세션 mfa 칼럼 입력·응답 차단 (Node DB 넷)
  검출:  last_used_step 비교를 <= 로 써 같은 step 을 다시 받는 것, 동시 소비에서 둘 다 성공하는 것
TC-A1.T1.migration  0007 업그레이드 뒤 기존 세션은 MFA 미충족, slot·복구 코드 고유 키 (다섯 DB)
  검출:  기존 세션 칼럼을 NULL 이 아닌 값으로 채워 MFA 충족으로 소급되는 것
TC-A1.T1.u·v  생성물·드리프트, 스키마 규칙 위반 0
```

【통과】
- [ ] G-A1.1 ~ G-A1.5 통과

> **A1 T2~T6 검사는 실제 시험 구조다 (2026-10-19 교체).** 시험은 `apps/server/test/mfa/`에 있다: `admin-mfa.test.ts`(Node·SQLite, T2.a~e·T3.a~d·T4.a~d), `admin-mfa.db.test.ts`(Node DB 넷 × T2.f·T3.e·T4.e), `admin-mfa.workers.test.ts`(D1, T2.f·T3.e·T4.e·T6.a), 공용 단언 `checks.ts`. 봉인 단계 시험은 공용 fixture(`packages/auth/test/mfa-fixture.ts`·`mfa-policy.ts`)로 옮겼다 (A1.T5).
> **재현 빨강은 격리 변이 대조다.** 시험과 제품 코드가 한 브랜치에서 함께 바뀌어 `Red:` 커밋을 따로 두지 않는다. 대신 작업 트리 사본에서 제품 코드를 한 곳씩 약하게 바꿔 해당 TC 가 실패함을 확인했다 (A1 봉인 PR 설명에 결과). 그래서 `check-red` 검사 G-A1.7·11·15 는 폐기했다.

### ☑ A1.T2 — 서버 가드·부분 세션·challenge 🛡
선행 A1.T1 · 산출 `packages/auth/src/mfa/{plugin,session,unit}.ts`, `apps/server/src/routes/guard.ts`, `apps/server/src/mfa/proof.ts` · 되돌리기 커밋 2개 · 장치 요구 없음 (재현 빨강은 격리 변이 대조)

【작업】 A1 설계 4절 「로그인」·6절대로 `/api/auth/admin-mfa/*`, `hooks.before` 부분 세션 제한(허용 `/get-session`·`/sign-out`·`/admin-mfa/*`), `sessionAdmin` MFA 판정(get-session 한 번, 세션·회원·active factor 한 SELECT)을 넣는다.

【테스트】
```
TC-A1.T2.a  부분 세션: 관리 API 403 mfa_required, 관리자의 회원 API 403, /change-password·/update-user 403 MFA_REQUIRED, /get-session·/sign-out 허용, challenge 뒤 200
  검출:  sessionAdmin 이 role·status 만 봐 비밀번호만으로 전체 관리자 권한을 얻는 것, 차단이 금지 목록이라 새 경로가 우회되는 것
TC-A1.T2.b  정책 버전 불일치·factor 교체 뒤 옛 충족 세션은 관리 API 직접 호출에서 403
  검출:  mfa_verified_at 만 봐 정책을 강화해도 기존 관리자 세션이 그대로 쓰이는 것
TC-A1.T2.c  정책 unavailable → 관리 API·관리자의 회원 API 503 mfa_policy_unavailable, challenge 503 MFA_POLICY_UNAVAILABLE, 회원은 그대로
  검출:  정책을 못 읽을 때 MFA 판정을 건너뛰어 관리 API 가 열리는 것
TC-A1.T2.d  실패 5번 뒤 429 MFA_TOO_MANY_ATTEMPTS·Retry-After, 감사·로그에 seed·grant·복구 코드 없음
  검출:  6자리 코드 대입을 시간창 안에서 무제한 시도하는 것
TC-A1.T2.e  같은 코드 동시 challenge → 1건 (Node SQLite)
TC-A1.T2.f  같은 코드 동시 challenge 여섯 → 1건, 나머지 401 INVALID_MFA_CODE·관리 API 403, 같은 계정·IP 연속 실패 6번째 429 (Node DB 넷·D1)
  검출:  last_used_step CAS 가 빠져 한 코드가 세션 수만큼 쓰이는 것, 실패 칸 UPDATE 가 DB 하나(Postgres 의 매개변수 형식)에서 500 이 되는 것
```

【통과】
- [ ] G-A1.6 · G-A1.8 · G-A1.9 통과

### ☑ A1.T3 — 설치 직후 bootstrap·등록·복구 코드 🛡
선행 A1.T2 · 산출 `apps/server/src/setup/{index,routes}.ts`, `apps/server/src/node.ts`, `packages/auth/src/mfa/plugin.ts` · 되돌리기 커밋 2개 · 장치 요구 없음

【작업】 A1 설계 4절 「설치 직후 (추천안 A)」·「등록·재등록」·「복구 코드」대로. Node 재발급 토큰은 설치 토큰과 다른 행(`mfa_reissue_token_hash`)이다.

【테스트】
```
TC-A1.T3.a  정책 미준비면 POST /api/setup 503 mfa_policy_required, 설치 토큰·관리자·grant 그대로
  검출:  토큰을 먼저 소비해 운영자가 설정을 고친 뒤 다시 설치할 수 없게 되는 것
TC-A1.T3.b  설치 201 에 mfaGrant 한 번(no-store), DB 에는 해시만, grant 없음·틀린 grant 등록 403 MFA_GRANT_REQUIRED, 등록 뒤 관리 API 200, 같은 grant 재사용 불가
  검출:  비밀번호를 훔친 사람이 자기 TOTP 를 등록해 관리자를 넘겨받는 것
TC-A1.T3.c  재등록은 mfa.reenroll proof 필요·다른 세션 삭제·옛 seed 무효, 복구 코드는 한 번만, 재발급은 proof 필요
TC-A1.T3.d  bootstrap grant 재발급은 active factor 가 없는 동안 Node 재발급 토큰으로 한 번
TC-A1.T3.e  같은 코드 동시 등록 확인 → 1건, active factor 1·grant 부분 소비 없음 (Node DB 넷·D1)
  검출:  D1 batch 중간 실패로 grant 만 소비되고 factor 가 pending 으로 남는 것
```

【통과】
- [ ] G-A1.10 · G-A1.12 · G-A1.13 통과

### ☑ A1.T4 — step-up·승격·초기화·마지막 관리자·관리자 초대 수락 🛡
선행 A1.T3 · 산출 `apps/server/src/mfa/proof.ts`, `admin/{members,guard-sql,self-delete,delete}.ts`, `invites/{admin,accept}.ts` · 되돌리기 커밋 2개 · 장치 요구 없음

【작업】 A1 설계 4절 「민감 작업 step-up」·「해제·승격·초기화」대로. proof 를 요구할 작업은 역할 변경·관리자 초대·MFA 초기화·관리자 탈퇴다 (설정·메일·OmniRoute 토큰 변경은 A1 설계 9절 결정 대기). 관리자 초대 수락은 등록 grant 를 응답에 한 번 넣는다 (2026-10-19 사용자 결정).

【테스트】
```
TC-A1.T4.a  proof 없음 403 mfa_proof_required, 다른 대상·목적·세션 proof 403 mfa_proof_invalid, 거부된 시도는 proof 를 쓰지 않음, 재사용 403
  검출:  역할 변경용 proof 로 다른 회원을 승격하는 것
TC-A1.T4.b  승격: 대상 세션 철회·promotion grant 행위자에게 한 번·대상은 grant 로만 등록, 초기화: 자기·bootstrap 409·factor 폐기·세션 철회·reset grant, 강등은 factor 폐기
TC-A1.T4.c  마지막 관리자 = active 이면서 active factor 가 있는 관리자 수, bootstrap 강등 409, 관리자 탈퇴 proof 필요·탈퇴 뒤 MFA 행 0
  검출:  MFA 없는 관리자를 세어 마지막 MFA 관리자를 탈퇴시키는 것
TC-A1.T4.d  관리자 초대는 proof 필요, 수락 응답에 mfaGrant 한 번(no-store)·해시만, 그 grant 로만 등록, 회원 초대 수락에는 없음
TC-A1.T4.e  같은 proof 동시 역할 변경 둘 → 1건, 다른 목적 proof 403 (Node DB 넷·D1)
  검출:  proof 를 작업 트랜잭션 밖에서 소비해 동시 요청 둘이 같은 proof 로 성공하는 것
```

【통과】
- [ ] G-A1.14 · G-A1.16 · G-A1.17 통과

### ☐ A1.T5 — 봉인 단계 시험 이전과 봉인 검사 불변 검사기
선행 A1.T2 · 산출 `scripts/check-sealed-checks.mjs`, `test/check-sealed-checks.test.mjs`, 봉인 단계 시험 파일·공용 fixture · 되돌리기 커밋 2개 · 장치 요구 없음

【작업】
1. 검사기: 지금 설정과 기준 ref 설정을 읽어, 기준에서 봉인(✅)인 단계마다 검사 ID 목록과 각 검사의 판정 필드(0절 목록)가 같은지 본다. 다르면 단계·검사 ID·필드를 출력하고 종료코드 1. 커밋.
2. 관리자를 만들어 비밀번호만으로 관리 API 를 부르는 봉인 시험(약 32개 파일)을 시험 전용 정책 값의 공용 MFA fixture(관리자 생성 → factor 등록 → challenge 를 마친 세션)로 바꾼다. 시험 이름·선택식·통과 수는 그대로다. 커밋.

【테스트】
```
TC-A1.T5.a  지금 설정의 봉인 단계 검사 = origin/main 의 것
TC-A1.T5.b  봉인 단계 검사의 cmd·expectPassed 를 바꾼 설정 → 실패, 단계·ID·필드 출력
TC-A1.T5.c  봉인 단계에 검사를 더하거나 뺀 설정 → 실패
TC-A1.T5.d  열린·잠긴 단계의 검사를 바꾼 설정 → 통과
TC-A1.T5.e  desc·requires 만 바꾼 설정 → 통과
  검출:  봉인 단계 시험을 고치며 통과 수를 슬쩍 맞춰, CI 단계 잡이 초록인데 봉인 당시의 기준이 사라지는 것
```

【통과】
- [ ] G-A1.18 · G-A1.19 통과
- [ ] 이 PR 의 봉인 단계 잡 전부(1단계 `unit`·`schema`·`auth`·`server`·`contract`·`deploy`·`e2e`·`guard`·`s1-seal`, `p2-k*`, `p3-m*`) 초록 (봉인 단계 시험이 새 fixture 로 같은 수만큼 통과)

### ☑ A1.T6 — Workers D1 전체 흐름
선행 A1.T3 · 산출 `apps/server/test/mfa/admin-mfa.workers.test.ts` · 되돌리기 커밋 1개

```
TC-A1.T6.a  Workers D1: grant 등록 → 승격 grant → 대상 등록 → 초기화 reset grant → 재등록 → 관리자 초대 수락 grant → 등록, 부분 세션 403
  검출:  D1 batch 의 CAS 뒤 guard INSERT 가 빠져 0행 CAS 에도 승격·등록이 커밋되는 것
```
【통과】 - [ ] G-A1.20 통과

### ☐ A1.T7 — A1 CI 잡과 봉인
선행 A1.T1 ~ A1.T6 · 산출 `.github/workflows/ci.yml` · 되돌리기 커밋 1개

【작업】
1. 잡 `p4-a1`(이름 `관리자 MFA (A1 게이트, 다섯 DB)`) 스텝 `run: node scripts/gate.mjs A1 --explain`. 커밋.
2. `(사용자/메인 세션)` ruleset 필수 검사에 그 이름.
3. 보안 리뷰 → 고침 TC 를 `G-A1.26`부터 더함 → `gate A1 --seal` → PR → 머지 커밋.

```
TC-A1.T7.a  grep "^\s+run: node scripts/gate\.mjs A1\b" ci.yml → 1 (G-A1.23)
  검출:  봉인 PR 에 잡을 빠뜨려 check-ci-matrix [stage-missing] 으로 main 이 빨개지는 것
TC-A1.T7.b  check-required-checks → 0 (G-A1.24)
  검출:  빨간 채로 병합되는 것
```

## 🚪 GATE A1 (2026-10-19 실제 시험 구조로 교체. G-A1.7·11·15 폐기 — 재현 빨강은 격리 변이 대조)

| id | 검사 | 명령 | 통과 기준 |
|---|---|---|---|
| G-A1.1 | TC-A1.T1.a~j·k2 단위 | `pnpm -C packages/auth exec vitest run test/mfa-unit.test.ts -t "TC-A1\.T1\."` | 통과 = 11 |
| G-A1.2 | TC-A1.T1.k~t 저장소 (Node DB 넷) | [L] `pnpm -C packages/auth test -t "TC-A1\.T1\.[k-t] "` | 통과 = 40 |
| G-A1.3 | TC-A1.T1.migration (다섯 DB) | [L] `pnpm -C packages/db test:migrate -t "TC-A1.T1.migration" --db sqlite,mysql,mariadb,pg,d1` | 통과 = 5 |
| G-A1.4 | TC-A1.T1.u 생성물·드리프트 | `pnpm -C packages/db gen && git diff --exit-code packages/db/src/schema/ && pnpm -C packages/db check:drift` | 종료코드 0 |
| G-A1.5 | TC-A1.T1.v 스키마 규칙 | `node scripts/schema-lint.mjs` | 종료코드 0 |
| G-A1.6 | TC-A1.T2.a~e (Node SQLite) | `pnpm -C apps/server test -t "TC-A1\.T2\.[a-e] "` | 통과 = 5 |
| G-A1.8 · 9 | TC-A1.T2.f (Node DB 넷 · D1) | [L] `test:db -t "TC-A1\.T2\.f " --db sqlite,mysql,mariadb,pg` · [L] `test:workers test/mfa/admin-mfa.workers.test.ts -t "TC-A1\.T2\.f Workers"` | 4 · 1 |
| G-A1.10 | TC-A1.T3.a~d (Node SQLite) | `pnpm -C apps/server test -t "TC-A1\.T3\.[a-d] "` | 통과 = 4 |
| G-A1.12 · 13 | TC-A1.T3.e (Node DB 넷 · D1) | [L] `test:db -t "TC-A1\.T3\.e " …` · [L] `test:workers … -t "TC-A1\.T3\.e Workers"` | 4 · 1 |
| G-A1.14 | TC-A1.T4.a~d (Node SQLite) | `pnpm -C apps/server test -t "TC-A1\.T4\.[a-d] "` | 통과 = 4 |
| G-A1.16 · 17 | TC-A1.T4.e (Node DB 넷 · D1) | [L] `test:db -t "TC-A1\.T4\.e " …` · [L] `test:workers … -t "TC-A1\.T4\.e Workers"` | 4 · 1 |
| G-A1.18 | TC-A1.T5.a 봉인 검사 불변 | `node scripts/check-sealed-checks.mjs --base origin/main` | 종료코드 0 |
| G-A1.19 | TC-A1.T5.b~e 음성 대조 | `node --test … test/check-sealed-checks.test.mjs` | 통과 = 4 |
| G-A1.20 | TC-A1.T6.a Workers D1 흐름 | [L] `test:workers test/mfa/admin-mfa.workers.test.ts -t "TC-A1\.T6\.a"` | 통과 = 1 |
| G-A1.21 | `twoFactor(` 0 | grep in `packages/auth/src`·`packages/db/src`·`apps/server/src` | == 0 |
| G-A1.22 | 타입 검사 | `pnpm -r typecheck` | 종료코드 0 |
| G-A1.23 · 24 | CI 단계 잡 · ruleset | grep · `check-required-checks.mjs` | == 1 · 0 |
| G-A1.25 | 스크립트 테스트 | `node --test --test-reporter=tap "scripts/*.test.mjs"` | 종료코드 0 |
| G-A1.26 | TC-A1.T4.f 보안 리뷰 M1·L3 (Node SQLite) | `pnpm -C apps/server test -t "TC-A1\.T4\.f "` | 통과 = 1 |

**보안 리뷰 반영 (2026-10-19, CRITICAL·HIGH 0 · MEDIUM 1 · LOW 5, 사용자 결정: M1·L2·L3·L4 고침)**
- M1 다른 관리자 정지·삭제: proof 목적 `admin.suspend` 추가, `admin.delete` 를 관리자 API 삭제에도 쓴다(대상 id). 대상이 관리자인지는 회원 관리 단위 안의 잠근 행으로 판정하고, 관리자 대상에 proof 가 없으면 403 `mfa_proof_required`. 회원 대상은 proof 를 쓰지 않는다 (G-A1.26).
- L2 분산 IP 대입: 계정 단독 실패 칸(`MFA_ACCOUNT_FAILURE_LIMIT`, 1차 값 20, 계정+IP 제한 이상)을 더한다. IP 칸을 먼저 차지하고, 시간창×계정 제한 < 코드 공간 관계를 정책 검사에 둔다 (G-A1.1 T1.g, G-A1.8·9 T2.f).
- L3 관리자 초대 proof 대상: `"admin-invite"` 고정값 → 정규화한 초대 이메일 (G-A1.26).
- L4 D1 관리자 초대 수락 마무리: guard 0행이면 batch 예외 대신 0 (Node 와 같은 201·grant 없음). grant 없는 관리자는 운영자 CLI transition grant 로 복구한다.
- L1 MFA 승격 때 세션 토큰 회전 없음: 위험 수용. 세션 재생성은 authVersion·credential 지문 결합과 충돌한다(설계 2절). 부분 세션은 challenge TTL 뒤 지운다.
- L5 관리자 세션 유휴 30분·절대 12시간 강제: A2 범위.

`node scripts/gate.mjs A1 --seal`

**통과 기준**: (봉인 PR 에서 교체한) A1 검사 통과 + 이 PR 의 봉인 단계 잡 전부 초록 + 보안 리뷰 고침 반영. password-only·미등록·부분 세션·낡은 정책 버전·증거 재사용·저장소 장애의 관리 요청이 모두 막힌다 (통합 계획 A1 완료 기준).

**막혔을 때**
- 통과 수가 선언과 다르면 숫자를 실행 결과에 맞추지 않는다. 선언을 바꿨으면 셀렉터와 수를 함께 고친다 (A1 은 열린 단계라 고칠 수 있다).
- Better Auth 에 세션 추가 칼럼을 바꾸는 공개 엔드포인트가 있으면(A1 설계 10절 미확인) A1.T2 앞에서 막고 TC 를 더한다.
- 봉인 단계 시험이 MFA fixture 로 통과 수를 맞출 수 없으면 그 시험을 고치지 말고 멈춰 메인 세션에 알린다 (봉인 단계 검사는 바꿀 수 없다).

---

# A2 — 공통 회원 수치 정렬 🔒 (A1 필요)

**브랜치** `p4/a2`.
**outputs** `docs/verify/V33.json`~`V35.json`, `packages/auth/src/policy/**`, `packages/auth/test/policy/**`, `packages/auth/test/verify-p4/**`, `apps/server/src/audit/prune.ts`, `apps/server/test/policy/**`. 마이그레이션이 필요해지면(Q2 (나) 등) A2 가 열린 뒤 그 번호를 `outputs`에 더한다.
고칠 기존 파일: `packages/auth/src/{index,signup-confirmation,safe-reset-adapter,rate-limit}.ts`, `packages/db/src/auth-options.ts`, `apps/server/src/{app,config}.ts`, `invites/admin.ts`, `queue/runner.ts`, `setup/**`, `deploy/**`, 계획서, 3단계 실행판, 봉인 단계 시험 파일.

🛡 보안 리뷰 대상: hasher·재해시, 시도 제한 칸·지연, 세션 유휴·절대 만료, 정책 unavailable 의 닫힘.

### ☐ A2.T0 — 봉인 시험·문서 영향표
선행 없음 · 산출 이 문서 「A2 영향표」 · 되돌리기 커밋 1개

【작업】
1. 새 수치에 걸리는 봉인 단계 시험·문서를 찾아 아래 「A2 영향표」를 채운다. 찾는 것:
   - 2종 이하 비밀번호 입력 (`correct-horse-battery-staple`, `submitted-password` 등), 128자 상한 단언 (`H1.CHANGE`의 `"a".repeat(129)`·`PASSWORD_TOO_LONG`)
   - 초대 만료 7일·30일·`expiresInDays` (`TC-M3.T1.c`, `test/invites/checks.ts`의 T1.h·i 입력, 감사 detail `expiresInDays`)
   - 감사 무기한 (3단계 Q17, 계획서 v5.8)
   - 재설정 토큰 수명 (Better Auth 기본 1시간), 세션 수명 (Better Auth 기본 7일)을 기대는 시험
   - 틀린 비밀번호를 5번 넘게 넣는 시험 (S3 요청 수 제한, M2 H1, M4 재설정 경합)
   - 미리 만든 해시 문자열을 넣는 시험 (`preserved-test-hash` 등)
2. 행마다 `파일 · 시험 이름 · 검사 ID · 바꿀 것(입력·fixture·단언) · 통과 수 유지`를 적는다. 커밋.

【통과】
- [ ] 영향표에 `미조사` 행 0 (G-A2.1)

### ☐ A2.T1 — 확인 항목 V33~V35
선행 없음 · 산출 `docs/verify/V33.json`~`V35.json`, `packages/auth/test/verify-p4/**`, `scripts/check-verify.mjs`(`--set phase4`) · 되돌리기 커밋 1개

```
V33  Workers(wrangler dev, D1)에서 scrypt N=2^16·r=8·p=2 해시·검증이 메모리 오류 없이 되나, 걸리는 시간 (예비안 N=2^15·r=8·p=3 도 잰다)
V34  Better Auth 1.7.7 의 password.hash·verify 교체 자리, 로그인 성공 뒤 재해시를 넣을 자리(세션 생성 전후), maxPasswordLength 를 끌 방법,
     resetPasswordTokenExpiresIn 의 실제 적용 (Q2 의존)
V35  session.expiresIn·updateAge 로 절대 12시간·유휴 30분을 낼 수 있나, 안 되면 sessionBefore·get-session 훅의 판정 자리 (Q4 의존)
```
- `blocking: true`면 계획서와 이 문서를 고친다 (3단계 0절 규칙). V33 이 예비안을 고르면 Workers 배포 템플릿만 예비안이다 (Node 는 본안). 해시 문자열에 매개변수가 있어 섞여도 검증은 된다.

```
TC-A2.T1.a~c  check-verify --set phase4 present·unblocked·resolved 음성 대조
  검출:  확인 파일이 빠지거나 blocking 인 채로 A2 구현이 시작되는 것
```

### ☐ A2.T2 — 정책 설정 모듈과 비밀번호 규칙 (Q3 의존)
선행 A2.T1 · 산출 `packages/auth/src/policy/{config,password}.ts` · 되돌리기 커밋 2개 · 장치 요구 `Red: TC-A2.T2.b`

【작업】
1. 배포 설정 필수값을 읽는 모듈 (A1 `loadMfaPolicy`와 같은 모양): `AUTH_PASSWORD_MIN_LENGTH`·`AUTH_PASSWORD_MIN_CLASSES`·`AUTH_SCRYPT_{N,R,P,SALT_BYTES,KEY_BYTES}`·`AUTH_SESSION_IDLE_S`·`AUTH_SESSION_ABSOLUTE_S`·`AUTH_LOGIN_{FREE_FAILURES,DELAY_BASE_S,DELAY_MAX_S,RESET_S}`·`AUTH_INVITE_TTL_S`·`AUTH_RESET_TTL_S`·`AUDIT_RETENTION_DAYS` (이름은 구현 때 확정하고 이 문서를 같이 고친다). 없거나 범위 밖이면 그 기능이 503 `auth_policy_unavailable`로 닫힌다. 시작은 막지 않는다. 사유에 값 원문을 넣지 않는다.
2. 비밀번호 규칙: NFC → 길이 ≥ 최소 → 4종 중 최소 종류. 최대 길이 검사는 없다 (`maxPasswordLength`를 끈다, 본문 64KiB 상한은 `app.ts` 그대로). 가입·H1 확인·재설정·변경·설치 관리자·초대 수락이 같은 함수를 부른다.
3. 배포 템플릿(`deploy/**`)에 1차 결정 값을 넣는다. 공용 시험 fixture 에도 같은 값을 넣는다. 커밋.

```
TC-A2.T2.a  8자 3종 → 통과, 7자 4종·8자 2종 → 400 PASSWORD_TOO_WEAK (가입·H1 확인·재설정·변경·설치·초대 수락 여섯 경로)
  검출:  경로 하나(예: 초대 수락)가 Better Auth 기본 검사(8~128자)만 써 2종 비밀번호가 들어오는 것
TC-A2.T2.b  1000자 3종 → 통과, 본문 64KiB 넘음 → 413 payload_too_large
  검출:  maxPasswordLength 128 이 남아 긴 패스프레이즈가 거부되는 것
TC-A2.T2.c  NFD 로 보낸 비밀번호와 NFC 로 보낸 같은 비밀번호가 같은 계정에 로그인된다
  검출:  정규화 없이 해시해 macOS 입력기(NFD)로 만든 비밀번호를 다른 기기에서 쓸 수 없는 것
TC-A2.T2.d  정책 값 하나라도 없음 → 가입·로그인·재설정 503 auth_policy_unavailable, 다른 API 정상, 로그에 값 원문 없음
  검출:  값이 없을 때 코드 기본값으로 조용히 돌아 배포 설정과 다른 정책이 적용되는 것
```

### ☐ A2.T3 — 앱 소유 hasher 와 재해시 (V33·V34·Q2 의존)
선행 A2.T2 · 산출 `packages/auth/src/policy/hasher.ts` · 되돌리기 커밋 2개 · 장치 요구 `Red: TC-A2.T3.d`

```
TC-A2.T3.a  새 해시 = 매개변수(N·r·p)·salt·key 를 담은 문자열, salt ≥ 16B·key ≥ 32B, 설정 값과 같은 매개변수
  검출:  매개변수를 해시에 넣지 않아 나중에 비용을 올리면 옛 해시를 검증할 수 없는 것
TC-A2.T3.b  Better Auth 기본 형식(옛 해시)도 검증된다
  검출:  배포 직후 기존 회원 전원이 로그인하지 못하는 것
TC-A2.T3.c  로그인 성공 때 옛 형식·설정보다 약한 매개변수 해시만 재해시, 같은 매개변수는 다시 쓰지 않는다
TC-A2.T3.d  재해시 뒤 그 회원의 모든 세션이 살아 있고 auth_version 그대로, 다른 세션의 다음 요청 200 (Node DB 넷·D1)
  검출:  재해시를 credentialWriter 로 써 지문이 바뀌고 로그인할 때마다 다른 기기 세션이 끊기는 것
TC-A2.T3.e  재해시와 동시 비밀번호 변경 → 변경이 이긴다 (재해시는 옛 해시 일치 CAS)
  검출:  늦게 끝난 재해시가 새 비밀번호를 옛 비밀번호 해시로 덮는 것
TC-A2.T3.f  재해시 실패(쓰기 0행)는 로그인 성공·경고 1줄
```

### ☐ A2.T4 — 세션 유휴 30분·절대 12시간 (V35·Q4 의존)
선행 A2.T2 · 산출 `packages/auth/src/policy/session.ts` · 되돌리기 커밋 2개 · 장치 요구 `Red: TC-A2.T4.a`

```
TC-A2.T4.a  마지막 활동 30분 1초 뒤 요청 → 401, 29분 59초 → 200 (시계 주입)
  검출:  Better Auth updateAge 로 만료를 늘리기만 해 유휴 세션이 7일 사는 것
TC-A2.T4.b  활동이 계속돼도 생성 12시간 뒤 → 401
  검출:  미끄러지는 만료만 있어 계속 쓰는 세션이 끝나지 않는 것
TC-A2.T4.c  활동 시각 쓰기는 1분에 한 번까지
TC-A2.T4.d  MFA_ADMIN_SESSION_ABSOLUTE_TTL_S > AUTH_SESSION_ABSOLUTE_S → MFA 정책 unavailable
```

### ☐ A2.T5 — 로그인 시도 제한 (Q1 의존)
선행 A2.T2 · 산출 `packages/auth/src/policy/throttle.ts` · 되돌리기 커밋 2개 · 장치 요구 `Red: TC-A2.T5.a`

```
TC-A2.T5.a  같은 계정+IP 5번 실패 → 6번째 1초 지연(429·Retry-After 1), 이후 2·4·8 … 상한 900초
  검출:  지연 상한이 없어 공격자가 피해자 계정을 몇 시간씩 잠그는 것, 지연이 없어 대입이 빠른 것
TC-A2.T5.b  마지막 실패 15분 뒤 칸 초기화, 성공은 칸을 지움
TC-A2.T5.c  다른 IP 칸·다른 계정 칸은 따로 센다, 없는 이메일도 같은 응답·같은 지연
  검출:  지연을 계정이 있을 때만 걸어 지연 여부로 계정 존재가 드러나는 것
TC-A2.T5.d  두 인스턴스(같은 DB)가 칸을 함께 센다, 동시 실패 10건 → 실패 수 10 (Node DB 넷·D1)
  검출:  인스턴스 메모리에 세어 인스턴스 수만큼 시도가 늘어나는 것
TC-A2.T5.e  IP 를 정하지 못한 요청은 `unknown` 칸 하나가 아니라 계정 칸만으로 센다 (M3 LOW 백로그)
```

### ☐ A2.T6 — 감사 기록 1년 정리 (Q5 의존)
선행 A2.T2 · 산출 `apps/server/src/audit/prune.ts`, `queue/runner.ts` 한 줄 · 되돌리기 커밋 1개

```
TC-A2.T6.a  365일 1초 지난 행만 지움, 364일·지금 행은 남음 (다섯 DB)
  검출:  초 단위·밀리초 단위 시각을 섞어 1년 안 행을 지우는 것
TC-A2.T6.b  한 번에 500행, 임대를 잃은 실행기는 0행
TC-A2.T6.c  실제 queueJob 에 등록됨
  검출:  정리 함수만 시험하고 실행기 등록이 빠지는 것
TC-A2.T6.d  운영 문서에 감사 1년·백업 30일 (G-M6.4·11 두 문장은 그대로 1번씩)
```

### ☐ A2.T7 — 초대 72시간·재설정 30분과 봉인 시험 갱신 (Q6·Q7 의존)
선행 A2.T0·A2.T2 · 산출 `apps/server/src/invites/admin.ts`, `packages/auth/src/index.ts`, 봉인 단계 시험 파일 · 되돌리기 커밋 2개 · 장치 요구 `Red: TC-A2.T7.a`

【작업】
1. 초대 만료를 `AUTH_INVITE_TTL_S`(72시간) 고정으로, `expiresInDays`는 400 `invalid_expires`. 이미 있는 초대의 `expires_at`은 바꾸지 않는다 (마이그레이션·백필 없음).
2. 재설정 토큰 수명을 `AUTH_RESET_TTL_S`(30분)로.
3. 영향표대로 봉인 단계 시험을 고친다 (아래 「봉인 시험 갱신 방식」). 계획서 v5.9 줄과 3단계 실행판 Q4·Q17 결정 줄을 고친다. 커밋.

```
TC-A2.T7.a  새 초대 expires_at == now + 72시간, expiresInDays 7·30·31·0 → 400 invalid_expires
  검출:  관리자가 만료를 늘려 72시간 고정 결정을 우회하는 것
TC-A2.T7.b  A2 배포 전 7일로 만든 초대는 6일째에 수락된다 (원래 만료 유지)
  검출:  만료를 읽을 때 created_at + 72시간으로 다시 계산해 이미 보낸 초대가 갑자기 죽는 것
TC-A2.T7.c  재설정 링크 30분 1초 뒤 → 거부, 29분 → 성공
  검출:  Better Auth 기본 1시간이 남는 것
TC-A2.T7.d  봉인 단계 검사 불변 (G-A1.18 과 같은 명령) 과 봉인 단계 잡 전부(1단계 잡·p2-k*·p3-m*) 초록
```

### 봉인 시험 갱신 방식 (판단)

**된다.** 근거는 장치가 실제로 보는 것이다.
- 봉인 진위(`sealProblem`)는 검사 **ID 목록**과 `ok`만 본다. 시험 파일 내용이나 `cmd`는 보지 않는다. 봉인 재검(`gate.yml` rerun)은 **봉인 커밋**의 작업 트리에서 돌기 때문에 나중에 고친 시험의 영향을 받지 않는다.
- 대신 CI 단계 잡이 PR 마다 **지금 코드**로 `gate.mjs M1`·`M3` 등을 돈다. 그래서 고친 시험이 같은 `-t` 선택식에 걸리고 같은 수만큼 통과해야 한다.
- vitest `-t`는 이름의 부분 일치다. `"TC-M3.T1.c"`는 이름 앞머리만 남으면 뒤 설명을 바꿔도 같은 1개를 고른다. 예: `TC-M3.T1.c 만료: 늘 now+72시간, expiresInDays 는 400` (G-M3.3 `expectPassed: 1` 유지). `test/invites/checks.ts`의 T1.h·i 는 `expiresInDays` 입력만 빼고 "expires_at 왕복 일치" 단언을 72시간 값으로 바꾼다 (G-M3.22·23·24 의 1·12·1 유지).
- 감사 무기한(Q17)은 M1 시험이 단언하지 않는다 (TC-M1.T3.a~c 는 detail 키·action 허용 목록만 본다). 그래서 M1 은 시험이 아니라 문서만 고친다: 3단계 실행판 Q17 결정 줄, 계획서 v5.9 줄. 새 정리 작업 시험은 A2 검사(TC-A2.T6)다.
- 봉인 단계에 검사를 더하거나 빼면 그 봉인이 ⚠ 가 된다. 새 결정의 새 단언은 모두 A2 검사로 둔다.

지킬 것: 시험 이름 앞머리·`-t` 선택식·`expectPassed`·검사 정의(G-A1.18) 불변. 바꾸는 것은 입력 상수·공용 fixture·단언뿐 (Q7). 같은 시험 파일에 새 시험을 더할 때는 봉인 단계 선택식에 걸리지 않는 이름(`TC-A2.…`)만 쓴다.

### A2 영향표

| 파일 | 시험 | 검사 | 바꿀 것 | 통과 수 |
|---|---|---|---|---|
| `apps/server/test/invites/admin.test.ts` | TC-M3.T1.c | G-M3.3 | 단언 7일·30일 → 72시간, expiresInDays → 400 | 1 그대로 |
| `apps/server/test/invites/checks.ts` | TC-M3.T1.h·i | G-M3.22·23·24 | 입력 expiresInDays 제거, 왕복 단언 72시간 | 1·12·1 그대로 |
| `packages/auth/test/signup-confirmation.test.ts` | H1.CHANGE | G-M2.52 등 | `"a".repeat(129)` 단언의 이유를 길이에서 종류로 (400 그대로) | 그대로 |
| (A2.T0 이 채움) | 미조사 | | | |

## 🚪 GATE A2 (A2 를 시작할 때 `gates.config.mjs`에 채운다)

| id | 검사 | 명령 | 통과 기준 |
|---|---|---|---|
| G-A2.1 | 영향표 미조사 0 | grep `\| 미조사 \|` in 이 문서 | == 0 |
| G-A2.2 | 미정 질문 0 (A2) | grep `^- 결정: 미정 \(A2\)$` in 이 문서 | == 0 |
| G-A2.3~5 | V33~V35 present·unblocked·resolved | `node scripts/check-verify.mjs <동작> --set phase4` | 종료코드 0 |
| G-A2.6 | TC-A2.T1.a~c | `node --test … scripts/check-verify.test.mjs` `TC-A2.T1` | 통과 = 3 |
| G-A2.7 · 8 | TC-A2.T2.a~d · 재현 빨강 | `pnpm -C apps/server test test/policy -t "TC-A2\.T2\."` · check-red | 통과 = 4 · 0 |
| G-A2.9 | TC-A2.T3.a~c·e·f | `pnpm -C packages/auth exec vitest run test/policy -t "TC-A2\.T3\.[abcef]"` | 통과 = 5 |
| G-A2.10 · 11 | TC-A2.T3.d (Node DB 넷 · D1) · 재현 빨강 | [L] | 4 · 1 · 0 |
| G-A2.12 · 13 | TC-A2.T4.a~d · 재현 빨강 | `pnpm -C packages/auth exec vitest run test/policy -t "TC-A2\.T4\."` | 4 · 0 |
| G-A2.14 · 15 | TC-A2.T5.a~c·e · 재현 빨강 | `pnpm -C apps/server test test/policy -t "TC-A2\.T5\.[abce]"` | 4 · 0 |
| G-A2.16 · 17 | TC-A2.T5.d (Node DB 넷 · D1) | [L] | 4 · 1 |
| G-A2.18 · 19 | TC-A2.T6.a (다섯 DB) · b·c | [L] `test:db`·`test:workers` · `pnpm -C apps/server test -t "TC-A2\.T6\.[bc]"` | 5 · 2 |
| G-A2.20 | TC-A2.T6.d 운영 문서 | grep `감사 기록은 1년` · `백업은 30일` in `deploy/README.md` | 각 == 1 |
| G-A2.21 · 22 | TC-A2.T7.a~c · 재현 빨강 | `pnpm -C apps/server test test/policy -t "TC-A2\.T7\.[a-c]"` | 3 · 0 |
| G-A2.23 | 봉인 검사 불변 | `node scripts/check-sealed-checks.mjs --base origin/main` | 0 |
| G-A2.24 · 25 | 계획서 v5.9 · 3단계 Q4·Q17 대체 표시 | grep `^- v5\.9: .*4단계 A2` · grep `4단계 A2 가 대체` in phase3-todo | == 1 · == 2 |
| G-A2.26 | 타입 검사 | `pnpm -r typecheck` | 0 |
| G-A2.27 · 28 | CI 단계 잡 `p4-a2` · ruleset | grep `^\s+run: node scripts/gate\.mjs A2\b` · check-required-checks | == 1 · 0 |

**통과 기준**: 위 통과 + 봉인 단계 잡 전부 초록. 새 비밀번호·해시·세션·시도 제한·만료·보존이 배포 설정 값대로 동작하고, 값이 없으면 닫힌다. 봉인 단계 검사 정의는 하나도 바뀌지 않는다.

**막혔을 때**
- V33 에서 본안·예비안 둘 다 Workers 메모리를 넘으면 멈춘다. 매개변수를 더 낮추는 것은 사용자 결정이다.
- V35 에서 유휴 판정 자리가 없어 Better Auth 를 감싸야 하면 A2.T4 를 두 작업으로 나누고 보안 리뷰를 받는다.
- 봉인 시험이 단언만으로 맞지 않고 통과 수가 바뀌어야 하면 그 시험을 고치지 않고 멈춘다 (봉인 단계 검사는 못 바꾼다). 메인 세션이 계획을 정한다.

---

# U1 — 기본 회원 화면·최소 관리자 화면 🔒 (A2 필요)

**브랜치** `p4/u1`.
**outputs** `apps/web/src/lib/**`, `apps/web/test/**`, `apps/web/src/routes/{login,signup,verify,reset-password,invite,account,admin}/**`, `apps/server/test/ui-api/**`.
고칠 기존 파일: `apps/web/src/routes/{+layout.ts,+page.svelte}`, `apps/web/src/routes/setup/**`(A1 뒤 설치 응답의 bootstrap grant 처리), `apps/web/package.json`(Q8), `apps/server/src/routes/**`(필요할 때만 `GET /api/me`·`GET /api/signup-policy`), 정적 SPA·CSP 설정.
재사용: `apps/web/src/routes/setup/api.ts`의 판별 유니온·정확 Origin 통신. `/setup` 화면은 새로 만들지 않고, A1 이 더한 bootstrap grant 처리만 고친다 (TC-U1.T3.f).

🛡 보안 리뷰 대상: 초대 fragment 처리, 오류 메시지의 계정 존재 노출, MFA 화면의 seed·복구 코드 표시, CSP.

### ☐ U1.T0 — 화면이 쓸 API 계약표
선행 없음 · 산출 이 문서 「U1 API 계약표」 · 되돌리기 커밋 1개
- 로그인·가입·H1 확인·재설정·변경·초대 수락·자기 탈퇴·키·회원 관리·초대·가입 정책·메일 준비·admin-mfa 의 경로·입력·응답·오류 코드를 지금 서버 코드에서 읽어 표로 만든다. 문서와 코드가 다르면 둘 다 적고 `UNKNOWN`. 새 API 는 `GET /api/me`·`GET /api/signup-policy` 둘만 허용 목록 DTO 로 (통합 계획 B).

### ☐ U1.T1 — 웹 시험 기반 (Q8 의존)
- `apps/web`에 컴포넌트 시험 실행기. 설치는 승인 뒤 guarded-run 으로.
```
TC-U1.T1.a  컴포넌트 시험 실행기가 apps/web/test 의 시험 1개를 돈다
```

### ☐ U1.T2 — 공용 API 모듈·라우트 가드 (`apps/web/src/lib/**`)
```
TC-U1.T2.a  모든 요청이 정확 Origin·credentials same-origin·JSON 이고 응답을 판별 유니온으로 돌려준다
TC-U1.T2.b  401 → 로그인으로, 403 MFA_REQUIRED → MFA challenge 로, 503 auth_policy_unavailable·mfa_policy_unavailable → 닫힘 안내
  검출:  화면 가드만 보고 서버 403 을 무시해 빈 관리자 화면이 권한 있는 것처럼 보이는 것
```

### ☐ U1.T3 — 로그인·가입·H1 확인·재설정·변경·초대 수락
```
TC-U1.T3.a  공개 가입 진입은 GET /api/signup-policy 가 허용할 때만 보인다 (기본 OFF)
TC-U1.T3.b  H1 확인: 링크 GET 은 안내만, 비밀번호 확인 POST 뒤 완료. 비밀번호를 모르면 재설정으로 안내
TC-U1.T3.c  초대 토큰은 location.hash 에서만 읽고, 읽은 뒤 history.replaceState 로 지운다. 경로·query 에 토큰을 넣지 않는다
  검출:  토큰을 query 로 옮겨 서버 접근 기록·Referer 에 남는 것
TC-U1.T3.d  승인 대기·정지·만료/잘못된 초대·메일 미설정·시도 제한(429 Retry-After)·인증 실패를 서로 다른 안내로, 계정 존재는 드러내지 않음
TC-U1.T3.e  비밀번호 입력 안내가 A2 규칙(8자·4종 중 3종)과 같다, 서버 400 PASSWORD_TOO_WEAK 를 그대로 보인다
TC-U1.T3.f  /setup 성공 응답의 bootstrap grant 는 한 번만 보이고 곧바로 MFA 등록 화면으로 넘긴다. localStorage·URL·로그에 남지 않고, 새로 고치면 다시 보이지 않는다 (재발급은 POST /api/setup/mfa-grant 안내)
  검출:  설치 화면이 응답 전체를 상태 저장소에 남겨 grant 원문이 브라우저에 남거나, 등록 전에 화면을 닫아 첫 관리자가 MFA 를 마칠 길을 잃는 것
```

### ☐ U1.T4 — 내 계정 (인증수단 표시·키 관리·비밀번호 변경·자기 탈퇴)
```
TC-U1.T4.a  키 발급 응답의 원문 키는 한 번만 보이고 다시 보이지 않는다
TC-U1.T4.b  자기 탈퇴는 현재 비밀번호 proof 를 보내고, 관리자 탈퇴는 MFA proof 를 먼저 받는다
TC-U1.T4.c  SSO 버튼·IdP 선택은 없다
```

### ☐ U1.T5 — 최소 관리자 화면과 MFA 등록·확인
- 회원 목록·승인/거절·정지/해제·초대·가입 정책·메일 준비 상태, MFA 등록(grant)·challenge·step-up·복구 코드 표시. 기존 관리 API 만 쓴다.
```
TC-U1.T5.a  MFA 미충족 세션에서는 관리자 화면이 challenge·등록 화면만 보인다 (서버 403 MFA_REQUIRED 를 따름)
TC-U1.T5.b  seed·otpauth URI·복구 코드는 화면 상태에만 있고 localStorage·URL·로그에 남지 않는다
TC-U1.T5.c  역할 변경·관리자 초대 전에 step-up 을 받고 X-MFA-Proof 로 보낸다
```

### ☐ U1.T6 — 서버 쪽 화면 API (`apps/server/test/ui-api/**`)
```
TC-U1.T6.a  GET /api/me 는 허용 목록 필드만 (id·email·name·role·status·authMethods·mfaState), 비밀·내부 한도 사유 0
TC-U1.T6.b  GET /api/signup-policy 는 공개 가입 가능 여부·허용 도메인 여부만, 존재 계정·공급자 비밀 0
TC-U1.T6.c  OmniRoute API 키(Bearer)로 /api/me·관리 API → 401 (사람 세션과 서비스 키 분리)
```

### ☐ U1.T7 — 정적 SPA·CSP·접근성·모바일, U1 CI 잡과 봉인
```
TC-U1.T7.a  빌드 산출물에 inline script 0, CSP script-src 'self'
TC-U1.T7.b  모든 폼 입력에 레이블·오류 연결(aria-describedby), 색 말고도 상태 문자
TC-U1.T7.c  CI 단계 잡 p4-u1, ruleset
```

## 🚪 GATE U1 (U1 을 시작할 때 채운다)

| id | 검사 | 통과 기준 |
|---|---|---|
| G-U1.1 | 미정 질문 0 (U1): grep `^- 결정: 미정 \(U1\)$` | == 0 |
| G-U1.2~ | TC-U1.T1~T6 컴포넌트·서버 시험 (TC 마다 한 줄) | 선언 수 |
| | 재현 빨강: 화면 추가는 순수 추가라 없다. 서버 `GET /api/me` 가 기존 경로를 바꾸면 그 TC 에 Red | |
| | `pnpm -C apps/web build` · `pnpm -r typecheck` | 0 |
| | CI 단계 잡 `p4-u1` · ruleset | == 1 · 0 |

**통과 기준**: SSO 없이 화면에서 초대/허용된 자체 가입 → 이메일 확인 → 승인 → 로그인 → 키 발급·계정 관리가 된다 (브라우저 확인은 U5). 관리자 화면은 MFA 를 마친 세션에서만 관리 기능을 보인다.
**막혔을 때**: 화면에 필요한 API 가 계약표에 없으면 새 API 를 만들지 않고 멈춘다 (`/api/me`·`/api/signup-policy` 둘 밖은 계획 변경).

---

# U2 — 사용량 계약 확인 🔒 (U1 필요)

**브랜치** `p4/u2`.
**outputs** `docs/verify/V36.json`~`V38.json`, `packages/omniroute/test/contract/usage/**`.

### ☐ U2.T1 — V36 analytics 계약
- 계약 환경 OmniRoute(`127.0.0.1:20170`)에서 `getAnalytics`의 기간 경계(UTC, 양 끝 포함 여부), 금액 단위·반올림, `summary`·`byApiKey`의 뜻, `byModel`·일별 추세 필드 유무를 잰다.
```
TC-U2.T1.a  UTC 자정 직전·직후 호출 두 건이 기간 경계대로 나뉜다 (계약 시험)
TC-U2.T1.b  byApiKey 합 == summary (같은 기간)
TC-U2.T1.c  byModel·추세 필드가 없으면 V36 answer 에 "없음" 으로 남긴다 (0 으로 기록하지 않음)
```

### ☐ U2.T2 — V37 call-logs 계약
```
TC-U2.T2.a  limit 최대·offset·정렬 순서·완료 전 행·apiKeyId 없는 행의 모양
TC-U2.T2.b  다른 회원 키의 기록이 키 ID 거르개 없이 섞여 오는지 (어댑터가 거르는 책임 확인)
```

### ☐ U2.T3 — V38 성능과 캐시
- 회원 하나 분석 요청 p95, 동시 회원 수, 캐시 TTL 60초에서 OmniRoute 호출 수. `usage_daily`(지난 날 비용)와 오늘 분석 창을 어떻게 나눠 읽는지 (이중 합산 금지).

### ☐ U2.T4 — U2 CI 잡과 봉인

## 🚪 GATE U2 (U2 를 시작할 때 채운다)

| id | 검사 | 통과 기준 |
|---|---|---|
| | V36~V38 present·unblocked·resolved (`--set phase4`) | 0 |
| | TC-U2.T1~T2 계약 시험 [L] (로컬 arm64·CI amd64) | 선언 수 |
| | CI 단계 잡 `p4-u2` · ruleset | == 1 · 0 |

**통과 기준**: U3 가 연결할 지표마다 출처·기간 의미·단위가 확인 파일에 있다. 확인되지 않은 지표는 `unsupported`로 남는다 (Q11).
**막혔을 때**: OmniRoute 공식 계약과 실측이 다르면 둘 다 적고 그 지표는 U3 에서 닫는다.

---

# U3 — 사용량 API 🔒 (U2 필요)

**브랜치** `p4/u3`.
**outputs** `apps/server/src/usage/**`, `apps/server/test/usage/**`.

🛡 보안 리뷰 대상: 소유권(IDOR), 입력 허용 목록, 캐시 격리, 장애 시 동작.

경로는 `/api/me/usage` 꼴이다 (`/api/usage` 문자열은 G-M6.9 가 막는다).
```
TC-U3.T1.a  회원 A 세션으로 회원 B 의 키 ID·기록 → 403/404, 응답에 B 데이터 0 (IDOR)
TC-U3.T1.b  클라이언트가 보낸 userId·role·키 ID 목록으로 범위를 넓힐 수 없다 (서버가 소유 키만 고름)
TC-U3.T1.c  기간 형식·순서 역전·상한 초과·limit·offset 초과·모르는 거르개·정렬 → 400, 전체 조회로 물러서지 않는다 (Q10·V36·V37 의존)
TC-U3.T2.a  캐시 칸은 회원 ID·조회 범위로 나뉘고 TTL 60초
TC-U3.T2.b  정지·역할 변경·키 삭제·세션 철회 뒤 첫 요청은 캐시를 쓰지 않고 거부·새로 읽음 (인증은 요청마다 설치 DB 동기 확인)
TC-U3.T3.a  오늘 사용량 = 오늘 분석 창, 지난 날 = usage_daily, 둘을 겹쳐 더하지 않는다 (V38 의존)
TC-U3.T3.b  byModel·추세는 V36 이 확인한 경우만, 아니면 unsupported (Q11 의존)
TC-U3.T4.a  OmniRoute 장애·시간 초과·형식 불일치 → 503 usage_unavailable, 0·빈 값으로 성공하지 않는다
TC-U3.T4.b  사용량 API 장애가 키 상태 작업(queue)을 만들지 않는다 — 관리 화면 장애가 OmniRoute 중계를 멈추지 않는다
TC-U3.T4.c  OmniRoute API 키(Bearer)로 사용량 API → 401 (사람 세션만)
```

## 🚪 GATE U3 (U3 를 시작할 때 채운다)
- 미정 질문 0 (U3), TC-U3 각 줄(IDOR·캐시는 Node DB 넷·D1 두 줄), 어댑터 밖 `/api/(keys|usage)` 0 (G-M6.9 와 같은 규칙), 타입 검사, CI 단계 잡 `p4-u3`·ruleset.

**통과 기준**: 회원은 자기 키의 확인된 지표만, 정해진 범위 안에서 본다. 장애·권한 변경·캐시가 다른 회원 데이터나 낡은 권한을 내보내지 않는다.
**막혔을 때**: 측정 p95 가 V38 기준을 넘어도 캐시 TTL 을 늘리지 말고 멈춘다 (TTL 60초는 확정 사항).

---

# U4 — 분석 화면 🔒 (U3 필요)

**브랜치** `p4/u4`.
**outputs** `apps/web/src/routes/usage/**`. 공용 모듈은 U1 의 `apps/web/src/lib/**`(그때는 봉인돼 잠기지 않음)에 더한다.

```
TC-U4.T1.a  요약·키별·최근 호출·기간 선택은 U3 응답만 그린다, unsupported 지표는 감춘다
TC-U4.T1.b  빈 결과·미지원·지연·오류(503 usage_unavailable)를 서로 다른 화면으로
TC-U4.T1.c  금액·토큰 단위와 UTC 기간이 화면에 적혀 있다
TC-U4.T1.d  추세 값이 모자라면 차트 대신 확인된 요약만
TC-U4.T2.a  키보드만으로 기간·키 선택, 표는 머리칸·레이블, 작은 화면(360px)에서 가로 스크롤 없음
TC-U4.T2.b  CSP 그대로 (inline script 0)
```
## 🚪 GATE U4 (U4 를 시작할 때 채운다)
- TC-U4 컴포넌트 시험, 빌드·타입 검사, CI 단계 잡 `p4-u4`·ruleset.

**막혔을 때**: 차트 라이브러리가 필요하면 새 의존성 승인을 받는다. 그 전에는 표로만 보인다.

---

# U5 — 브라우저 시험·4단계 완료 기준·재발 방지 🔒 (U4 필요)

**브랜치** `p4/u5`.
**outputs** `tests/browser/**`.

### ☐ U5.T1 — 브라우저 시험 기반 (Q8 의존)
- Playwright, Docker SQLite 한 조합 (확정 사항). 회원은 DB 직접 주입이 아니라 초대·허용된 가입 흐름으로 만든다.

### ☐ U5.T2 — 4단계 완료 기준 시나리오
```
TC-U5.T2.a  설치 → 관리자 MFA 등록 → 초대 → 수락 → 이메일 확인 → 로그인 → 키 발급 → 사용량 화면 (브라우저)
TC-U5.T2.b  허용된 자체 가입 → H1 확인 → 승인 → 로그인 (브라우저)
TC-U5.T2.c  password-only 관리자는 관리 화면에서 challenge 만 보이고 관리 API 직접 호출도 403
TC-U5.T2.d  다른 회원 키 ID 를 주소창·직접 호출로 → 거부, 정지 직후 다음 요청 거부
TC-U5.T2.e  유휴 30분·시도 제한 안내가 화면에 맞게 나온다 (시계 주입)
```

### ☐ U5.T3 — 재발 방지·잔재 회수
- M3 LOW 백로그: Workers 수락 응답 시간 ≥ 400ms 실측. Q9 의 MFA 실제 값·전환 절차를 배포 템플릿·운영 문서에. 4단계 경로는 G-M6.1·G-M6.2 가 이미 덮는다 (`apps`·`packages` 전체).

### ☐ U5.T4 — 4단계 전체 봉인·순서·필수 검사
```
TC-U5.T4.a  봉인 S0~S7·K0~K6·M0~M6·A1·A2·U1~U4 모두 유효 (G-M6.5 와 같은 --status --json 판정)
TC-U5.T4.b  처음 커밋부터 순서 위반 없음
TC-U5.T4.c  CI 단계 잡 p4-u5 · ruleset
```

## 🚪 GATE U5 (U5 를 시작할 때 채운다)
- 미정 질문 0 (U5), TC-U5.T2 브라우저 시나리오 [L], 봉인·순서·필수 검사, 어댑터 밖 OmniRoute 관리 호출 0, CI 단계 잡.

**막혔을 때**: 브라우저 시험이 CI 에서 불안정하면 재시도로 덮지 않는다. 원인을 고치거나 그 조합을 로컬 [L] 검사로 남기는 계획 변경을 받는다.

---

## 최종 목표표

| 목표 | 판정 | 단계 |
|---|---|---|
| 관리자 로그인·민감 작업에 자체 TOTP MFA 필수, password-only·부분 세션·낡은 증거·재사용·저장소 장애 차단 | G-A1.6~17·20 | A1 |
| 봉인 단계 검사 정의 불변 (4단계 내내) | G-A1.18 → 뒤 단계마다 같은 검사 | A1~U5 |
| 비밀번호 8자·4종 중 3종·최대 없음·NFC, scrypt 2^16/8/2 해시·재해시가 세션을 끊지 않음 | G-A2.7~11 | A2 |
| 세션 유휴 30분·절대 12시간, 로그인 계정+IP 지수 지연 (DB 공유) | G-A2.12~17 | A2 |
| 초대 72시간 고정(기존 초대 유지)·재설정 30분·감사 1년 정리·백업 30일 문서 | G-A2.18~22 | A2 |
| 수치는 배포 설정 필수값, 없으면 닫힘 | TC-A2.T2.d·TC-A1.T1.f | A1·A2 |
| SSO 없이 브라우저로 설치 → 초대/가입 → 확인 → 승인 → 로그인 → 키 → 계정 관리 | TC-U5.T2.a·b | U1·U5 |
| 회원은 자기 키의 확인된 사용량만, 범위·캐시·장애가 다른 회원 데이터나 낡은 권한을 내보내지 않음 | TC-U3.* | U2·U3 |
| 사람 세션과 서비스 키 분리, 관리 화면 장애가 OmniRoute 중계를 멈추지 않음 | TC-U1.T6.c·TC-U3.T4.b·c | U1·U3 |
| 분석 화면 접근성·모바일·CSP | TC-U4.T2 | U4 |
| 4단계 봉인·순서·필수 검사 | TC-U5.T4 | U5 |

## 막혔을 때 (공통)

- 단계 검사가 계획대로 통과하지 않으면 숫자·단언을 실행 결과에 맞추지 않는다. 원인을 고치거나 메인 세션에 알린다.
- 봉인 단계 시험·검사를 바꿔야만 풀리는 문제는 4단계 안에서 풀지 않는다 (봉인 단계 불변).
- 새 의존성·도구 설치·외부 계정·비밀 발급·운영 데이터 조회는 각각 승인을 받는다.
- 무거운 시험은 guarded-run 으로만 돈다 (메모리 여유 30%·직렬·첫 실패 중단).

## 확인 결과에 기댄 TC 목록

| TC | 기대는 것 |
|---|---|
| TC-A2.T3.* | V33 (Workers scrypt), V34 (hasher·재해시 자리), Q2 |
| TC-A2.T4.* | V35, Q4 |
| TC-A2.T5.* | Q1 |
| TC-A2.T2.* | Q3 |
| TC-A2.T6.* | Q5 |
| TC-A2.T7.a | Q6 |
| TC-U3.T1.c | Q10, V36, V37 |
| TC-U3.T3.* | Q11, V36, V38 |

## 코드 미확인 TC 목록

- TC-A1.T2~T6(G-A1.6~20): 2026-10-19 실제 시험 구조로 교체했다 (A1 절). 계획 값 표시는 없다.
- G-A1.2 의 40 은 p4/a1-mfa 의 선언 수다 (`packages/auth/test/db.ts` `ALL_DBS`가 Node DB 넷 고정, 시험 10개). G-A1.3 의 5 는 `vitest.migrate.config.ts` include `test/migrate*.test.ts`가 `migrate-0007.test.ts`를 고르고 `--db` 다섯을 넘기는 값이다. 둘 다 실행 확인 전이다.
- U1~U5 의 GATE 표는 그 단계를 시작할 때 TC 마다 한 줄로 채운다.
