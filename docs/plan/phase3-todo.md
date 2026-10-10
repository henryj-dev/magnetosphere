# Magnetosphere 3단계 "회원·정책" — 실행 목록

계획은 [`../design/omniroute-member-layer.md`](../design/omniroute-member-layer.md) (v5.7) 다. 이 문서는 그 9장 3단계의 순서 · 통과 조건 · 잠금만 적는다. 논거는 계획서 절 번호로 가리킨다.

## 사용자에게 묻는 설계 질문

계획서가 정하지 않았거나 서로 어긋나 3단계 TC 의 단언을 쓸 수 없는 빈칸이다. 아래 본문은 모두 **(추천)** 선택지를 고른 것으로 쓰고, 질문에 기댄 곳에 `(Q<n> 의존)`을 붙였다. 고른 결과는 M0.T6 이 계획서 v5.8 로 넣는다. 고를 때마다 그 질문의 `결정: 미정`을 `결정: <선택지> (v5.8)`로 바꾼다 (`G-M0.11`이 `결정: 미정` 0개를 요구한다).

코드에서 확인한 사실 (2026-10-11, main `e307b4e`)
- 공개 가입이 지금 열려 있다. `apps/server/src/app.ts`는 설치 전에만 `/sign-up/*`를 403 `setup_required`로 막고, 설치 뒤에는 `signup_mode`(시드 `invite_only`)를 아무도 읽지 않는다. 설치 뒤 누구나 `/api/auth/sign-up/email`로 가입하고, 이메일 인증을 마치면 키를 받는다 (`monthly_limit_usd` NULL = 무제한).
- `invites` 테이블은 0000 마이그레이션에 있지만 운영 코드가 쓰지 않는다. 회원 `status`를 쓰는 운영 코드도 없다 (E2E·시험이 DB 에 직접 넣는다).
- `default_limit_usd`(시드 5)를 읽는 코드가 없다. `user.status` 기본값은 `active`다 (계획서 4.2 는 `open` 가입 직후 `pending`).
- 세션을 지우는 코드가 없다. Better Auth `session` 설정이 없어 쿠키 캐시는 기본값(꺼짐)이다 (V30 으로 확인).
- `/api/setup`의 관리자 판정(`setup/routes.ts` `requireAdmin`)은 `role`만 보고 `status`를 보지 않는다. `/api/setup` 변경 요청에는 `sameOrigin` 검사가 없다.
- 로그인·가입·초대 수락 화면이 없다 (`apps/web`에는 설치 화면뿐). 메일 설정 화면·API 는 설치 때의 Resend 하나뿐이다.

### Q1 — 지금 열려 있는 공개 가입을 언제 막나
- (가) **3단계 전에 따로 고침 PR 하나로 막는다 (추천)**. `/sign-up/*`를 `signup_mode == "open"`일 때만 통과시키는 작은 고침. 지금은 `open`을 고를 길이 없으므로 사실상 공개 가입이 닫힌다. PR #9 처럼 재현 커밋 + 고침.
- (나) M3 에서 정책 판정과 함께 막는다. 그때까지(대략 M0~M2) 공개 저장소에 가입 구멍이 남는다.
- 영향: (가)면 M3.T1 의 재현 빨강(`Red: TC-M3.T1.a`)은 이미 막힌 상태에서 시작하므로 재현 대상을 "정책별 판정"으로 바꾼다. (나)면 본문 그대로.
- 결정: 미정

### Q2 — 3단계에 화면을 넣나
- (가) **API 만 (추천)**. 초대 링크 모양(`<공개 주소>/invite#<토큰>`)만 정해 두고, 수락은 API 로 한다. 로그인·가입·초대 수락 화면은 회원 화면 묶음으로 4단계 앞머리에 넣는다.
- (나) 최소 화면 셋(로그인, 가입, 초대 수락 + 승인 대기·정지 안내)을 M5 앞에 단계 하나로 넣는다. 반나절 정도 늘어난다.
- 영향: (나)면 `M4a — 회원 화면`(outputs `apps/web/src/routes/(auth)/**`)이 생기고 M5 E2E 가 화면 대신 API 를 부르는 부분을 바꾸지 않아도 된다 (화면 시험은 따로).
- 결정: 미정

### Q3 — 정책마다 초대 링크가 통하나
- (가) **`invite_only`·`open`·`domain_allowlist`에서 통하고, `closed`·`sso_only`에서는 거부한다 (추천)**. `closed`는 "신규 가입 막음"이라 초대도 막는다. `sso_only`는 로컬 가입이 없으므로 초대 수락(비밀번호 설정)이 불가능하다. 두 정책에서는 초대 만들기도 409 `signup_closed`.
- (나) 초대는 정책과 관계없이 늘 통한다 (`closed`는 "공개 가입만 막음").
- 영향: TC-M2.T1.e · TC-M3.T1.a 의 표.
- 결정: 미정

### Q4 — 초대 링크 규칙
- (가) **모든 초대는 한 번만 쓴다. 만료 기본 7일, 최대 30일. 이메일을 지정한 초대는 그 이메일로만 수락. 관리자가 취소할 수 있다 (추천)**.
- (나) 이메일 없는 링크는 여러 번 쓸 수 있게(`max_uses`) 한다. 팀 채널에 링크 하나를 뿌리는 용도. 새어도 `member`만 생기지만 `open`과 거의 같아진다.
- 영향: (나)면 0003 마이그레이션에 `invites.max_uses`·`use_count`, 동시 수락 TC 가 "정확히 n" 으로 바뀐다.
- 결정: 미정

### Q5 — 메일 없는 설치에서 초대 회원의 이메일 인증 (계획서끼리 어긋남)
계획서 4.2 는 `invite_only`가 메일 없이 된다고 하고, 5.2 는 키 발급에 이메일 인증을 요구한다. 메일이 없으면 초대 회원은 인증 메일을 받지 못해 영원히 키를 못 받는다.
- (가) **이메일을 지정한 초대를 수락하면 `emailVerified = true`로 만든다. 관리자가 그 주소의 주인에게 링크를 건넸다고 본다. 이메일 없는 링크로 가입하면 인증 메일로 인증해야 하고, 메일이 없는 설치에서는 이메일 없는 링크를 만들 수 없다 (409 `mail_required`) (추천)**.
- (나) 초대 회원도 늘 인증 메일로 인증한다. 메일 없는 `invite_only` 설치는 키를 못 쓴다 (계획서 4.2 표를 "메일 필요"로 고친다).
- (다) 관리자가 회원을 "인증됨"으로 바꾸는 API 를 둔다.
- 영향: TC-M2.T2.c, TC-M5.T1.a. (가)는 링크가 새면 그 주소로 남이 가입한다 — 이메일 지정 초대도 링크를 받은 사람이 주인이라는 가정이다. 보안 리뷰 대상.
- 결정: 미정

### Q6 — 승인(`pending`)을 어디에 거나
- (가) **`signup_requires_approval`(기본 켬)은 자기 가입(`open`·`domain_allowlist`)에 건다. 초대 수락은 승인을 건너뛰고 바로 `active` (추천)**. 5단계 SSO JIT 는 IdP 설정의 몫으로 그때 정한다.
- (나) 계획서 문장 그대로 `open`에만 건다. `domain_allowlist`는 도메인만으로 믿는다.
- 영향: TC-M3.T2.a 의 표.
- 결정: 미정

### Q7 — `pending`·`suspended` 회원은 로그인되나
- (가) **둘 다 로그인을 막는다. 비밀번호가 맞으면 403 `account_pending`·`account_suspended`로 알려 주고 세션을 만들지 않는다 (추천)**. 비밀번호가 맞아야만 상태가 드러나므로 계정 존재 노출은 늘지 않는다.
- (나) 로그인은 되고 `/api/me/*`만 막는다 (화면이 생기면 "승인 대기" 안내를 보여 줄 수 있다).
- 영향: V31 이 필요해진다(가). TC-M4.T3.c.
- 결정: 미정

### Q8 — 상태 전이와 거절
- (가) **`pending → active`(승인), `pending → 행 삭제`(거절: 키·사용 기록이 없으므로 행을 지워 같은 이메일로 다시 가입할 수 있게), `active ↔ suspended`, `active·suspended → deleted`(되돌릴 수 없음). 그 밖의 전이는 409 (추천)**.
- (나) 거절도 `deleted`로 남긴다 (같은 이메일 재가입 불가).
- 영향: M1.T2 의 전이 표, TC-M4.T1.b.
- 결정: 미정

### Q9 — 삭제(탈퇴) 회원의 데이터
- (가) **`user` 행은 남기고 개인정보를 지운다: 이메일 → `deleted-<id>@invalid`, 이름 → 빈 값, `deleted_at` 설정. `account`·`session`·`verification` 행은 지운다. `api_keys` 행은 남긴다 (`deleted`, 사용액 근거). OmniRoute 키는 5.7 순서(끄기 → 60초 → `DELETE`)로 지운다. OmniRoute 기록·`usage_daily`·`audit_log`는 지우지 않는다 (추천)**. OmniRoute 호출 기록의 키 id 는 우리가 지울 수 없다 — 운영 문서에 적는다.
- (나) `user` 행을 지운다. `api_keys.user_id` 참조와 감사 기록의 주체가 끊기고, 같은 달에 같은 사람이 다시 가입하면 한도가 새로 생긴다.
- (다) 행과 개인정보를 그대로 둔다 (`status`만 `deleted`).
- 영향: 0003 마이그레이션 `user.deleted_at`, TC-M4.T2.d·e.
- 결정: 미정

### Q10 — 회원이 스스로 탈퇴하나
- (가) **된다. `DELETE /api/me` + 비밀번호 재확인. 최초 관리자는 못 한다 (추천)**. `open` 정책에서 외부 사용자가 자기 계정을 지울 길이 있어야 한다.
- (나) 관리자 삭제만. 자기 탈퇴는 7단계(관리 화면)나 2차로.
- 영향: M4.T4 유무.
- 결정: 미정

### Q11 — 역할을 더 나누나
- (가) **`member`·`admin` 둘 그대로 (추천)**. 읽기 전용 관리자 등은 2차.
- (나) `viewer`(전체 현황 읽기만)를 더한다. 4단계 화면 권한 검사가 셋으로 늘어난다.
- 영향: (나)면 `role` 값 검사·전이 표·권한 TC 가 모두 늘어난다.
- 결정: 미정

### Q12 — 관리자를 지키는 규칙
- (가) **최초 관리자(`is_bootstrap_admin`)는 강등·정지·삭제할 수 없다. 마지막 활성 관리자는 강등·정지·삭제할 수 없다. 자기 자신은 강등·정지할 수 없다. 관리자가 다른 관리자를 정지하는 것은 된다 (추천)**.
- (나) 최초 관리자도 다른 관리자가 바꿀 수 있다 (4.1 비상 로그인 `/login?local=1`의 주인이 사라질 수 있다).
- 영향: TC-M4.T1.d.
- 결정: 미정

### Q13 — 하루 가입 상한
- (가) **UTC 날짜로 센다. 자기 가입(`open`·`domain_allowlist`)만 세고 초대 수락은 세지 않는다. 넘으면 그날 남은 가입을 403 `signup_cap`으로 막고 `audit_log` `alert.signup_cap`을 하루 한 번 쓴다. `null`이면 상한 없음, `0`이면 자기 가입을 모두 막음 (추천)**. 세는 곳은 `rate_limit` 테이블(`consume`, D1 안전, 여러 인스턴스 공유).
- (나) 초대 수락도 센다.
- 영향: TC-M3.T3.a·b.
- 결정: 미정

### Q14 — 허용 도메인 규칙과 이메일 변경
- (가) **도메인은 정확히 일치(소문자, 하위 도메인 불포함, `*.` 표기 없음). 국제 도메인은 punycode 로 저장해 비교. 이메일 변경 경로는 3단계에서 열지 않고 막는다 (추천)**. 이메일을 바꿀 수 있으면 허용 도메인으로 가입한 뒤 바깥 도메인으로 옮길 수 있다.
- (나) `*.example.com` 표기로 하위 도메인을 허용한다.
- 영향: TC-M3.T2.b, V32.
- 결정: 미정

### Q15 — 메일 설정이 정책을 따라가지 못할 때
- (가) **"메일 설정됨" = `app_settings.mail_settings`가 있음. `open`·`domain_allowlist`는 메일이 있을 때만 저장된다 (409 `mail_required`). 가입 판정도 그 순간 메일이 없으면 이 두 정책의 자기 가입을 거부한다(fail-closed). 메일 설정을 지우는 API 는 3단계에 없다 (추천)**.
- (나) 메일이 사라지면 정책을 `invite_only`로 자동으로 되돌린다.
- 영향: TC-M1.T1.c, TC-M3.T1.c. E2E 의 `open` 시나리오는 가짜 Resend 수신기를 쓴다 (M5).
- 결정: 미정

### Q16 — 한도 정책 모델과 기본값 적용 시점 (계획서끼리 다름)
5.9 는 `max_keys` NULL 을 "설정 기본값"으로, `monthly_limit_usd` NULL 을 "무제한"으로 정의한다. 기본 월 한도($5)를 NULL 로 두면 무제한이 되므로, 기본 한도는 회원 행에 값을 써야만 걸린다.
- (가) **회원별 값 + 전역 기본값. 가입·초대 수락 때 `default_limit_usd`를 `monthly_limit_usd`에 복사해 쓴다 (나중에 기본값을 바꿔도 기존 회원은 그대로). `max_keys`는 NULL 로 두어 5.2 정의대로 기본값을 계속 따른다. 그룹·요금제는 2차 (추천)**. 초대에 한도를 싣지 않는다 (관리자가 수락 뒤 `PATCH /api/admin/users/:id`).
- (나) 초대에 한도·최대 키를 싣는다 (`invites.monthly_limit_usd`·`max_keys`).
- (다) `monthly_limit_usd` NULL 의 뜻을 "기본값"으로 바꾸고 무제한은 따로 표시한다 (2단계 분배·발급 코드와 시드가 바뀐다 — 큰 변경).
- 영향: TC-M3.T2.c, TC-M2.T2.d. 이미 있는 회원(3단계 전에 가입해 NULL)은 그대로 무제한이다. 운영 중인 설치가 없다고 보고 옮기지 않는다.
- 결정: 미정

### Q17 — 감사 기록 범위와 보존
- (가) **3단계의 모든 상태 변경을 남긴다: 가입(`member.signup`), 초대 만들기·취소·수락(`invite.*`), 승인·거절·정지·해제·역할·삭제(`member.*`), 정책 변경(`settings.update`), 하루 상한(`alert.signup_cap`). `target`은 회원·초대 id, `detail`에 이메일·이름을 넣지 않는다 (Q9 로 지운 개인정보가 감사 기록에 남지 않게). IP 는 남긴다. 보존은 무기한(정리 없음) (추천)**.
- (나) 관리자 동작만 남기고 가입·수락은 남기지 않는다.
- 영향: M1.T3 의 action 목록, 각 API TC 의 "audit_log 1행" 단언.
- 결정: 미정

### Q18 — `sso_only`를 3단계에서 고를 수 있나
IdP 는 5단계에 생긴다. 지금 `sso_only`를 고르면 로컬 가입이 막히고 JIT 도 없어 `closed`와 같다. 4.1 의 "SSO만 허용"(로그인 화면에서 비밀번호 숨김)과 4.2 의 `sso_only`(가입 정책)는 다른 설정이다.
- (가) **값은 받되, 켜진 IdP 가 하나도 없으면 409 `no_idp`로 저장을 거부한다. 3단계에는 IdP 가 없으므로 사실상 고를 수 없다. 판정 함수는 `sso_only`의 로컬 가입 거부까지 구현한다 (추천)**.
- (나) 3단계는 `sso_only`를 아예 받지 않는다 (400). 5단계가 연다.
- 영향: TC-M1.T1.b.
- 결정: 미정

---

## 0. 체계

이 절의 정의가 이 문서의 유일한 규칙이다. 여기 없는 표기는 본문에 쓰지 않는다.

**단계와 ID**
- 단계는 `M0`~`M6`. 계획서 9장 "3단계" 하나를 이 문서 안에서 일곱으로 나눈 것이다. 계획서의 단계 번호(0~8)와 섞지 않는다. 1단계 `S`, 2단계 `K`와 겹치지 않는다.
- 작업 ID는 `M<n>.T<m>`. 문서가 바뀌어도 같은 작업을 가리킨다. 번호는 재사용하지 않고, 지운 작업은 `(폐기)`로 남긴다.
- 검사 ID는 `G-M<n>.<k>`, 테스트케이스 ID는 `TC-M<n>.T<m>.<소문자>`.
- 계획서 8장 확인 항목은 `V<번호>`로 부른다. 3단계가 새로 여는 항목은 `V29`~`V32`다 (M0).
- 맨 위 질문은 `Q<번호>`로 부른다. 이 문서의 `Q`는 3단계 질문이다. 2단계 실행판의 설계 공백은 `2단계 Q1`처럼 부른다.
- 1·2단계 실행판([`phase1-todo.md`](phase1-todo.md), [`phase2-todo.md`](phase2-todo.md))의 ID(`S<n>`, `K<n>`, `G-S…`, `G-K…`, `TC-S…`, `TC-K…`)는 그 문서의 것을 그대로 가리킨다.

**상태 표기**
- 작업: ☐ 미착수 · ◐ 진행 · ☑ 완료
- 단계: 🔒 잠김 · 🔓 열림 · ✅ 봉인 · ⚠ 무효 · ➖ 면제 봉인
- 🔒 단계의 작업은 시작하지 않는다. 🔓은 선행 단계가 모두 ✅(또는 ➖)일 때만 된다. 판정은 `node scripts/gate.mjs --status`가 한다.

**작업 하나의 모양**
- 머리: `선행` (작업 ID) · `산출` (경로) · `되돌리기` (커밋 단위) · `장치 요구` (행동 변경이면 `Red:` 커밋, 아래)
- 본문: 【작업】 번호마다 커밋 하나 · 【테스트】 TC 목록 · 【통과】 기계 판정 체크박스
- 사람이 판단할 일(설계 선택, 계획서 문장, 저장소 설정)은 【작업】에만 적고 【통과】에는 그 결과를 기계가 읽는 검사만 둔다.
- `(사용자/메인 세션)` 표시가 붙은 작업 번호는 이 저장소 밖의 설정이라 작업자 에이전트가 할 수 없다. 그 결과는 검사가 확인한다.
- `🛡 보안 리뷰` 표시가 붙은 작업은 봉인 전에 보안 리뷰(별도 리뷰어)를 한 번 받는다. 리뷰에서 나온 고침은 2단계처럼 TC 를 더하고 GATE 표·`gates.config.mjs`에 넣는다.

**테스트케이스 규칙**
- 세 줄: 이름 · `단언:` (입력 → 기계로 확인하는 결과) · `검출:` (이 TC가 없으면 놓치는 구체적 결함과 그 결과)
- 검출줄을 못 쓰면 TC를 쓰지 않는다. 검출줄에는 코드의 사실(함수 이름, 상태코드, 예외 종류, 상수)을 쓴다.
- `(V<n> 의존)`·`(Q<n> 의존)`: 단언의 값이 확인 항목 `V<n>`의 결과 또는 질문 `Q<n>`의 결정(계획서 v5.8)으로 정해지는 TC. 결과·결정이 바뀌면 TC 단언도 같이 바뀐다. 목록은 문서 끝 「확인 결과에 기댄 TC 목록」.
- `(코드 미확인)`: 기대는 코드가 아직 저장소에 없어 열어 보지 못한 TC. 목록은 문서 끝 「코드 미확인 TC 목록」.

**GATE와 봉인 (장치가 실제로 강제하는 제약)**
- 장치: `node scripts/gate.mjs`. 검사 정의는 `gates/gates.config.mjs`의 데이터다 (1·2단계와 같은 파일, 3단계 단계는 `M0`부터 이어 붙였다). 봉인 파일은 `gates/seals/M<n>.json`이고 커밋한다.
- 명령: `gate <단계>` 실행 · `--seal` 봉인 · `--explain` 실패 측정값 · `--seal --waived "<사유>"` 면제 · `--status` 상태 표 · `--assert-order` 순서 위반 검사 · `--verify-seals --rerun` 봉인 커밋 재검 · `--skip-requires <태그>`·`--skip-ids <id,…>` 건너뛰기(건너뛴 실행으로는 봉인 안 됨).
- 규칙 R1 순서: 선행 봉인이 없으면 그 단계 검사 실행을 거부한다. R2 최신성: 봉인의 `head`가 기준 브랜치(`origin/main`, 없으면 `main`)의 조상이 아니면 ⚠ 무효다. R3 재검: `--seal`은 이전 결과를 읽지 않고 검사를 다시 돌린다.
- 검사가 하나도 없는 단계는 실행·봉인을 거부한다. `M1`~`M6`의 검사는 그 단계를 시작할 때 이 문서 GATE 표대로 `gates.config.mjs`에 채운다. `M0` 검사는 이 문서와 함께 채웠다.
- `--assert-order`는 기준 시점에 잠겨 있던 단계의 `needs`·`outputs`·`waivable` 변경, 단계 삭제, 잠긴 단계 `outputs`에 걸리는 파일 변경을 거부한다. 처음 커밋부터 도는 검사(ci.yml `order` 잡, 새 브랜치 첫 push 의 `gate.yml`)는 **지금 설정**의 잠긴 단계 `outputs`로 이력 전체를 본다. 그래서 3단계 단계의 `outputs`는 **그 단계가 새로 만드는, 이력에서 한 번도 바뀐 적 없는 경로만** 둔다 (2단계 `p2/plan`에서 실제로 겪었다). 3단계가 고칠 기존 파일(`apps/server/src/app.ts`, `routes/**`, `setup/**`, `keys/**`, `packages/auth/src/index.ts`, `packages/db/src/schema/**`, `seed.ts`)은 어느 단계 `outputs`에도 넣지 않고, 순서는 선행 봉인(R1)이 지킨다. 이 문서를 쓸 때 모든 `outputs` 경로가 `git log --all -- <경로>` 0건임을 확인했다.
- `test` 검사 판정: 종료코드 0 이고 통과한 테스트 수가 `expectPassed`와 **같아야** 한다. 3단계 단계는 `strictTests: true`라 `expectPassed`가 없는 `test` 검사는 실패다. GATE 표의 `통과 = n`은 `expectPassed: n`이다. `TC 수 × DB 수`로 적은 것은 TC 하나가 DB마다 테스트 하나씩 도는 경우다.
- `[L]`이 붙은 명령은 `requires: ["local-services"]` 검사다. 계약 환경 OmniRoute(`127.0.0.1:20170`), 시험 DB(MySQL `33306`·MariaDB `33307`·Postgres `35432`), mailpit 이 필요하다. CI 봉인 재검(`gate.yml`)은 이 검사를 건너뛰고, CI 단계 잡이 서비스를 띄워 그대로 돈다. `localhost:20128`(사람이 쓰는 OmniRoute)은 어떤 검사도 쓰지 않는다.
- 1단계 `G-S5.9`·2단계 `G-K4.23`(어댑터 밖에서 `/api/keys`·`/api/usage` 문자열 0)은 3단계 코드에도 걸린다. 회원 정지·삭제의 OmniRoute 반영은 K3 `applyKey`만 부른다.
- 병합은 **머지 커밋만**. 스쿼시·리베이스는 SHA 를 바꿔 봉인의 `head`가 main 의 조상이 아니게 되고(R2), 그 단계와 뒤 단계 봉인이 모두 ⚠ 가 된다.

**CI 단계 잡 규칙 (장치가 실제로 강제하는 제약)**
- 단계 봉인 파일을 커밋하는 순간부터 `.github/workflows/ci.yml`에 그 단계 게이트를 도는 잡이 있어야 한다 (`scripts/check-ci-matrix.mjs`, 2단계 K0.T2). 명령 줄은 run 줄의 시작에 있고, `--skip-requires`를 쓰지 않으며, `--skip-ids`는 매트릭스가 대신 도는 E2E 검사만, 잡·스텝에 `if`·`continue-on-error`·실패를 삼키는 셸 표현이 없다.
- 그래서 단계 봉인 커밋과 같은 PR 에 그 단계 잡(`p3-m<n>`)을 넣는다. GATE 마다 "CI 단계 잡" grep 검사가 봉인 전에 잡의 존재를 본다.
- 새 잡 이름은 main ruleset 의 필수 검사 목록에도 넣는다 `(사용자/메인 세션)`. `scripts/check-required-checks.mjs`가 ruleset 필수 검사 ⊇ CI 잡 이름, 병합 방식 = 머지 커밋만 을 확인한다.

**재현 빨강 (행동 변경 작업)**
- 행동을 바꾸는 작업은 커밋 두 개로 한다: (1) 재현 테스트만 넣은 커밋, 메시지에 꼬리줄 `Red: <TC ID>` (2) 고침.
- `node scripts/check-red.mjs --check <검사 ID> --since seal:<선행 단계>`가 그 범위에서 `Red: <TC>` 커밋을 찾아 그 커밋 작업 트리에서 검사 명령을 돌리고 **실패**해야 통과다.
- 순수 추가(새 모듈·새 API)는 재현 빨강을 요구하지 않는다. 기존 코드의 동작을 바꾸는 작업만 `장치 요구` 칸에 `Red:`를 적는다. 3단계는 기존 가입 경로·설치 경로·키 경로를 바꾸므로 Red 가 2단계보다 많다.

**문서 표기**
- `# M<n> — <제목> <단계 상태> (<선행> 필요)`: 단계 머리. `**outputs**` 줄은 `gates.config.mjs`의 그 단계 `outputs` 요약이다.
- `## 🚪 GATE M<n>`: 그 단계 검사 표. 열은 `id · 검사 · 명령 · 통과 기준`.

**확인 결과 파일 (`M0` 전용)**
- `docs/verify/V<번호>.json`: 1·2단계와 같은 모양 `{ "item", "question", "answer", "evidence", "blocking", "was_blocking", "resolved_in" }`. `blocking: true`면 계획서를 고친다 (2단계 0절과 같은 규칙).

**면제**
- 3단계 단계는 모두 `waivable: false`다. 범위를 줄이려면 계획서를 개정하고 해당 작업을 `(폐기)`로 표시한다.

## 진행 현황

이 표는 사람이 읽기 위한 사본이다. 판정은 항상 `node scripts/gate.mjs --status`가 한다 (1단계 `S0`~`S7`, 2단계 `K0`~`K6`은 모두 ✅).

| 단계 | 제목 | 상태 | 게이트 명령 | 봉인 |
|---|---|---|---|---|
| M0 | 확인 항목 넷과 계획서 v5.8 (질문 Q1~Q18) | 🔓 | `node scripts/gate.mjs M0` | — |
| M1 | 회원 기반: 설정·상태 전이·감사 기록·스키마 0003 | 🔒 | `node scripts/gate.mjs M1` | — |
| M2 | 초대 | 🔒 | `node scripts/gate.mjs M2` | — |
| M3 | 가입 정책 (정책 판정·도메인·승인·하루 상한·기본값·응답 시간) | 🔒 | `node scripts/gate.mjs M3` | — |
| M4 | 회원 관리 API 와 세션 무효화 | 🔒 | `node scripts/gate.mjs M4` | — |
| M5 | 3단계 완료 기준 E2E (정책별 시나리오·7장 회귀) | 🔒 | `node scripts/gate.mjs M5` | — |
| M6 | 재발 방지와 잔재 회수 | 🔒 | `node scripts/gate.mjs M6` | — |

크기: 2단계 단계와 비슷하게 단계마다 몇 시간. M3·M4 가 가장 크고(가입 경로 Red 여럿, 다섯 DB 동시성 시험), M0·M6 이 가장 작다.

## 선행 관계

```
K6 ─▶ M0 ─▶ M1 ─▶ M2 ─▶ M3 ─▶ M4 ─▶ M5 ─▶ M6
```
- 전부 직렬이다. 동시 진행 상한 1.
- M1 이 M0 을 기다리는 이유: 질문 Q1~Q18 의 결정이 스키마(0003)·상태 전이 표·설정 값 검사를 정하고, V29·V31 이 가입·로그인을 막는 자리(Better Auth 훅)를 정한다.
- M3 이 M2 를 기다리는 이유: `invite_only` 판정이 초대 토큰 확인을 부른다.
- M4 가 M3 을 기다리는 이유: 승인은 M3 이 만든 `pending` 회원을 대상으로 하고, 정지·삭제의 로그인 차단은 M3 의 Better Auth 훅 자리를 같이 쓴다.

## 3단계 범위 판단

| 계획서 | 이 문서에서 | 근거 |
|---|---|---|
| 4.2 가입 정책 다섯, 메일 의존 제한, `open` 남용 방지(인증 후 키·`pending`·기본 한도·기본 최대 키·하루 상한) | 함 (M1·M3) | 9장 3단계 내용 |
| 4.2 초대 (역할·만료, 관리자 초대 이메일 필수) | 함 (M2) | 9장 3단계 |
| 승인·정지·탈퇴 API, 4.5 세션 무효화(역할·정지·탈퇴·비밀번호 변경) | 함 (M4) | 9장 3단계 "승인, 정지, 세션 무효화". 2단계가 3단계로 넘김 (phase2 「범위 판단」) |
| 4.5 IdP 삭제·비활성화 때 세션 무효화 | 옮김 → 5단계 | IdP 가 5단계에 생긴다. 세션 무효화 함수(M4.T3)는 그때 그대로 부른다 |
| 4.5 역할 매핑·`sso_only` JIT | 옮김 → 5단계 | `sso_only` 판정의 로컬 가입 거부만 3단계 (Q18) |
| 4.4 피해자 이메일 선점 후 SSO 연결 (7장 회귀) | 옮김 → 5단계 | 계정 연결은 5단계. 3단계는 "인증 안 된 로컬 계정"을 만드는 경로를 바꾸지 않는다 |
| 회원 관리·설정 → 일반 **화면** (6장) | 옮김 → 7단계 | 9장 7단계 "관리 화면". 3단계는 API 까지 |
| 로그인·가입·초대 수락 **화면** (6장) | 옮김 → 4단계 앞머리 (Q2 의존) | 9장 어느 단계에도 없다. Q2 (나)면 이 문서에 단계가 생긴다 |
| 신규 회원 기본 월 한도 $5 적용 | 함 (M3) | 2단계가 3단계로 넘김. 적용 방식은 Q16 |
| CAPTCHA | 옮김 → 2차 (그대로) | 1장 |

## 1·2단계에서 넘어온 백로그

| 항목 | 결정 | 자리·이유 |
|---|---|---|
| TC-S3.T2.e 상한 250ms → 150ms (S7 리뷰 L1) | 함 | M3.T5. 가입 응답 시간을 맞추는 일과 같은 측정 도구로 정한다 |
| 가입 응답의 DB 쓰기 시간으로 계정 존재 노출 (S7 에서 찾음, CI 108ms) | 함 | M3.T5. 가입 응답을 고정 최소 시간까지 채운다. 초대 수락도 같은 규칙 |
| 2단계가 넘긴 정지·탈퇴 API | 함 | M4.T1·T2 |
| E2E 회원을 DB 에 직접 넣음 (`tests/e2e/keys/env.mjs` `addMember`) | 그대로 두고 3단계 E2E 는 초대 경로로 만든다 | M5. 2단계 키 시나리오는 봉인한 시험이라 고치지 않는다. M6.T2 가 "운영 코드는 회원을 직접 넣지 않는다"를 본다 |
| amd64·arm64 빌드 차이 — "3단계(정지)가 거부 응답을 회원에게 보여 주기 전에 다시 본다" (phase2 「막혔을 때」) | 함 (확인만) | M4.T5. 정지는 키를 끄기(403)로 막고 응답 본문을 회원 앱이 읽지 않는다. 두 아키텍처에서 정지 직후 첫 요청이 거부되는지만 계약 시험으로 본다 |
| `app_settings` 읽기·쓰기 도우미가 두 벌 (`setup/index.ts`의 지우고 넣기, `limits/store.ts`의 upsert) | 함 | M1.T1. 3단계 설정은 한 벌만 쓴다. 설치 쪽 지우고 넣기(원자적이지 않음)는 바꾼다 |
| 감사 기록 쓰기가 자리마다 따로 (`admin-limits.ts`, `limits/*`, `keys/alerts.ts`, `queue/index.ts`) | 일부 함 | M1.T3 이 쓰기 함수 하나를 두고 3단계 코드가 쓴다. 2단계 자리는 봉인한 시험을 건드리므로 옮기지 않는다 |

---

# M0 — 확인 항목 넷과 계획서 v5.8 🔓 (K6 필요)

**브랜치** `p3/m0`.
**outputs** `docs/verify/V29.json`~`V32.json`, `packages/auth/test/verify-p3/**`. 확인 결과가 어떻든 이 경로 밖으로 나가지 않는다. `scripts/check-verify.mjs`(기존 파일)는 `outputs`에 없다.

### ☐ M0.T1 — 확인 결과 검사기에 3단계 묶음
선행 없음 · 산출 `scripts/check-verify.mjs`, `scripts/check-verify.test.mjs` · 되돌리기 커밋 1개

【작업】
1. `check-verify.mjs`의 묶음에 `phase3: ["V29", "V30", "V31", "V32"]`를 더한다. 기본값(`phase1`)과 `phase2`는 그대로. 커밋.

【테스트】
```
TC-M0.T1.a  phase3 정상 파일 넷은 세 모드 모두 통과한다
  단언:  임시 폴더, V29~V32 정상 → present·unblocked·resolved --set phase3 모두 0
  검출:  묶음 이름 오타로 phase3 가 빈 목록이 되어 "0개 항목 통과"로 늘 초록인 것
TC-M0.T1.b  phase3 에서 하나가 빠지거나 막으면 실패한다
  단언:  V31 없음 → present ≠ 0, V29 blocking true → unblocked ≠ 0
  검출:  가입 거부 훅(V29)을 확인하지 않고 M3 을 여는 것
TC-M0.T1.c  phase1·phase2 묶음은 그대로다
  단언:  1단계 일곱 파일 폴더 → present (인자 없음) 0, 2단계 일곱 파일 폴더 → present --set phase2 0
  검출:  묶음을 더하며 기본값을 바꿔 S1 봉인 커밋 재검(ci.yml s1-seal)·K0 재검이 깨지는 것
```

【통과】
- [ ] G-M0.1 통과
- [ ] G-M0.14 통과 (스크립트 테스트 전부)

### ☐ M0.T2 — V29 가입을 막는 자리 (Better Auth `databaseHooks.user.create.before`)
선행 M0.T1 · 산출 `docs/verify/V29.json`, `packages/auth/test/verify-p3/v29.test.ts` · 되돌리기 커밋 1개

【작업】
1. better-auth 1.7.7 로 `databaseHooks.user.create.before`가 `APIError("FORBIDDEN", { code: "signup_closed" })`를 던질 때를 잰다: `/sign-up/email` 응답 상태·본문, `user`·`account`·`verification` 행 수, 인증 메일 발송 수, 네 DB(sqlite·mysql·mariadb·pg, `transaction: true`). 서버에서 `auth.api.signUpEmail({ body })`를 부를 때 훅의 두 번째 인자(`ctx`)에 요청이 있는지(`ctx.request`·`ctx.path`)도 적는다 — 초대 수락(M2)이 이 구분을 쓴다. `answer = { rejectStatus, rejectCode, rowsLeft: {user, account, verification}, mailSent, serverCallCtx: { path, hasRequest } }`. 행이 남거나 메일이 나가면 `blocking: true` — 그때는 훅 대신 `hooks.before`(경로 `/sign-up/email`)에서 막는 쪽으로 계획서를 개정한다. 커밋.

【테스트】
```
TC-M0.T2.a  가입 거부 훅이 행도 메일도 남기지 않는다 (V29 의존)
  단언:  위 조건으로 /sign-up/email → 상태·code == answer, user·account·verification 0행, 메일 0통 (네 DB)
  검출:  훅이 user 삽입 뒤에 돌거나 트랜잭션 밖이라, 거부한 가입의 account 행이 남아 같은 이메일 재가입이 "이미 있음"이 되는 것 (V26 의 better-sqlite3 원자성 사고와 같은 꼴)
TC-M0.T2.b  서버 호출과 공개 요청을 훅이 가른다 (V29 의존)
  단언:  auth.api.signUpEmail 서버 호출 · HTTP /sign-up/email 각각 → 훅 ctx 의 path·request 유무 == answer.serverCallCtx
  검출:  초대 수락 API 가 부른 가입도 공개 가입으로 보여 invite_only 에서 초대 수락까지 막히거나, 반대로 공개 요청이 서버 호출처럼 보여 정책을 비켜 가는 것
```

【통과】
- [ ] G-M0.5 통과
- [ ] G-M0.2 · G-M0.3 · G-M0.4 통과 (V29 포함)

### ☐ M0.T3 — V30 세션 행을 지우면 바로 끊기나
선행 M0.T1 · 산출 `docs/verify/V30.json`, `packages/auth/test/verify-p3/v30.test.ts` · 되돌리기 커밋 1개

【작업】
1. 지금 구성(`session` 설정 없음)에서 로그인 → 그 회원의 `session` 행을 DB 에서 지움 → 옛 쿠키로 `/api/auth/get-session`. 쿠키 캐시 기본값, 지운 직후 첫 요청의 결과, `/change-password`에 `revokeOtherSessions` 없이 보냈을 때 다른 세션이 남는지 적는다. `answer = { cookieCacheEnabled, firstRequestAfterDelete, otherSessionsAfterPasswordChange }`. 지운 뒤에도 세션이 살아 있으면(`cookieCacheEnabled: true`) `blocking: true` — 계획서 4.5 에 캐시 수명만큼의 지연을 적거나 캐시를 끈다. 커밋.

【테스트】
```
TC-M0.T3.a  세션 행을 지운 뒤 첫 요청부터 세션이 없다 (V30 의존)
  단언:  로그인 → session 행 삭제 → get-session 첫 요청 == answer.firstRequestAfterDelete (null 기대) (네 DB)
  검출:  Better Auth 쿠키 캐시가 켜져 있어 정지한 회원이 캐시 수명 동안 /api/me/keys 로 키를 다시 켜는 것
TC-M0.T3.b  비밀번호 변경은 기본으로 다른 세션을 남긴다 (V30 의존)
  단언:  세션 둘 → 한쪽에서 /change-password (revokeOtherSessions 없음) → 다른 세션 유효 == answer.otherSessionsAfterPasswordChange
  검출:  클라이언트가 revokeOtherSessions 를 보내야만 다른 세션이 끊겨, 비밀번호를 바꿔도 훔친 세션이 그대로 사는 것 (4.5 "비밀번호 변경")
```

【통과】
- [ ] G-M0.6 통과

### ☐ M0.T4 — V31 로그인을 막는 자리 (`databaseHooks.session.create.before`) (Q7 의존)
선행 M0.T1 · 산출 `docs/verify/V31.json`, `packages/auth/test/verify-p3/v31.test.ts` · 되돌리기 커밋 1개

【작업】
1. `session.create.before`가 회원 `status`를 읽어 `APIError("FORBIDDEN", { code: "account_suspended" })`를 던질 때: `/sign-in/email`(맞는 비밀번호·틀린 비밀번호), `/reset-password` 뒤 자동 로그인 여부, 이메일 인증 링크 뒤 자동 로그인 여부(`autoSignInAfterVerification` 기본값)를 잰다. `answer = { rejectStatus, rejectCode, sessionRows, wrongPasswordStatus, resetCreatesSession, verifyCreatesSession }`. 거부해도 세션 행이 남으면 `blocking: true`. 커밋.

【테스트】
```
TC-M0.T4.a  로그인 거부 훅은 세션을 만들지 않는다 (V31 의존)
  단언:  status suspended 회원, 맞는 비밀번호 → 상태·code == answer, session 0행, Set-Cookie 에 세션 쿠키 없음. 틀린 비밀번호 → answer.wrongPasswordStatus (네 DB)
  검출:  훅이 세션 삽입 뒤에 돌아 거부 응답과 함께 쓸 수 있는 세션 쿠키가 나가는 것
TC-M0.T4.b  세션을 만드는 다른 경로도 같은 훅을 지난다 (V31 의존)
  단언:  suspended 회원의 비밀번호 재설정·이메일 인증 링크 → 세션 생기는지 == answer.resetCreatesSession·verifyCreatesSession, 생기면 훅이 거부
  검출:  로그인만 막고 재설정 링크의 자동 로그인으로 정지 회원이 세션을 얻는 것
```

【통과】
- [ ] G-M0.7 통과

### ☐ M0.T5 — V32 기본으로 열린 회원 변경 경로 (Q14 의존)
선행 M0.T1 · 산출 `docs/verify/V32.json`, `packages/auth/test/verify-p3/v32.test.ts` · 되돌리기 커밋 1개

【작업】
1. 지금 구성으로 로그인한 회원이 부를 수 있는 Better Auth 경로를 1.7.7 경로 목록(`auth.api`의 키)에서 뽑아 하나씩 부른다. 회원 정보를 바꾸는 것(`/change-email`, `/delete-user`, `/update-user`의 `email`, `/revoke-sessions`, `/revoke-other-sessions`, `/link-social`, `/unlink-account` 등)의 상태코드를 적는다. `answer = { paths: [{ path, status, effect }] }`. 이메일을 바꾸거나 회원을 지우는 경로가 열려 있으면 `blocking: true` — M3.T1 이 `disabledPaths`에 더하도록 계획서에 적는다. 커밋.

【테스트】
```
TC-M0.T5.a  회원 변경 경로의 기본 상태가 V32 와 같다 (V32 의존)
  단언:  answer.paths 의 경로마다 같은 요청 → 상태코드 == answer, effect 가 "이메일 바뀜"·"회원 지워짐"이면 그 경로가 answer 에 막을 경로로 표시됨
  검출:  /change-email 이 기본으로 열려 허용 도메인으로 가입한 뒤 바깥 도메인으로 옮기거나, /delete-user 로 user 행이 지워져 api_keys 사용액 근거가 사라지는 것
```

【통과】
- [ ] G-M0.8 통과

### ☐ M0.T6 — 계획서 개정 v5.8 (질문 Q1~Q18 과 V29~V32)
선행 M0.T2 ~ M0.T5 · 산출 `docs/design/omniroute-member-layer.md`, 이 문서 · 되돌리기 커밋 1개

【작업】
1. `(사용자/메인 세션)` 맨 위 질문 Q1~Q18 을 고른다.
2. 고른 결과와 V29~V32 결과를 계획서에 반영한다 (4.2·4.5·4.6·5.9·6장·7장·9장). 상태 줄을 `v5.8`로, 변경 이력 맨 위에 `- v5.8: …` 한 줄(3단계 Q1~Q18 을 모두 언급). 함께 고칠 낡은 문장: 5.9 "사용량 데이터는 OmniRoute에 있으므로 우리 DB에 두지 않는다" (v5.7 의 `usage_daily`와 어긋남). 이 문서의 `결정: 미정`을 모두 바꾸고, 추천과 다르게 고른 질문의 `(Q<n> 의존)` TC 단언을 고친다. 커밋.

【테스트】
```
TC-M0.T6.a  계획서 개정이 질문 열여덟을 모두 닫는다
  단언:  grep "^- v5\.8: .*Q1\b.*Q18\b" 계획서 → 1, 상태 줄 v5.8 이상 → 1, 이 문서 "결정: 미정" → 0, check-verify resolved --set phase3 → 0
  검출:  Q5 를 남긴 채 M2 를 열어 메일 없는 설치의 초대 회원이 키를 영원히 못 받는 채로 3단계를 끝내는 것
```

【통과】
- [ ] G-M0.9 · G-M0.10 · G-M0.11 · G-M0.4 통과

### ☐ M0.T7 — M0 CI 잡과 봉인
선행 M0.T1 ~ M0.T6 · 산출 `.github/workflows/ci.yml` · 되돌리기 커밋 1개

【작업】
1. 잡 `p3-m0`(이름 `확인 (M0 게이트, 네 DB)`) 스텝 `run: node scripts/gate.mjs M0 --explain`, `env: GH_TOKEN: ${{ github.token }}`. 커밋.
2. `(사용자/메인 세션)` ruleset 필수 검사에 그 이름.
3. `gate M0 --seal` → 커밋 → PR → 머지 커밋.

【테스트】
```
TC-M0.T7.a  M0 게이트를 도는 CI 잡이 있다
  단언:  grep "^\s+run: node scripts/gate\.mjs M0\b" .github/workflows/ci.yml → 1 (G-M0.12)
  검출:  봉인 PR 에 잡을 빠뜨려, 병합 뒤 main 의 guard 잡(G-S7.1)이 처음 빨개지는 것
TC-M0.T7.b  ruleset 필수 검사가 이 잡을 포함한다
  단언:  node scripts/check-required-checks.mjs --repo henryj-dev/magnetosphere → 0 (G-M0.13)
  검출:  잡은 있으나 필수 검사가 아니라 빨간 채로 PR 이 병합되는 것
```

【통과】
- [ ] G-M0.12 · G-M0.13 통과

## 🚪 GATE M0

| id | 검사 | 명령 | 통과 기준 |
|---|---|---|---|
| G-M0.1 | TC-M0.T1.a ~ c | `node --test --test-reporter=tap --test-name-pattern="TC-M0.T1" scripts/check-verify.test.mjs` | 통과 = 3 |
| G-M0.2 | 확인 파일 넷 존재·모양 | `node scripts/check-verify.mjs present --set phase3` | 종료코드 0 |
| G-M0.3 | 설계를 막는 결과 없음 | `node scripts/check-verify.mjs unblocked --set phase3` | 종료코드 0 |
| G-M0.4 | 막았던 결과는 현재 계획서 버전 | `node scripts/check-verify.mjs resolved --set phase3` | 종료코드 0 |
| G-M0.5 | TC-M0.T2.a·b V29 | [L] `pnpm -C packages/auth test -t "TC-M0.T2"` | 통과 = 8 (TC 2 × DB 4) |
| G-M0.6 | TC-M0.T3.a·b V30 | [L] `pnpm -C packages/auth test -t "TC-M0.T3"` | 통과 = 8 |
| G-M0.7 | TC-M0.T4.a·b V31 | [L] `pnpm -C packages/auth test -t "TC-M0.T4"` | 통과 = 8 |
| G-M0.8 | TC-M0.T5.a V32 | [L] `pnpm -C packages/auth test -t "TC-M0.T5"` | 통과 = 4 |
| G-M0.9 | TC-M0.T6.a 질문 Q1~Q18 닫음 | grep `^- v5\.8: .*Q1\b.*Q18\b` 계획서 | == 1 |
| G-M0.10 | 계획서 v5.8 이상 | grep `^상태: 초안 v5\.([8-9]\|[1-9][0-9])` 계획서 | == 1 |
| G-M0.11 | 이 문서에 미정 질문 0 | grep `결정: 미정` in `docs/plan/phase3-todo.md` | == 0 |
| G-M0.12 | TC-M0.T7.a CI 단계 잡 | grep `^\s+run: node scripts/gate\.mjs M0\b` in ci.yml | == 1 |
| G-M0.13 | ruleset · TC-M0.T7.b | `node scripts/check-required-checks.mjs --repo henryj-dev/magnetosphere` | 종료코드 0 |
| G-M0.14 | 스크립트 테스트 전부 | `node --test --test-reporter=tap "scripts/*.test.mjs"` | 종료코드 0 |

`node scripts/gate.mjs M0 --seal`

가장 중요한 검사는 G-M0.5 다. 3단계의 모든 가입 정책은 "거부한 가입은 아무 행도 메일도 남기지 않는다"는 전제 위에 있다. 이 전제가 한 DB 에서만 깨지면 그 DB 에서는 거부된 이메일이 "이미 있는 계정"으로 굳어, 나중에 초대를 받아도 가입하지 못한다.

---

# M1 — 회원 기반: 설정·상태 전이·감사 기록·스키마 0003 🔒 (M0 필요)

**브랜치** `p3/m1`.
**outputs** `packages/db/migrations/*/0003_*`, `apps/server/src/settings/**`, `apps/server/test/settings/**`, `apps/server/src/members/**`, `apps/server/test/members/**`, `apps/server/src/audit/**`, `apps/server/test/audit/**` (새 경로만). 고칠 기존 파일(`packages/db/src/schema/**`, `seed.ts`, `setup/index.ts`)은 `outputs`에 없다.

### ☐ M1.T1 — 설정 저장소 하나 (`settings/`)
선행 없음 · 산출 `apps/server/src/settings/**`, `apps/server/test/settings/**`, `apps/server/src/setup/index.ts` · 되돌리기 커밋 2개 · 장치 요구 `Red: TC-M1.T1.d`

【작업】
1. `readSettings(h)` · `writeSetting(h, key, value, actorId, now)`: zod 스키마로 키마다 값을 검사한다. `signup_mode` ∈ 다섯, `allowed_domains` 문자열 배열(소문자·punycode, 최대 100개, Q14), `signup_requires_approval` 참·거짓, `daily_signup_cap` null 또는 0 이상 정수(Q13), `default_limit_usd` null 또는 `DECIMAL(12,6)` 범위, `default_max_keys` 0 이상 정수. 쓰기는 upsert 한 문장(다섯 DB). `mailConfigured(h)` = `mail_settings` 행 있음 (Q15). 정책 검사: `open`·`domain_allowlist`는 메일 없으면 `mail_required`, `domain_allowlist`는 `allowed_domains` 비면 `domains_required`, `sso_only`는 켜진 IdP 없으면 `no_idp`(3단계에는 늘, Q18). 커밋.
2. 설치(`setup/index.ts`)의 `writeSetting`(지우고 넣기, 원자적이지 않음)을 이 upsert 로 바꾼다. 재현 커밋 `Red: TC-M1.T1.d` → 고침.

【테스트】
```
TC-M1.T1.a  잘못된 설정 값은 저장하지 않는다
  단언:  signup_mode "Open" · daily_signup_cap -1 · 1.5 · allowed_domains ["*.a.com"] · ["A.COM"](소문자로 저장) · default_limit_usd 1e13 → 앞 넷 400 성격의 SettingsError·행 변화 0, "A.COM" 은 "a.com" 으로 저장
  검출:  대문자 도메인이 저장돼 소문자로 바뀐 가입 이메일과 영원히 일치하지 않는 것, 음수 상한이 "상한 없음"으로 읽히는 것
TC-M1.T1.b  메일·도메인·IdP 가 없으면 그 정책을 저장하지 않는다 (Q15·Q18 의존)
  단언:  mail_settings 없음 + open → mail_required, domain_allowlist + 메일 있음 + 도메인 [] → domains_required, sso_only → no_idp. 각 경우 signup_mode 그대로
  검출:  메일 없는 설치에서 open 을 골라 이메일 인증 없이 누구나 가입하는 것 (4.2 "메일이 설정되지 않았으면 고를 수 없다")
TC-M1.T1.c  읽기는 시드 기본값을 채운다
  단언:  allowed_domains 행 없음(시드에 없음) → []. 시드 다섯 키 → 시드 값 그대로
  검출:  시드에 없는 allowed_domains 를 undefined 로 읽어 domain_allowlist 판정이 TypeError 로 500 이 나는 것
TC-M1.T1.d  설정 쓰기는 한 문장이라 동시 쓰기에 행이 사라지지 않는다
  단언:  같은 키에 writeSetting 20건 동시 → 그 키 행 정확히 1, 값은 20개 중 하나 (sqlite·mysql·mariadb·pg)
  검출:  setup/index.ts writeSetting 의 delete → insert 사이에 다른 쓰기가 끼어 기본 키 충돌 500 이 나거나, 지운 뒤 넣기가 실패해 public_base_url 행이 사라지는 것
```

【통과】
- [ ] G-M1.1 ~ G-M1.4 통과
- [ ] G-M1.16 통과 (Red 커밋에서 TC-M1.T1.d 실패)

### ☐ M1.T2 — 회원 상태 전이 (순수 함수) (Q8·Q12 의존)
선행 없음 · 산출 `apps/server/src/members/transition.ts`, `apps/server/test/members/**` · 되돌리기 커밋 1개

【작업】
1. `transition({ from, action, target, actor, adminCount })` → `{ ok: true, to }` 또는 `{ ok: false, code }`. 동작: `approve`(pending→active), `reject`(pending→행 삭제, Q8), `suspend`(active→suspended), `unsuspend`(suspended→active), `delete`(active·suspended→deleted), `promote`·`demote`. 보호(Q12): 최초 관리자는 demote·suspend·delete 불가(`bootstrap_admin`), 마지막 활성 관리자 demote·suspend·delete 불가(`last_admin`), 자기 자신 demote·suspend 불가(`self`). 그 밖 전이는 `invalid_transition`. 커밋.

【테스트】
```
TC-M1.T2.a  전이 표가 Q8 결정과 같다 (Q8 의존)
  단언:  4 상태 × 6 동작 24칸 표 == 기대 표 (허용 6칸, 나머지 invalid_transition). deleted 에서 나가는 전이 0
  검출:  deleted → active 를 허용해 개인정보를 지운 회원(Q9)이 이메일 deleted-<id>@invalid 로 되살아나는 것
TC-M1.T2.b  관리자 보호 규칙 셋 (Q12 의존)
  단언:  최초 관리자 demote·suspend·delete → bootstrap_admin, 활성 관리자 1명 demote → last_admin, 2명이면 ok, 자기 자신 suspend → self
  검출:  마지막 관리자가 자기 자신을 강등해 관리자 API 가 모두 닫히고 setup 도 adminExists(role='admin' 아무나)로 다시 열리지 않아 설치를 되살릴 길이 없는 것
```

【통과】
- [ ] G-M1.5 · G-M1.6 통과

### ☐ M1.T3 — 감사 기록 쓰기 하나 (`audit/`) (Q17 의존)
선행 없음 · 산출 `apps/server/src/audit/**`, `apps/server/test/audit/**` · 되돌리기 커밋 1개

【작업】
1. `writeAudit(h, { actorId, action, target, detail, ip, now })`: `action`은 허용 목록(Q17: `member.signup`, `member.approve`, `member.reject`, `member.suspend`, `member.unsuspend`, `member.role`, `member.delete`, `invite.create`, `invite.revoke`, `invite.accept`, `settings.update`, `alert.signup_cap`)과 2단계 이름만. `detail`은 JSON 객체이고 키 이름 허용 목록 밖(`email`, `name`, `password`, `token`, `*_hash`)은 던진다. 트랜잭션·D1 batch 안에서 쓸 수 있게 문장을 돌려주는 `auditStatement`도 둔다. 커밋.

【테스트】
```
TC-M1.T3.a  감사 기록에 개인정보·비밀 값이 들어가지 않는다 (Q17 의존)
  단언:  detail { email } · { token } · { tokenHash } · { nested: { email } } → 예외·행 0, detail { from, to } → 1행
  검출:  초대 기록에 원문 토큰이나 이메일이 남아, 탈퇴로 지운 개인정보(Q9)가 감사 기록에서 그대로 읽히는 것
TC-M1.T3.b  모르는 action 은 쓰지 않는다
  단언:  action "member.Suspend" · "x" → 예외, 허용 목록 12개 → 각 1행
  검출:  철자가 틀린 action 으로 기록돼 7단계 감사 화면의 거르기에서 정지 기록이 빠지는 것
```

【통과】
- [ ] G-M1.7 · G-M1.8 통과

### ☐ M1.T4 — 스키마 0003 (Q4·Q9 의존)
선행 없음 · 산출 `packages/db/src/schema/**`, `packages/db/migrations/{sqlite,mysql,pg}/0003_*` · 되돌리기 커밋 1개

【작업】
1. 공통 정의에 더한다: `invites.revoked_at`(시각, NULL), `invites.used_by`(id, NULL), `invites`에 색인 `(expires_at)`, `user.deleted_at`(시각, NULL, Q9). `user` 칼럼은 `USER_ADDITIONAL_FIELDS`에 `input: false`로 넣는다 (4.6). 세 벌 생성·마이그레이션. 커밋.

【테스트】
```
TC-M1.T4.a  다섯 DB 빈 상태·기존 행 상태에 0003 이 적용된다
  단언:  test:migrate --db sqlite,mysql,mariadb,pg,d1 → invites.revoked_at·used_by NULL 허용, user.deleted_at NULL 허용, 0002 까지 넣은 행이 있는 DB 에 0003 → 기존 값 그대로
  검출:  MySQL 마이그레이션에 user 를 백틱 없이 써(예약어) 그 DB 에서만 0003 이 실패하는 것
TC-M1.T4.b  새 user 칼럼은 가입·회원정보 수정 본문으로 쓸 수 없다
  단언:  /sign-up/email 본문 deletedAt · /update-user 본문 deletedAt → TC-S3.T1.a 와 같은 판정 (가입은 200 + NULL 유지 또는 400 + 계정 없음, 수정은 400 FIELD_NOT_ALLOWED)
  검출:  deleted_at 을 input 기본값(허용)으로 둬 회원이 자기 행에 deleted_at 을 넣어 탈퇴 처리 코드의 판단을 흐리는 것
TC-M1.T4.c  마이그레이션과 생성 스키마가 같다
  단언:  pnpm -C packages/db gen && git diff --exit-code packages/db/src/schema/ → 0, check:drift → 0
  검출:  공통 정의만 고치고 생성물을 안 만들어 Drizzle 이 없는 칼럼에 쓰는 것
```

【통과】
- [ ] G-M1.9 ~ G-M1.11 통과

### ☐ M1.T5 — M1 CI 잡과 봉인
선행 M1.T1 ~ M1.T4 · 산출 `.github/workflows/ci.yml` · 되돌리기 커밋 1개

【작업】
1. 잡 `p3-m1`(이름 `회원 기반 (M1 게이트, 다섯 DB)`) 스텝 `run: node scripts/gate.mjs M1 --explain`. M1 `checks` 채움. 커밋.
2. `(사용자/메인 세션)` ruleset 필수 검사에 그 이름.
3. `gate M1 --seal` → 커밋 → PR → 머지 커밋.

【테스트】
```
TC-M1.T5.a  M1 게이트를 도는 CI 잡이 있다
  단언:  grep "^\s+run: node scripts/gate\.mjs M1\b" .github/workflows/ci.yml → 1 (G-M1.14)
  검출:  봉인 PR 에 잡을 빠뜨려 병합 뒤 guard 잡이 처음 빨개지는 것
TC-M1.T5.b  ruleset 필수 검사가 이 잡을 포함한다
  단언:  check-required-checks → 0 (G-M1.15)
  검출:  잡은 있으나 필수 검사가 아니라 빨간 채로 병합되는 것
```

【통과】
- [ ] G-M1.14 · G-M1.15 통과

## 🚪 GATE M1

| id | 검사 | 명령 | 통과 기준 |
|---|---|---|---|
| G-M1.1 ~ 3 | TC-M1.T1.a ~ c | `pnpm -C apps/server test -t "TC-M1.T1.<x>"` | 각 통과 = 1 |
| G-M1.4 | TC-M1.T1.d 동시 설정 쓰기 | [L] `pnpm -C apps/server test:db -t "TC-M1.T1.d" --db sqlite,mysql,mariadb,pg` | 통과 = 4 |
| G-M1.5 · 6 | TC-M1.T2.a · b | `pnpm -C apps/server test -t "TC-M1.T2.<x>"` | 각 통과 = 1. a 는 24칸 |
| G-M1.7 · 8 | TC-M1.T3.a · b | `pnpm -C apps/server test -t "TC-M1.T3.<x>"` | 각 통과 = 1 |
| G-M1.9 | TC-M1.T4.a 0003 다섯 DB | [L] `pnpm -C packages/db test:migrate -t "TC-M1.T4.a" --db sqlite,mysql,mariadb,pg,d1` | 통과 = 5 |
| G-M1.10 | TC-M1.T4.b 새 칼럼 입력 차단 | [L] `pnpm -C packages/auth test -t "TC-M1.T4.b"` | 통과 = 4 (DB 4) |
| G-M1.11 | TC-M1.T4.c 생성물·드리프트 | `pnpm -C packages/db gen && git diff --exit-code packages/db/src/schema/ && pnpm -C packages/db check:drift` | 종료코드 0 |
| G-M1.12 | 설정 지우고 넣기 없음 | grep `delete\(t\)\.where\(eq\(t\.key, key\)\)` in `apps/server/src/setup` | == 0 (지금 `setup/index.ts` `writeSetting`에 1) |
| G-M1.13 | 타입 검사 | `pnpm -r typecheck` | 종료코드 0 |
| G-M1.14 | TC-M1.T5.a CI 단계 잡 | grep `^\s+run: node scripts/gate\.mjs M1\b` in ci.yml | == 1 |
| G-M1.15 | ruleset · TC-M1.T5.b | `node scripts/check-required-checks.mjs --repo henryj-dev/magnetosphere` | 종료코드 0 |
| G-M1.16 | 재현 빨강 TC-M1.T1.d | `node scripts/check-red.mjs --check G-M1.4 --since seal:M0` | 종료코드 0 |

`node scripts/gate.mjs M1 --seal`

가장 중요한 검사는 G-M1.6 이다. 관리자 보호가 빠지면 관리자 API 로 설치 전체를 잠글 수 있고, `adminExists`가 상태와 관계없이 `role='admin'`을 세므로(설치 재개 방지, 일부러 그렇다) 되살릴 길이 DB 직접 수정뿐이다.

---

# M2 — 초대 🔒 (M1 필요)

**브랜치** `p3/m2`.
**outputs** `apps/server/src/invites/**`, `apps/server/test/invites/**`.

🛡 보안 리뷰 대상: 토큰 생성·저장·비교, 한 번만 쓰기 경쟁, 관리자 역할 초대, 이메일 지정 초대의 인증 처리(Q5).

### ☐ M2.T1 — 초대 만들기·목록·취소 (관리자 API) 🛡 보안 리뷰
선행 없음 · 산출 `apps/server/src/invites/admin.ts` · 되돌리기 커밋 1개

【작업】
1. `POST /api/admin/invites {email?, role, expiresInDays?}` · `GET /api/admin/invites` · `DELETE /api/admin/invites/:id`(`revoked_at`). 관리자 세션(`sessionAdmin`, 활성 관리자), `sameOrigin`(`/api/admin/*`에 이미 걸림). 토큰은 32바이트 무작위(base64url), DB 에는 SHA-256 해시만(`token_hash`), 원문은 응답에 한 번 + `Cache-Control: no-store`. 링크 `<public_base_url>/invite#<토큰>` (조각이라 서버 접근 기록에 남지 않는다). 규칙: `role = admin`이면 `email` 필수(4.2), 이메일은 소문자, 만료 기본 7일·최대 30일(Q4), 정책이 `closed`·`sso_only`면 409 `signup_closed`(Q3), 메일 없는 설치에서 이메일 없는 링크는 409 `mail_required`(Q5). 같은 이메일의 미사용·미만료 초대가 있으면 그것을 취소하고 새로 만든다. 감사 기록 `invite.create`·`invite.revoke`. 관리자 API 요청 수 제한: 관리자당 분당 30회(`consume`). 커밋.

【테스트】
```
TC-M2.T1.a  이메일 없는 관리자 초대는 만들 수 없다 (7장 회귀)
  단언:  {role:"admin"} → 400 admin_invite_requires_email, invites 0행. {role:"admin", email:"A@x.com"} → 201, email "a@x.com"
  검출:  이메일 없는 관리자 링크가 새어 받은 사람 누구나 관리자가 되는 것 (4.2 "링크가 새어도 관리자 권한이 넘어가지 않게")
TC-M2.T1.b  원문 토큰은 응답에만 있다
  단언:  201 응답 링크의 토큰 t, DB invites.token_hash == sha256(t), DB 덤프·서버 로그·audit_log 에 t 0건, Cache-Control no-store
  검출:  token_hash 칼럼에 원문을 넣거나 감사 기록 detail 에 링크를 남겨 DB 읽기 권한만으로 관리자 초대를 가로채는 것
TC-M2.T1.c  만료 기본·최대 (Q4 의존)
  단언:  expiresInDays 없음 → expires_at == now + 7일, 30 → 201, 31 · 0 · 1.5 → 400
  검출:  만료 없는 초대가 영원히 살아 몇 달 전 링크로 가입되는 것
TC-M2.T1.d  관리자만 초대를 다룬다
  단언:  세션 없음 401, 회원 403, 정지된 관리자(status suspended) 403, 다른 출처 Origin 403 forbidden_origin, 활성 관리자 201
  검출:  sessionAdmin 대신 role 만 보는 판정(setup/routes.ts requireAdmin 과 같은 꼴)을 써 정지된 관리자가 초대를 계속 만드는 것
TC-M2.T1.e  정책·메일에 따라 초대 만들기를 거부한다 (Q3·Q5 의존)
  단언:  closed · sso_only → 409 signup_closed. 메일 없음 + email 없음 → 409 mail_required, 메일 없음 + email 있음 → 201
  검출:  closed 설치에서 초대가 만들어져 "신규 가입 막음"이 초대로 새는 것
TC-M2.T1.f  취소한 초대와 같은 이메일 재초대
  단언:  DELETE → revoked_at 설정·audit invite.revoke 1행. 같은 이메일 두 번 POST → 미사용 초대 1개(앞 것 revoked_at)
  검출:  같은 이메일 초대가 여럿 살아, 관리자가 취소한 줄 아는 옛 링크로 가입되는 것
```

【통과】
- [ ] G-M2.1 ~ G-M2.6 통과

### ☐ M2.T2 — 초대 수락 `POST /api/invites/accept` 🛡 보안 리뷰 (V29 의존)
선행 M2.T1 · 산출 `apps/server/src/invites/accept.ts` · 되돌리기 커밋 1개

【작업】
1. 공개 경로(세션 없음) `POST /api/invites/accept {token, email, name, password}`. 순서: 토큰 해시로 초대를 찾고(없음·만료·취소·사용됨은 모두 같은 응답 400 `invalid_invite`), 이메일 지정 초대면 본문 이메일과 같아야 한다(다르면 같은 `invalid_invite`). 초대를 한 문장으로 차지(`UPDATE invites SET used_at = now WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now`, 1행일 때만). 그 뒤 `auth.api.signUpEmail`을 서버에서 부르고, 가입 판정 훅(M3)은 서버 호출 표시(V29 `serverCallCtx`)와 차지한 초대 id 로 이 가입을 초대 가입으로 본다. 가입이 실패하면 초대 차지를 되돌린다(`used_at = NULL`, 같은 id·같은 시각일 때만 — D1 은 대화형 트랜잭션이 없다). 회원 행: `role` = 초대 역할, `status active`(승인 건너뜀, Q6), 이메일 지정 초대면 `emailVerified true`(Q5), `monthly_limit_usd` = `default_limit_usd`(Q16), `invites.used_by`. 감사 `invite.accept`. 요청 수 제한: IP 당 10분 10회(`consume`, 토큰 대입 방지). 응답 시간은 M3.T5 의 최소 시간 규칙을 쓴다. 커밋.

【테스트】
```
TC-M2.T2.a  초대 하나는 한 번만 수락된다 (다섯 DB)
  단언:  같은 토큰으로 동시 수락 10건(이메일 지정 없음, 이메일 10개) → 201 정확히 1, 나머지 400 invalid_invite, user 증가 1 (sqlite·mysql·mariadb·pg·d1)
  검출:  "찾기 → 가입 → used_at 쓰기" 순서라 경쟁하면 이메일 없는 링크 하나로 회원이 여럿 생기는 것
TC-M2.T2.b  실패한 수락의 이유를 가르지 않는다
  단언:  없는 토큰 · 만료 · 취소 · 사용됨 · 이메일 불일치 → 상태·본문 모두 같은 400 invalid_invite
  검출:  "만료됨"·"이메일이 다름"을 따로 알려 초대 대상 이메일이나 토큰의 유효성을 바깥에서 알아내는 것
TC-M2.T2.c  이메일 지정 초대는 인증된 회원을 만든다 (Q5 의존)
  단언:  email 지정 초대 수락 → emailVerified true, 인증 메일 0통, 곧바로 POST /api/me/keys 201. 이메일 없는 링크 수락 → emailVerified false, 인증 메일 1통, 키 발급 403
  검출:  메일 없는 invite_only 설치에서 초대 회원이 emailVerified false 로 남아 K4 발급 확인에 막혀 아무도 키를 못 받는 것
TC-M2.T2.d  초대 회원의 역할·상태·한도 (Q6·Q16 의존)
  단언:  role admin 초대 → role admin·status active·monthly_limit_usd == default_limit_usd(5)·max_keys NULL. 본문에 role·status·monthlyLimitUsd 를 넣어도 같은 결과
  검출:  초대 수락이 Better Auth 기본값(status active·monthly_limit_usd NULL)으로 회원을 만들어 기본 한도 $5 가 걸리지 않고 무제한이 되는 것
TC-M2.T2.e  가입이 실패하면 초대가 다시 쓸 수 있게 돌아온다
  단언:  이미 있는 이메일로 수락 → 400 (invalid_invite 와 같은 모양), 그 초대 used_at NULL, 다른 이메일로 다시 수락 → 201
  검출:  가입 단계 실패(이메일 중복·비밀번호 규칙) 뒤 초대가 used 로 굳어 관리자가 초대를 다시 만들어야 하는 것, 반대로 되돌리기가 다른 수락의 차지를 지우는 것
TC-M2.T2.f  수락 요청 수 제한
  단언:  같은 IP 에서 10분 안에 11번째 → 429, 다른 IP 는 400 invalid_invite
  검출:  토큰 대입을 막지 않는 것 (토큰은 32바이트라 실제 대입은 어렵지만, 이 경로는 DB 조회와 가입을 부른다)
```

【통과】
- [ ] G-M2.7 ~ G-M2.13 통과

### ☐ M2.T3 — 만료한 초대 정리
선행 M2.T1 · 산출 `apps/server/src/invites/prune.ts`, `apps/server/src/jobs.ts` · 되돌리기 커밋 1개

【작업】
1. 1분 작업 큐 실행기(K6.T4 의 `pruneDone`과 같은 자리)에서 `expires_at`이 30일 지난 미사용 초대와 `revoked_at`이 30일 지난 초대를 500행씩 지운다. 사용한 초대(`used_at`)는 남긴다 (누가 누구를 초대했는지). 커밋.

【테스트】
```
TC-M2.T3.a  30일 지난 만료·취소 초대만 지운다 (네 DB)
  단언:  만료 31일 · 만료 29일 · 취소 31일 · 사용됨 90일 · 유효 → 지움 2, 남음 3
  검출:  사용한 초대까지 지워 초대한 관리자와 가입한 회원의 연결이 사라지는 것, 만료 직후 지워 관리자가 "만료됨" 목록을 못 보는 것
```

【통과】
- [ ] G-M2.14 통과

### ☐ M2.T4 — M2 CI 잡과 봉인
선행 M2.T1 ~ M2.T3 · 산출 `.github/workflows/ci.yml` · 되돌리기 커밋 1개

【작업】
1. 잡 `p3-m2`(이름 `초대 (M2 게이트, 다섯 DB)`) 스텝 `run: node scripts/gate.mjs M2 --explain`. M2 `checks` 채움. 커밋.
2. `(사용자/메인 세션)` ruleset 필수 검사에 그 이름.
3. 보안 리뷰 → 고침 TC 추가 → `gate M2 --seal` → 커밋 → PR → 머지 커밋.

【테스트】
```
TC-M2.T4.a  M2 게이트를 도는 CI 잡이 있다
  단언:  grep "^\s+run: node scripts/gate\.mjs M2\b" ci.yml → 1 (G-M2.17)
  검출:  봉인 PR 에 잡을 빠뜨리는 것
TC-M2.T4.b  ruleset 필수 검사가 이 잡을 포함한다
  단언:  check-required-checks → 0 (G-M2.18)
  검출:  빨간 채로 병합되는 것
```

【통과】
- [ ] G-M2.17 · G-M2.18 통과

## 🚪 GATE M2

| id | 검사 | 명령 | 통과 기준 |
|---|---|---|---|
| G-M2.1 ~ 6 | TC-M2.T1.a ~ f | `pnpm -C apps/server test -t "TC-M2.T1.<x>"` | 각 통과 = 1 |
| G-M2.7 | TC-M2.T2.a 동시 수락 (Node DB 넷) | [L] `pnpm -C apps/server test:db -t "TC-M2.T2.a" --db sqlite,mysql,mariadb,pg` | 통과 = 4, 201 == 1 |
| G-M2.8 | TC-M2.T2.a 동시 수락 (D1) | [L] `pnpm -C apps/server test:workers -t "TC-M2.T2.a"` | 통과 = 1, 201 == 1 |
| G-M2.9 ~ 13 | TC-M2.T2.b ~ f | `pnpm -C apps/server test -t "TC-M2.T2.<x>"` | 각 통과 = 1 |
| G-M2.14 | TC-M2.T3.a 초대 정리 | [L] `pnpm -C apps/server test:db -t "TC-M2.T3.a" --db sqlite,mysql,mariadb,pg` | 통과 = 4 |
| G-M2.15 | 초대 원문 저장 칼럼 없음 | grep `\b(invite_token\|token_raw\|raw_token)\b` in `packages/db/src/schema` | == 0 |
| G-M2.16 | 타입 검사 | `pnpm -r typecheck` | 종료코드 0 |
| G-M2.17 | TC-M2.T4.a CI 단계 잡 | grep `^\s+run: node scripts/gate\.mjs M2\b` in ci.yml | == 1 |
| G-M2.18 | ruleset · TC-M2.T4.b | `node scripts/check-required-checks.mjs --repo henryj-dev/magnetosphere` | 종료코드 0 |

`node scripts/gate.mjs M2 --seal`

가장 중요한 검사는 G-M2.8 이다. D1 은 대화형 트랜잭션이 없어 초대 차지와 가입 되돌리기가 다른 DB 와 다른 경로를 탄다. Node 쪽 시험은 그 경로를 지나지 않는다.

---

# M3 — 가입 정책 🔒 (M2 필요)

**브랜치** `p3/m3`.
**outputs** `apps/server/src/signup/**`, `apps/server/test/signup/**`, `packages/auth/test/signup-policy/**`. 고칠 기존 파일(`packages/auth/src/index.ts`, `apps/server/src/app.ts`, `apps/server/src/config.ts`, `packages/auth/test/mail-timing.test.ts`)은 `outputs`에 없다.

🛡 보안 리뷰 대상: 가입 판정이 모든 user 생성 경로를 덮는지, 정책을 바꾸는 순간의 경쟁, 응답 시간으로 드러나는 계정 존재.

### ☐ M3.T1 — 가입 정책 판정과 Better Auth 훅 🛡 보안 리뷰 (V29·Q1·Q3·Q15 의존)
선행 없음 · 산출 `apps/server/src/signup/policy.ts`, `packages/auth/src/index.ts`, `apps/server/src/config.ts`, `apps/server/src/app.ts` · 되돌리기 커밋 2개 · 장치 요구 `Red: TC-M3.T1.a`

【작업】
1. 재현 시험: 설치 뒤 `signup_mode invite_only`에서 공개 `/api/auth/sign-up/email` → 지금 200. 꼬리줄 `Red: TC-M3.T1.a`. 커밋. (Q1 (가)로 미리 막았으면 재현 대상은 `open`·`domain_allowlist`·`closed` 표 전체다.)
2. `decideSignup({ settings, mailConfigured, email, via: "public" | "invite", inviteId? })` → `{ ok, status, approval, code }` 순수 함수. 공개 가입: `open`(메일 필요) · `domain_allowlist`(메일·도메인 일치 필요) 만 통과, `invite_only`·`closed`·`sso_only` → 403 `signup_closed`. 초대 가입: `invite_only`·`open`·`domain_allowlist` 통과, `closed`·`sso_only` 거부(Q3). `createAuth` 옵션에 `databaseHooks.user.create.before`를 더해 이 함수를 부른다 (판정에 필요한 설정은 앱이 넘기는 콜백으로, `packages/auth`가 서버 코드에 기대지 않게). 거부는 V29 의 `APIError` 모양. V32 에서 열려 있던 이메일 변경·회원 삭제 경로를 `disabledPaths`에 더한다. 설치 전 403 `setup_required`(app.ts)는 그대로 앞에 둔다. 커밋.

【테스트】
```
TC-M3.T1.a  정책 다섯 × 경로 둘 표 (Q3 의존)
  단언:  공개 가입: open 201·domain_allowlist(도메인 안) 201·invite_only 403·closed 403·sso_only 403. 초대 가입: invite_only·open·domain_allowlist 201, closed·sso_only 400 invalid_invite 와 다른 403 signup_closed. 거부마다 user·account·verification 0행, 메일 0통
  검출:  signup_mode 를 아무도 읽지 않아 설치 직후 invite_only 인데도 누구나 /api/auth/sign-up/email 로 가입하는 것 (지금 main 의 동작)
TC-M3.T1.b  user 를 만드는 모든 Better Auth 경로가 판정을 지난다 (V29·V32 의존)
  단언:  auth.api 경로 목록에서 user 를 만드는 경로(/sign-up/email, sso 콜백 등) 각각을 closed 에서 부름 → 새 user 0. 목록에 새 경로가 생기면 이 TC 가 실패하도록 경로 목록을 고정 값과 비교
  검출:  /sign-up/email 의 hooks.before 에서만 막아, 같은 user 생성을 하는 다른 경로(나중에 켜지는 플러그인 포함)가 정책을 비켜 가는 것
TC-M3.T1.c  메일이 없으면 open·domain_allowlist 자기 가입을 거부한다 (Q15 의존)
  단언:  signup_mode open 을 저장한 뒤 mail_settings 행을 DB 에서 지움 → 공개 가입 403 mail_required, 0행
  검출:  정책 저장 때만 메일을 보고 가입 때 다시 보지 않아, 메일이 사라진 설치에서 인증 메일 없이 open 가입이 계속되는 것
TC-M3.T1.d  이메일 변경·회원 삭제 경로가 닫혀 있다 (V32·Q14 의존)
  단언:  V32 answer 에서 막을 경로로 표시된 것 각각 → 404, 회원 이메일 그대로
  검출:  허용 도메인으로 가입한 뒤 /change-email 로 바깥 도메인으로 옮기는 것
```

【통과】
- [ ] G-M3.1 ~ G-M3.4 통과
- [ ] G-M3.17 통과 (Red 커밋에서 TC-M3.T1.a 실패)

### ☐ M3.T2 — 허용 도메인·승인 대기·기본값 (Q6·Q14·Q16 의존)
선행 M3.T1 · 산출 `apps/server/src/signup/policy.ts`, `apps/server/src/signup/defaults.ts` · 되돌리기 커밋 1개

【작업】
1. 도메인 일치: 이메일 `@` 뒤를 소문자·punycode 로 바꿔 `allowed_domains`와 정확히 비교 (Q14). 공개 가입의 회원 행: `signup_requires_approval`이면 `status pending`, 아니면 `active` (Q6). 모든 새 회원(공개·초대)에 `monthly_limit_usd = default_limit_usd` (Q16). 이 값들은 `user.create.before`가 돌려주는 데이터로 넣는다 (같은 트랜잭션, `input: false` 칼럼이라 본문으로는 못 바꾼다). 감사 `member.signup`. 커밋.

【테스트】
```
TC-M3.T2.a  승인 대기 (Q6 의존)
  단언:  open + 승인 켬 → status pending·키 발급 403 member_inactive. 승인 끔 → active. domain_allowlist + 승인 켬 → pending. 초대 수락 → active
  검출:  user.status 기본값 active 그대로 가입시켜 open 설치에서 승인 없이 누구나 키를 받는 것 (4.2 "가입 직후 상태는 기본 pending")
TC-M3.T2.b  허용 도메인은 정확히 일치한다 (Q14 의존)
  단언:  허용 ["example.com"] → a@example.com 201, a@EXAMPLE.com 201, a@sub.example.com 403, a@example.com.evil.io 403, a@xn--bcher-kva.example 은 punycode 로 허용 목록과 비교
  검출:  endsWith("example.com") 으로 비교해 a@notexample.com·example.com.evil.io 가 통과하는 것
TC-M3.T2.c  새 회원에게 기본 월 한도가 걸린다 (Q16 의존)
  단언:  default_limit_usd 5 → 새 회원 monthly_limit_usd 5, max_keys NULL. 설정을 7 로 바꾼 뒤 → 기존 회원 5 그대로, 새 회원 7. default_limit_usd null → 새 회원 NULL(무제한)
  검출:  default_limit_usd 를 읽는 코드가 없어(지금 main) 새 회원이 monthly_limit_usd NULL = 무제한으로 운영자 비용을 쓰는 것
```

【통과】
- [ ] G-M3.5 ~ G-M3.7 통과

### ☐ M3.T3 — 하루 가입 상한 (Q13 의존)
선행 M3.T1 · 산출 `apps/server/src/signup/cap.ts` · 되돌리기 커밋 1개

【작업】
1. 공개 가입이 판정을 통과하면 `consume(h, "signup-day|<UTC 날짜>", daily_signup_cap, 하루)`로 한 칸을 쓴다 (`routes/guard.ts`의 고정 창 세기, D1 안전, 여러 인스턴스 공유). 넘으면 403 `signup_cap`, 그날 처음 넘을 때 `alert.signup_cap` 1행(`keys/alerts.ts` `alertOnce`와 같은 하루 한 번). 초대 수락은 세지 않는다. 가입이 이후 단계에서 실패하면(이메일 중복 등) 칸을 되돌리지 않는다 — 실패 가입도 남용 시도라 센다. 커밋.

【테스트】
```
TC-M3.T3.a  상한을 넘으면 그날 남은 공개 가입을 막는다 (Q13 의존, 네 DB)
  단언:  상한 3, 인스턴스 둘이 같은 DB 로 동시 공개 가입 10건 → 201 정확히 3, 나머지 403 signup_cap, alert.signup_cap 1행. UTC 날이 바뀌면(가짜 시계) 다시 201. 초대 수락은 상한 뒤에도 201 (sqlite·mysql·mariadb·pg)
  검출:  인스턴스 메모리나 "세기 → 가입" 두 단계로 세어 동시 가입이 상한을 넘는 것, 알림이 가입 시도마다 쌓이는 것
TC-M3.T3.b  상한 null 과 0 (Q13 의존)
  단언:  null → 100건 모두 201, 0 → 첫 공개 가입부터 403 signup_cap
  검출:  0 을 "상한 없음"으로 읽어 운영자가 자기 가입을 잠그려 한 설정이 거꾸로 동작하는 것
TC-M3.T3.c  D1 에서도 상한을 넘지 않는다
  단언:  workers-d1, 상한 3, 동시 10건 → 201 정확히 3
  검출:  D1 경로의 consume 이 조건부 UPDATE 없이 세어 Workers 조합에서만 상한이 새는 것
```

【통과】
- [ ] G-M3.8 ~ G-M3.10 통과

### ☐ M3.T4 — 정책을 바꾸는 API
선행 M3.T1 · 산출 `apps/server/src/signup/admin.ts` · 되돌리기 커밋 1개

【작업】
1. `GET /api/admin/settings/signup` · `PATCH /api/admin/settings/signup {signupMode?, allowedDomains?, signupRequiresApproval?, dailySignupCap?, defaultLimitUsd?, defaultMaxKeys?}`. 활성 관리자, `sameOrigin`, M1.T1 검사, 감사 `settings.update`(detail 은 바뀐 키 이름과 앞뒤 값, 도메인 목록은 개수만). 응답에 `mailConfigured`. 커밋.

【테스트】
```
TC-M3.T4.a  관리자만 정책을 바꾸고, 바꾸면 다음 가입부터 적용된다
  단언:  회원 403, 정지된 관리자 403, 활성 관리자 PATCH closed → 200·audit settings.update 1행 → 바로 다음 공개 가입 403 signup_closed (다른 인스턴스에서도)
  검출:  설정을 인스턴스 메모리에 캐시해 정책을 닫아도 다른 인스턴스가 한동안 가입을 받는 것
TC-M3.T4.b  메일 없는 설치에서 open 으로 못 바꾼다 (Q15 의존)
  단언:  mail_settings 없음 → PATCH open 409 mail_required, signup_mode 그대로
  검출:  API 가 M1.T1 정책 검사를 건너뛰고 값만 검사해 저장하는 것
```

【통과】
- [ ] G-M3.11 · G-M3.12 통과

### ☐ M3.T5 — 가입 응답 시간으로 계정 존재를 드러내지 않는다 (백로그 둘)
선행 M3.T1 · 산출 `apps/server/src/signup/timing.ts`, `packages/auth/test/mail-timing.test.ts`, `packages/auth/test/signup-policy/**` · 되돌리기 커밋 2개 · 장치 요구 `Red: TC-M3.T5.a`

【작업】
1. 재현 시험: 있는 이메일·없는 이메일로 공개 가입 7번씩, 메일 지연 없이 응답 시간 중앙값 차이 < 30ms 를 단언 (지금 CI 108ms 차이로 실패). 꼬리줄 `Red: TC-M3.T5.a`. 커밋.
2. `/sign-up/email`과 `/api/invites/accept`의 응답을 시작 시각 + `SIGNUP_MIN_MS`(400ms)까지 기다린 뒤 돌려준다 (Node `setTimeout`, Workers 도 같은 방식 — 요청 안에서 기다림). 400ms 는 CI 러너의 가입 DB 쓰기(약 110ms) + 비밀번호 해시 + 여유. 거부 응답(정책·상한)도 같은 최소 시간을 쓴다. TC-S3.T2.e 의 상한을 250ms → 150ms 로 낮춘다 (S7 리뷰 L1). 커밋.

【테스트】
```
TC-M3.T5.a  가입 응답 시간이 있는 계정·없는 계정에서 같다
  단언:  open 정책, 있는 이메일·없는 이메일 공개 가입 각 7번, 중앙값 차이 < 30ms, 모든 응답 ≥ 400ms. 초대 수락도 같은 조건 (CI 러너에서 세 번 돌려 흩어짐을 PR 본문에 남김)
  검출:  새 가입의 DB 쓰기만큼(CI 108ms) 응답이 늦어 요청 몇 번으로 그 이메일의 가입 여부를 알아내는 것 (S7 에서 찾은 노출)
TC-M3.T5.b  메일 지연이 응답 시간에 더하는 몫 < 150ms (TC-S3.T2.e 개정)
  단언:  TC-S3.T2.e 와 같은 측정, 상한 150ms
  검출:  메일 전송을 다시 응답에 묶어도 250ms 상한 아래라 놓치는 것
TC-M3.T5.c  최소 시간 기다림이 요청 수 제한을 우회하지 않는다
  단언:  같은 IP 6번째 공개 가입 → 429 (rate-limit.ts /sign-up/* 5/60s), 429 응답도 ≥ 400ms
  검출:  기다림을 rate limit 뒤에 두어 429 만 빨리 돌아와 "제한에 걸렸다"가 응답 시간으로 드러나고, 기다림 중 동시 요청이 쌓이는 것
```

【통과】
- [ ] G-M3.13 ~ G-M3.15 통과
- [ ] G-M3.18 통과 (Red 커밋에서 TC-M3.T5.a 실패)

### ☐ M3.T6 — M3 CI 잡과 봉인
선행 M3.T1 ~ M3.T5 · 산출 `.github/workflows/ci.yml` · 되돌리기 커밋 1개

【작업】
1. 잡 `p3-m3`(이름 `가입 정책 (M3 게이트, 다섯 DB·mailpit)`) 스텝 `run: node scripts/gate.mjs M3 --explain`. M3 `checks` 채움. 커밋.
2. `(사용자/메인 세션)` ruleset 필수 검사에 그 이름.
3. 보안 리뷰 → 고침 TC 추가 → `gate M3 --seal` → 커밋 → PR → 머지 커밋.

【테스트】
```
TC-M3.T6.a  M3 게이트를 도는 CI 잡이 있다
  단언:  grep "^\s+run: node scripts/gate\.mjs M3\b" ci.yml → 1 (G-M3.19)
  검출:  봉인 PR 에 잡을 빠뜨리는 것
TC-M3.T6.b  ruleset 필수 검사가 이 잡을 포함한다
  단언:  check-required-checks → 0 (G-M3.20)
  검출:  빨간 채로 병합되는 것
```

【통과】
- [ ] G-M3.19 · G-M3.20 통과

## 🚪 GATE M3

| id | 검사 | 명령 | 통과 기준 |
|---|---|---|---|
| G-M3.1 | TC-M3.T1.a 정책 표 (네 DB) | [L] `pnpm -C apps/server test:db -t "TC-M3.T1.a" --db sqlite,mysql,mariadb,pg` | 통과 = 4 |
| G-M3.2 | TC-M3.T1.b user 생성 경로 전부 | [L] `pnpm -C packages/auth test -t "TC-M3.T1.b"` | 통과 = 4 |
| G-M3.3 · 4 | TC-M3.T1.c · d | `pnpm -C apps/server test -t "TC-M3.T1.<x>"` | 각 통과 = 1 |
| G-M3.5 ~ 7 | TC-M3.T2.a ~ c | `pnpm -C apps/server test -t "TC-M3.T2.<x>"` | 각 통과 = 1 |
| G-M3.8 | TC-M3.T3.a 상한 동시 (네 DB) | [L] `pnpm -C apps/server test:db -t "TC-M3.T3.a" --db sqlite,mysql,mariadb,pg` | 통과 = 4, 201 == 3 |
| G-M3.9 | TC-M3.T3.b null·0 | `pnpm -C apps/server test -t "TC-M3.T3.b"` | 통과 = 1 |
| G-M3.10 | TC-M3.T3.c 상한 D1 | [L] `pnpm -C apps/server test:workers -t "TC-M3.T3.c"` | 통과 = 1 |
| G-M3.11 · 12 | TC-M3.T4.a · b | `pnpm -C apps/server test -t "TC-M3.T4.<x>"` | 각 통과 = 1 |
| G-M3.13 | TC-M3.T5.a 가입 응답 시간 | [L] `pnpm -C packages/auth test -t "TC-M3.T5.a"` | 통과 = 1, 차이 < 30ms |
| G-M3.14 | TC-M3.T5.b 메일 몫 150ms | [L] `pnpm -C packages/auth test -t "TC-S3.T2.e"` | 통과 = 1 |
| G-M3.15 | TC-M3.T5.c | `pnpm -C apps/server test -t "TC-M3.T5.c"` | 통과 = 1 |
| G-M3.16 | 메일 몫 상한 상수 | grep `LIMIT_MS = 150` in `packages/auth/test/mail-timing.test.ts` | == 1 |
| G-M3.17 | 재현 빨강 TC-M3.T1.a | `node scripts/check-red.mjs --check G-M3.1 --since seal:M2` | 종료코드 0 |
| G-M3.18 | 재현 빨강 TC-M3.T5.a | `node scripts/check-red.mjs --check G-M3.13 --since seal:M2` | 종료코드 0 |
| G-M3.19 | TC-M3.T6.a CI 단계 잡 | grep `^\s+run: node scripts/gate\.mjs M3\b` in ci.yml | == 1 |
| G-M3.20 | ruleset · TC-M3.T6.b | `node scripts/check-required-checks.mjs --repo henryj-dev/magnetosphere` | 종료코드 0 |
| G-M3.21 | 타입 검사 | `pnpm -r typecheck` | 종료코드 0 |

`node scripts/gate.mjs M3 --seal`

가장 중요한 검사는 G-M3.2 다. 정책 판정을 공개 가입 경로 하나에만 걸면 오늘의 시험은 모두 초록이다. 5단계가 SSO 를 켜는 순간 user 를 만드는 새 경로가 생기고, 그 경로가 판정을 지나는지는 경로 목록을 고정해 비교하는 이 검사만 알린다.

---

# M4 — 회원 관리 API 와 세션 무효화 🔒 (M3 필요)

**브랜치** `p3/m4`.
**outputs** `apps/server/src/admin/**`, `apps/server/test/admin/**`, `apps/server/src/sessions/**`, `apps/server/test/sessions/**`. 고칠 기존 파일(`setup/routes.ts`, `app.ts`, `routes/guard.ts`, `packages/auth/src/index.ts`)은 `outputs`에 없다.

🛡 보안 리뷰 대상: 권한 상승(역할 변경·관리자 보호), 정지 뒤 남는 접근(세션·키·설치 API), 삭제 때 개인정보 처리.

### ☐ M4.T1 — 회원 목록·승인·거절·정지·해제·역할 🛡 보안 리뷰 (Q8·Q11·Q12 의존)
선행 없음 · 산출 `apps/server/src/admin/members.ts` · 되돌리기 커밋 1개

【작업】
1. `GET /api/admin/users?status=&cursor=`(50개씩, 이메일·이름·역할·상태·한도·키 수) · `POST /api/admin/users/:id/{approve,reject,suspend,unsuspend}` · `PATCH /api/admin/users/:id/role {role}`. 기존 `PATCH /api/admin/users/:id`(한도, K4)는 그대로. 모두 활성 관리자, `sameOrigin`, 관리자당 분당 30회. M1.T2 `transition`으로 판정, 상태 쓰기는 "지금 상태가 판정 때와 같을 때만" 한 문장 조건부 UPDATE (동시 요청). 정지·해제는 쓰기 뒤 그 회원 모든 키에 K3 `applyKey`(즉시 반영, 실패하면 큐 — 5.7 "정지는 반영이 끝나야 완료"이므로 응답에 `sync: "pending" | "synced"`). 정지·역할 변경·삭제는 M4.T3 세션 무효화를 부른다. 거절은 `pending` 회원 행과 `account`·`verification` 행을 지운다 (Q8). 감사 `member.*`. 커밋.

【테스트】
```
TC-M4.T1.a  정지하면 키가 곧바로 꺼지고, 해제하면 user_status 키만 다시 켜진다
  단언:  키 둘(하나는 회원이 끔) → suspend → 응답 전 setKeyActive(false) 1건(켜진 키만), 두 키 disabled_reason 은 각각 user_status·member, 응답 sync "synced" → unsuspend → setBudget 뒤 setKeyActive(true) 1건 (user_status 키만)
  검출:  정지가 user.status 만 바꾸고 5분 정합성 점검을 기다려, 정지한 회원의 키가 최대 5분 동안 OmniRoute 에서 계속 통과하는 것
TC-M4.T1.b  허용하지 않는 전이는 409 이고 아무것도 바뀌지 않는다 (Q8 의존)
  단언:  active 회원 approve → 409 invalid_transition, deleted 회원 unsuspend → 409, pending reject → user·account 0행·audit member.reject 1행
  검출:  상태를 검사 없이 덮어써 삭제(개인정보 지움)한 회원을 정지 해제로 active 로 되살리는 것
TC-M4.T1.c  같은 회원에게 동시에 다른 동작 (네 DB)
  단언:  pending 회원에 approve 와 reject 동시 → 하나만 200, 다른 하나 409, 최종 상태와 audit 1행이 서로 맞음 (sqlite·mysql·mariadb·pg)
  검출:  읽기 → 쓰기 두 단계라 거절로 지운 회원 행에 승인이 active 를 다시 쓰거나(행 0 갱신을 성공으로 봄) 감사 기록이 둘 다 남는 것
TC-M4.T1.d  관리자 보호 (Q12 의존)
  단언:  최초 관리자 suspend·role member → 409 bootstrap_admin, 마지막 활성 관리자 role member → 409 last_admin, 자기 자신 suspend → 409 self. 관리자 둘 중 하나를 다른 관리자가 suspend → 200
  검출:  관리자 둘이 서로를 동시에 강등해 활성 관리자 0명이 되는 것 (last_admin 판정을 조건부 UPDATE 안에서 하지 않으면 생긴다)
TC-M4.T1.e  역할 값과 권한 (Q11 의존)
  단언:  role "owner" · "ADMIN" → 400, 회원 세션으로 모든 /api/admin/users* → 403, 정지된 관리자 → 403, 다른 출처 → 403 forbidden_origin
  검출:  역할 문자열을 검사 없이 저장해 "Admin" 같은 값이 sessionAdmin(role === "admin")을 지나지 못하고 관리자가 갇히는 것
TC-M4.T1.f  목록은 비밀 값을 주지 않는다
  단언:  GET /api/admin/users → 항목 키 집합 == 허용 목록 (password·token·account·session 필드 없음), 51번째 회원은 다음 cursor 로
  검출:  user 행을 그대로 직렬화해 나중에 더한 칼럼(예: 2차의 비밀 값)이 관리자 화면 응답으로 새는 것
```

【통과】
- [ ] G-M4.1 ~ G-M4.6 통과

### ☐ M4.T2 — 회원 삭제 (관리자) 🛡 보안 리뷰 (Q9 의존)
선행 M4.T1 · 산출 `apps/server/src/admin/delete.ts` · 되돌리기 커밋 1개

【작업】
1. `DELETE /api/admin/users/:id`. `transition(delete)`. 한 번에(트랜잭션, D1 은 batch): `status deleted`, `deleted_at`, 이메일 `deleted-<id>@invalid`, 이름 빈 값, `account`·`session`·`verification`(그 이메일) 행 삭제, 감사 `member.delete`(detail 에 이메일 없음). 그 뒤 모든 키 `applyKey` (K3: 키 `deleted` → 끄기 → 끈 뒤 2분 `key.delete`). `api_keys` 행·`usage_daily`·OmniRoute 기록은 남긴다. 커밋.

【테스트】
```
TC-M4.T2.a  삭제하면 로그인·세션·키가 모두 끊긴다
  단언:  세션 둘·키 둘 회원 삭제 → 옛 쿠키 첫 요청 401, 옛 비밀번호 로그인 401, 키 둘 setKeyActive(false)·key.delete next_run_at == 끈 시각 + 120,000ms, api_keys 행 state deleted 로 남음
  검출:  user.status 만 deleted 로 바꿔 account 행의 비밀번호로 계속 로그인하고 세션도 사는 것
TC-M4.T2.b  개인정보가 남지 않는다 (Q9 의존)
  단언:  삭제 뒤 user.email == "deleted-<id>@invalid", name == "", verification 에 옛 이메일 0, audit_log 전체에 옛 이메일 0, 같은 이메일로 초대 수락 → 201 (새 id)
  검출:  이메일을 그대로 둬 같은 사람이 다시 가입하지 못하거나, 감사 기록 detail 에 옛 이메일이 남는 것
TC-M4.T2.c  삭제한 회원의 사용액은 남는다
  단언:  삭제 전 키 사용액 0.01 → 삭제 → 1분 분배 대상에서 빠짐(활성 회원만), 관리자 전체 현황용 매핑(api_keys) 에 그 키 id 남음, usage_daily 행 수 그대로
  검출:  api_keys 행을 지워 4단계 전체 현황에서 그 비용이 "알 수 없는 키"로 빠지는 것
```

【통과】
- [ ] G-M4.7 ~ G-M4.9 통과

### ☐ M4.T3 — 세션 무효화와 로그인 차단 🛡 보안 리뷰 (V30·V31·Q7 의존)
선행 M4.T1 · 산출 `apps/server/src/sessions/**`, `packages/auth/src/index.ts` · 되돌리기 커밋 2개 · 장치 요구 `Red: TC-M4.T3.a`

【작업】
1. 재현 시험: 회원을 DB 에서 suspended 로 바꿔도(지금 정지 API 가 없다) 옛 세션으로 `/api/me/keys` GET 이 200 이고 비밀번호 로그인이 된다. 꼬리줄 `Red: TC-M4.T3.a`. 커밋.
2. `revokeSessions(h, userId, { except? })`: `session` 행 한 문장 삭제 (V30: 바로 끊김). 역할 변경·정지·삭제 때 모두, 비밀번호 변경 때는 현재 세션을 뺀 나머지 (`/change-password` 뒤 `hooks.after`에서, 클라이언트 `revokeOtherSessions`와 관계없이 — V30 b). `databaseHooks.session.create.before`: 회원 `status`가 `pending`이면 403 `account_pending`, `suspended`면 `account_suspended`, `deleted`면 로그인 실패와 같은 응답 (Q7, V31). 커밋.

【테스트】
```
TC-M4.T3.a  정지된 회원의 옛 세션과 새 로그인이 막힌다 (V30·V31·Q7 의존)
  단언:  세션 둘 회원 suspend → 두 쿠키 모두 첫 요청부터 401, 맞는 비밀번호 로그인 → 403 account_suspended·session 0행. unsuspend → 로그인 200
  검출:  user.status 만 바꾸고 세션을 지우지 않아 정지한 회원이 남은 세션으로 /api/me/keys/:id/enable 을 계속 부르는 것 (keys.ts 는 deleted 만 막고 suspended 의 enable 은 active 확인에서 403 이지만 GET·PATCH label 은 통과)
TC-M4.T3.b  역할 변경은 그 회원 세션을 모두 끊는다
  단언:  관리자 세션 둘 → 다른 관리자가 role member → 두 쿠키 401, 다시 로그인 → GET /api/admin/users 403
  검출:  강등한 관리자의 열린 세션이 세션 만료(기본 7일) 동안 관리자 API 를 계속 쓰는 것 — sessionAdmin 은 DB 를 다시 읽지만 다른 관리자 판정(setup)은 그렇지 않다
TC-M4.T3.c  pending 회원은 로그인하지 못한다 (Q7 의존)
  단언:  open + 승인 켬 가입 → 이메일 인증 링크 → 세션 0행(V31 verifyCreatesSession 이면 훅이 거부) → 로그인 403 account_pending → approve → 로그인 200
  검출:  이메일 인증 링크의 자동 로그인(autoSignInAfterVerification)으로 승인 전 회원이 세션을 얻는 것
TC-M4.T3.d  비밀번호를 바꾸면 다른 세션이 끊긴다 (V30 의존)
  단언:  세션 셋 → 하나에서 /change-password (revokeOtherSessions 없이) → 그 세션 200, 나머지 둘 401
  검출:  Better Auth 기본(다른 세션 유지, V30)에 맡겨 비밀번호를 바꿔도 훔친 세션이 사는 것 (4.5 "비밀번호 변경 (현재 세션 제외)")
TC-M4.T3.e  거부 응답이 계정 존재를 더 드러내지 않는다 (Q7 의존)
  단언:  없는 이메일·틀린 비밀번호·삭제된 회원 → 같은 상태·본문. account_pending·account_suspended 는 맞는 비밀번호일 때만
  검출:  상태별 코드를 비밀번호 확인 전에 내 이메일만으로 정지·대기 여부를 알아내는 것
```

【통과】
- [ ] G-M4.10 ~ G-M4.14 통과
- [ ] G-M4.22 통과 (Red 커밋에서 TC-M4.T3.a 실패)

### ☐ M4.T4 — 자기 탈퇴 `DELETE /api/me` (Q10 의존)
선행 M4.T2 · 산출 `apps/server/src/admin/self-delete.ts` · 되돌리기 커밋 1개

【작업】
1. `DELETE /api/me {password}`: 회원 세션, `sameOrigin`, 비밀번호 재확인(틀리면 403, 분당 5회), 최초 관리자·마지막 활성 관리자는 409. 나머지는 M4.T2 와 같은 삭제. 커밋.

【테스트】
```
TC-M4.T4.a  비밀번호를 다시 확인하고 탈퇴한다 (Q10 의존)
  단언:  틀린 비밀번호 → 403·변화 0, 맞음 → 200·M4.T2 와 같은 결과, 최초 관리자 → 409 bootstrap_admin, 다른 출처 → 403
  검출:  세션만으로 탈퇴를 받아 훔친 세션 하나로 회원 계정과 키를 지우는 것
```

【통과】
- [ ] G-M4.15 통과

### ☐ M4.T5 — 설치 API 의 관리자 판정과 CSRF 🛡 보안 리뷰
선행 M4.T1 · 산출 `apps/server/src/setup/routes.ts`, `apps/server/src/app.ts` · 되돌리기 커밋 2개 · 장치 요구 `Red: TC-M4.T5.a`

【작업】
1. 재현 시험: 정지된 관리자 세션으로 `PUT /api/setup/omniroute` → 지금 200 (`requireAdmin`이 role 만 본다). 다른 출처 `POST /api/setup` → 지금 sameOrigin 검사 없음. 꼬리줄 `Red: TC-M4.T5.a`. 커밋.
2. `requireAdmin`을 `sessionAdmin`(활성 관리자)으로 바꾸고 `/api/setup/*` 변경 요청에 `sameOrigin`을 건다. `adminExists`(설치가 이미 됐는가)는 상태와 관계없이 그대로 둔다 — 관리자를 정지해도 설치가 다시 열리면 안 된다. 커밋.
3. 정지 직후 첫 요청이 두 아키텍처에서 모두 거부되는지 계약 시험으로 본다 (2단계 「막혔을 때」 amd64·arm64 메모). 커밋.

【테스트】
```
TC-M4.T5.a  정지된 관리자는 설치 API 를 쓰지 못한다
  단언:  suspended 관리자 쿠키(세션 행을 남긴 시험) → GET·PUT /api/setup/omniroute 403. 다른 출처 Origin → POST /api/setup·PUT /api/setup/omniroute 403 forbidden_origin
  검출:  setup/routes.ts requireAdmin 이 role 만 봐서 정지된 관리자가 OmniRoute 관리 토큰을 자기 것으로 바꾸는 것
TC-M4.T5.b  관리자를 모두 정지해도 설치가 다시 열리지 않는다
  단언:  최초 관리자 외 관리자 정지·최초 관리자는 DB 에서 직접 suspended(보호 우회 시험) → GET /api/setup → needed false, POST /api/setup 409
  검출:  adminExists 를 활성 관리자로 바꿔, 관리자를 정지하는 것만으로 설치 토큰을 가진 사람이 새 관리자를 만드는 것
TC-M4.T5.c  정지 직후 첫 요청이 거부된다 (계약, 로컬 arm64·CI amd64)
  단언:  계약 환경, 회원 키로 /v1/messages 200 → POST /api/admin/users/:id/suspend → 다음 요청 403 (isBudgetBlocked 아님, permission_denied)
  검출:  정지 반영이 큐로만 가거나 아키텍처마다 거부 순서가 달라 정지한 회원의 요청이 한 번 더 통과하는 것
```

【통과】
- [ ] G-M4.16 ~ G-M4.18 통과
- [ ] G-M4.23 통과 (Red 커밋에서 TC-M4.T5.a 실패)

### ☐ M4.T6 — M4 CI 잡과 봉인
선행 M4.T1 ~ M4.T5 · 산출 `.github/workflows/ci.yml` · 되돌리기 커밋 1개

【작업】
1. 잡 `p3-m4`(이름 `회원 관리 (M4 게이트, 다섯 DB·OmniRoute 3.8.51)`) 스텝 `run: node scripts/gate.mjs M4 --explain`. M4 `checks` 채움. 커밋.
2. `(사용자/메인 세션)` ruleset 필수 검사에 그 이름.
3. 보안 리뷰 → 고침 TC 추가 → `gate M4 --seal` → 커밋 → PR → 머지 커밋.

【테스트】
```
TC-M4.T6.a  M4 게이트를 도는 CI 잡이 있다
  단언:  grep "^\s+run: node scripts/gate\.mjs M4\b" ci.yml → 1 (G-M4.20)
  검출:  봉인 PR 에 잡을 빠뜨리는 것
TC-M4.T6.b  ruleset 필수 검사가 이 잡을 포함한다
  단언:  check-required-checks → 0 (G-M4.21)
  검출:  빨간 채로 병합되는 것
```

【통과】
- [ ] G-M4.20 · G-M4.21 통과

## 🚪 GATE M4

| id | 검사 | 명령 | 통과 기준 |
|---|---|---|---|
| G-M4.1 · 2 | TC-M4.T1.a · b | `pnpm -C apps/server test -t "TC-M4.T1.<x>"` | 각 통과 = 1 |
| G-M4.3 | TC-M4.T1.c 동시 동작 (네 DB) | [L] `pnpm -C apps/server test:db -t "TC-M4.T1.c" --db sqlite,mysql,mariadb,pg` | 통과 = 4 |
| G-M4.4 | TC-M4.T1.d 관리자 보호 (네 DB, 동시 강등 포함) | [L] `pnpm -C apps/server test:db -t "TC-M4.T1.d" --db sqlite,mysql,mariadb,pg` | 통과 = 4 |
| G-M4.5 · 6 | TC-M4.T1.e · f | `pnpm -C apps/server test -t "TC-M4.T1.<x>"` | 각 통과 = 1 |
| G-M4.7 ~ 9 | TC-M4.T2.a ~ c | `pnpm -C apps/server test -t "TC-M4.T2.<x>"` | 각 통과 = 1 |
| G-M4.10 ~ 14 | TC-M4.T3.a ~ e | [L] `pnpm -C packages/auth test -t "TC-M4.T3.<x>"` | 각 통과 = 4 (DB 4) |
| G-M4.15 | TC-M4.T4.a 자기 탈퇴 | `pnpm -C apps/server test -t "TC-M4.T4.a"` | 통과 = 1 |
| G-M4.16 · 17 | TC-M4.T5.a · b | `pnpm -C apps/server test -t "TC-M4.T5.<x>"` | 각 통과 = 1 |
| G-M4.18 | TC-M4.T5.c 정지 직후 거부 (계약) | [L] `pnpm test:contract -t "TC-M4.T5.c"` | 통과 = 1 |
| G-M4.19 | 설치 판정이 role 만 보지 않음 | grep `role !== "admin"\|role === "admin"` in `apps/server/src/setup` | == 0 |
| G-M4.20 | TC-M4.T6.a CI 단계 잡 | grep `^\s+run: node scripts/gate\.mjs M4\b` in ci.yml | == 1 |
| G-M4.21 | ruleset · TC-M4.T6.b | `node scripts/check-required-checks.mjs --repo henryj-dev/magnetosphere` | 종료코드 0 |
| G-M4.22 | 재현 빨강 TC-M4.T3.a | `node scripts/check-red.mjs --check G-M4.10 --since seal:M3` | 종료코드 0 |
| G-M4.23 | 재현 빨강 TC-M4.T5.a | `node scripts/check-red.mjs --check G-M4.16 --since seal:M3` | 종료코드 0 |
| G-M4.24 | 어댑터 밖 관리 호출 0 | G-K4.23 과 같음 | == 0 |
| G-M4.25 | 타입 검사 | `pnpm -r typecheck` | 종료코드 0 |

`node scripts/gate.mjs M4 --seal`

가장 중요한 검사는 G-M4.10 이다. 정지의 효과는 세 곳(세션·로그인·OmniRoute 키)에 걸리고, 키 쪽은 2단계 시험이 이미 본다. 세션이 살아 있으면 회원 앱의 다른 모든 검사가 맞아도 정지한 회원이 회원 앱 API 를 계속 쓴다.

---

# M5 — 3단계 완료 기준 E2E 🔒 (M4 필요)

**브랜치** `p3/m5`.
**outputs** `tests/e2e/members/**`. `tests/e2e/run.mjs`(1단계 S6)는 공용이라 넣지 않는다.

### ☐ M5.T1 — 여섯 조합 정책 시나리오
선행 없음 · 산출 `tests/e2e/members/**`, `tests/e2e/run.mjs`(`--scenario members` 인자만) · 되돌리기 커밋 1개

【작업】
1. `pnpm e2e --combo <조합> --scenario members`: 1단계 흐름(설치·관리자) 뒤 아래 시나리오를 차례로. 회원은 DB 에 직접 넣지 않고 초대·가입 API 로만 만든다. `open`·`domain_allowlist` 시나리오의 메일은 가짜 Resend 수신기(시나리오가 띄우는 작은 HTTP 서버, `mail_settings`의 Resend 주소를 그쪽으로) — 인증 링크를 받아 연다. 조합마다 끝나면 내린다 (메모리 4GB). 커밋.

【테스트】
```
TC-M5.T1.a  invite_only (여섯 조합, Q3·Q5 의존)
  단언:  설치 직후 공개 가입 403 signup_closed → 관리자가 이메일 지정 member 초대 → 수락 201 → 그 회원 로그인 → 키 발급 201 (이메일 인증 메일 없이, Q5) → 같은 토큰 재수락 400 invalid_invite
  검출:  어느 조합의 DB 경로에서 초대 차지가 1행 판정을 못 해(MySQL affectedRows·D1 meta.changes) 수락이 늘 실패하거나 두 번 되는 것
TC-M5.T1.b  open + 승인 + 하루 상한 (여섯 조합, Q6·Q13 의존)
  단언:  메일 설정 → PATCH open·상한 2 → 공개 가입 2건 201·3번째 403 signup_cap·alert.signup_cap 1행 → 인증 링크 열기 → 로그인 403 account_pending → approve → 로그인 200 → 키 발급 201 → monthly_limit_usd 5
  검출:  한 조합에서 user.create.before 가 돌려준 status pending·한도가 저장되지 않아(Better Auth 어댑터의 방언 차이) 그 조합만 승인 없이 무제한 회원이 생기는 것
TC-M5.T1.c  domain_allowlist·closed (여섯 조합, Q14 의존)
  단언:  domain_allowlist ["e2e.test"] → a@e2e.test 201, a@other.test 403. closed → 공개 가입 403, 초대 만들기 409
  검출:  정책 값이 조합의 DB 에서 JSON 문자열로 읽혀 allowed_domains 비교가 늘 거짓이 되는 것
TC-M5.T1.d  정지·해제·삭제 (여섯 조합)
  단언:  초대 회원 키로 요청 200 → suspend → 다음 요청 403·회원 세션 401·로그인 403 account_suspended → unsuspend → 키 요청 200 → DELETE → 키 403·로그인 401
  검출:  Workers 조합에서 정지의 즉시 반영(applyKey)이 요청 안에서 끝나지 않고 waitUntil 로 흘러가 "정지 완료" 응답 뒤에도 키가 통과하는 것
```

【통과】
- [ ] G-M5.1 ~ G-M5.6 통과

### ☐ M5.T2 — 7장 회귀 시나리오 (3단계 몫)
선행 M5.T1 · 산출 `tests/e2e/members/regress.mjs` · 되돌리기 커밋 1개

【작업】
1. 계획서 7장 "회귀 테스트로 옮길 공격 시나리오" 중 3단계 몫 둘과 이 문서가 더한 셋을 docker-sqlite·workers-d1 에서 돈다: 가입 요청에 `role`·`status`·`monthly_limit_usd` 넣기(공개 가입·초대 수락 둘 다), 이메일 없는 관리자 초대, 초대 토큰 재사용·동시 수락, 정지 회원의 옛 세션, 정지 관리자의 설치 API. 커밋.

【테스트】
```
TC-M5.T2.a  가입·초대 수락 본문의 권한 칼럼은 무시된다 (7장)
  단언:  open 공개 가입·초대 수락 본문에 role admin·status active·monthlyLimitUsd null·isBootstrapAdmin true → 회원 role member·status pending(공개)·active(초대)·monthly_limit_usd 5·is_bootstrap_admin false
  검출:  초대 수락 API 가 본문을 auth.api.signUpEmail 에 그대로 넘겨, Better Auth 의 input: false 는 지나도 우리 데이터 병합(user.create.before 반환값)에 본문 값이 섞이는 것
TC-M5.T2.b  이메일 없는 관리자 초대·토큰 재사용·정지 접근 (7장 + 3단계)
  단언:  {role:admin} 초대 400 · 쓴 토큰 재수락 400 · 동시 수락 5건 201 == 1 · 정지 회원 옛 쿠키 401 · 정지 관리자 PUT /api/setup/omniroute 403
  검출:  단위 시험은 초록인데 실제 배포 묶음(Caddy·Workers)에서 쿠키·Origin 처리 차이로 한 경로가 빠지는 것
```

【통과】
- [ ] G-M5.7 · G-M5.8 통과

### ☐ M5.T3 — CI 에서 정책 시나리오를 E2E 매트릭스가 돈다
선행 M5.T1 · 산출 `.github/workflows/ci.yml`, `scripts/check-ci-matrix.mjs`, `test/fixtures/ci-guard/e2e-members-missing.yml` · 되돌리기 커밋 2개 · 장치 요구 `Red: TC-M5.T3.a`

【작업】
1. 픽스처 `e2e-members-missing.yml`(`# expect: members-scenario`, 매트릭스에 `--scenario members` 없음)과 M5 단계에 그 검사. 꼬리줄 `Red: TC-M5.T3.a`. 커밋.
2. `check-ci-matrix.mjs`: 봉인된 M5 가 있으면 매트릭스에 `pnpm e2e --combo <c> --scenario members` 스텝을 요구한다 (문제 코드 `[members-scenario]`, K6.T5 처럼 다른 검사와 겹치지 않게). `e2e` 매트릭스 잡에 그 스텝. M5 잡은 G-M5.1~6 을 `--skip-ids`로 뺀다. 커밋.

【테스트】
```
TC-M5.T3.a  매트릭스가 정책 시나리오를 빠뜨리면 잡는다
  단언:  check-ci-matrix --fixture test/fixtures/ci-guard/e2e-members-missing.yml --expect 6 --expect-fail → 0 ([members-scenario] 잡음)
  검출:  M5 잡이 --skip-ids 로 여섯 시나리오를 빼고 매트릭스에는 그 스텝이 없어 완료 기준 E2E 가 CI 에서 하나도 안 도는 것
TC-M5.T3.b  실제 ci.yml 은 여섯 조합 모두 정책 시나리오를 돈다
  단언:  check-ci-matrix --expect 6 → 0
  검출:  매트릭스 스텝 명령 오타로 시나리오 인자가 빠지는 것
```

【통과】
- [ ] G-M5.9 · G-M5.10 통과

### ☐ M5.T4 — M5 CI 잡과 봉인
선행 M5.T1 ~ M5.T3 · 산출 `.github/workflows/ci.yml` · 되돌리기 커밋 1개

【작업】
1. 잡 `p3-m5`(이름 `완료 기준 (M5 게이트, 정책 시나리오는 e2e 잡)`) 스텝 `run: node scripts/gate.mjs M5 --explain --skip-ids G-M5.1,G-M5.2,G-M5.3,G-M5.4,G-M5.5,G-M5.6`. 커밋.
2. `(사용자/메인 세션)` ruleset 필수 검사에 그 이름.
3. `gate M5 --seal`(로컬은 여섯 조합 전부) → 커밋 → PR → 머지 커밋.

【테스트】
```
TC-M5.T4.a  M5 게이트를 도는 CI 잡이 있다
  단언:  grep "^\s+run: node scripts/gate\.mjs M5\b" ci.yml → 1 (G-M5.11)
  검출:  봉인 PR 에 잡을 빠뜨리는 것
TC-M5.T4.b  ruleset 필수 검사가 이 잡을 포함한다
  단언:  check-required-checks → 0 (G-M5.12)
  검출:  빨간 채로 병합되는 것
```

【통과】
- [ ] G-M5.11 · G-M5.12 통과

## 🚪 GATE M5

| id | 검사 | 명령 | 통과 기준 |
|---|---|---|---|
| G-M5.1 | TC-M5.T1.a~d docker-sqlite | [L] `pnpm e2e --combo docker-sqlite --scenario members` | 종료코드 0 — 정지 뒤 첫 키 요청 403, 상한 2 에서 3번째 403, 재수락 400 |
| G-M5.2 | 같음 docker-mysql | [L] `pnpm e2e --combo docker-mysql --scenario members` | G-M5.1 과 같은 기준 |
| G-M5.3 | 같음 docker-pg | [L] `pnpm e2e --combo docker-pg --scenario members` | 같음 |
| G-M5.4 | 같음 workers-d1 | [L] `pnpm e2e --combo workers-d1 --scenario members` | 같음 |
| G-M5.5 | 같음 workers-mysql | [L] `pnpm e2e --combo workers-mysql --scenario members` | 같음 |
| G-M5.6 | 같음 workers-pg | [L] `pnpm e2e --combo workers-pg --scenario members` | 같음 |
| G-M5.7 | TC-M5.T2.a·b docker-sqlite | [L] `pnpm e2e --combo docker-sqlite --scenario members-regress` | 종료코드 0 |
| G-M5.8 | TC-M5.T2.a·b workers-d1 | [L] `pnpm e2e --combo workers-d1 --scenario members-regress` | 종료코드 0 |
| G-M5.9 | TC-M5.T3.a·b | `node scripts/check-ci-matrix.mjs --expect 6 && node scripts/check-ci-matrix.mjs --fixture test/fixtures/ci-guard/e2e-members-missing.yml --expect 6 --expect-fail` | 종료코드 0 |
| G-M5.10 | 재현 빨강 TC-M5.T3.a | `node scripts/check-red.mjs --check G-M5.9 --since seal:M4` | 종료코드 0 |
| G-M5.11 | TC-M5.T4.a CI 단계 잡 | grep `^\s+run: node scripts/gate\.mjs M5\b` in ci.yml | == 1 |
| G-M5.12 | ruleset · TC-M5.T4.b | `node scripts/check-required-checks.mjs --repo henryj-dev/magnetosphere` | 종료코드 0 |

`node scripts/gate.mjs M5 --seal`

가장 중요한 검사는 G-M5.4 다. Workers + D1 은 초대 차지·가입 되돌리기·하루 상한·정지 반영이 모두 대화형 트랜잭션 없이 도는 유일한 조합이다.

---

# M6 — 재발 방지와 잔재 회수 🔒 (M5 필요)

**브랜치** `p3/m6`.
**outputs** 없음 (검사와 문서만).

### ☐ M6.T1 — 임시 코드·꺼진 테스트 회수
선행 없음 · 산출 없음 (검사만) · 되돌리기 해당 없음

【작업】
1. K6.T1 과 같은 두 검사를 3단계 경로까지 다시 돈다. 시험 갈림길·꺼진 테스트·미구현 표식 0. 커밋.

【테스트】
```
TC-M6.T1.a  운영 코드에 시험 갈림길이 없다 (3단계 경로 포함)
  단언:  G-K6.1 과 같은 grep, 3단계가 만든 apps/server/src/{settings,members,audit,invites,signup,admin,sessions} 포함 → 0
  검출:  E2E 에서 가입 최소 응답 시간(400ms)이나 하루 상한을 끄려고 넣은 환경 변수가 운영에 남는 것
TC-M6.T1.b  건너뛴 테스트와 미구현 표식이 없다
  단언:  G-K6.2 와 같은 grep → 0
  검출:  .skip 으로 꺼진 동시 수락 TC 를 expectPassed 를 줄여 맞춘 채 초록으로 보이는 것
```

【통과】
- [ ] G-M6.1 · G-M6.2 통과

### ☐ M6.T2 — 운영 코드는 회원을 직접 만들지 않는다
선행 없음 · 산출 없음 (검사만) · 되돌리기 해당 없음

【작업】
1. 운영 코드에서 `user` 테이블 삽입은 설치(최초 관리자, `setup/index.ts`)와 저장 계층 도우미(`packages/db/src/users.ts` `insertUser`), 그리고 Better Auth 경로뿐임을 검사로 고정한다. 커밋.

【테스트】
```
TC-M6.T2.a  user 직접 삽입은 두 곳뿐이다
  단언:  grep "insert\((h\.schema\.|schema\.)user\)" in apps/server/src packages/*/src → 2 (setup/index.ts, packages/db/src/users.ts)
  검출:  다음 단계가 편의 API 로 회원을 직접 넣어 가입 정책·기본 한도·권한 칼럼 보호를 모두 비켜 가는 것
```

【통과】
- [ ] G-M6.3 통과

### ☐ M6.T3 — 운영 문서에 가입 정책·데이터 처리
선행 없음 · 산출 `deploy/README.md` · 되돌리기 커밋 1개

【작업】
1. 운영 문서에 넣는다: 정책 다섯과 메일 의존, 초대 링크는 한 번만·기본 7일, 탈퇴하면 개인정보는 지우지만 OmniRoute 호출 기록과 키별 사용액은 남는다(Q9), 하루 가입 상한은 UTC 날짜. 커밋.

【테스트】
```
TC-M6.T3.a  운영 문서에 정책과 데이터 처리가 있다 (Q9 의존)
  단언:  grep "invite_only" deploy/README.md ≥ 1, grep "OmniRoute 호출 기록은 지워지지 않는다" == 1, grep "UTC 날짜" ≥ 1
  검출:  운영자가 탈퇴 처리로 OmniRoute 쪽 기록까지 지워진다고 믿고 외부 사용자에게 그렇게 안내하는 것
```

【통과】
- [ ] G-M6.4 통과

### ☐ M6.T4 — 3단계 전체 봉인·순서·필수 검사
선행 M6.T1 ~ M6.T3 · 산출 `.github/workflows/ci.yml` · 되돌리기 커밋 1개

【작업】
1. 잡 `p3-m6`(이름 `재발 방지 (M6 게이트)`) 스텝 `run: node scripts/gate.mjs M6 --explain`. M6 `checks` 채움. 커밋.
2. `(사용자/메인 세션)` ruleset 필수 검사에 그 이름.
3. `gate M6 --seal` → 커밋 → PR → 머지 커밋.

【테스트】
```
TC-M6.T4.a  M6 게이트를 도는 CI 잡이 있다
  단언:  grep "^\s+run: node scripts/gate\.mjs M6\b" ci.yml → 1 (G-M6.8)
  검출:  봉인 PR 에 잡을 빠뜨리는 것
TC-M6.T4.b  1·2·3단계 봉인이 모두 유효하고 처음 커밋부터 순서 위반이 없다
  단언:  gate --status --json → S0~S7·K0~K6·M0~M5 모두 sealed (G-M6.5), --assert-order --base <첫 커밋> → 0 (G-M6.6)
  검출:  어느 단계를 스쿼시로 병합해 봉인이 ⚠ 가 된 채 3단계를 끝났다고 보는 것
TC-M6.T4.c  ruleset 필수 검사가 이 잡을 포함한다
  단언:  check-required-checks → 0 (G-M6.7)
  검출:  빨간 채로 병합되는 것
```

【통과】
- [ ] G-M6.5 ~ G-M6.8 통과

## 🚪 GATE M6

| id | 검사 | 명령 | 통과 기준 |
|---|---|---|---|
| G-M6.1 | TC-M6.T1.a 시험 갈림길 0 | G-K6.1 의 패턴, 같은 경로 | == 0 |
| G-M6.2 | TC-M6.T1.b 꺼진 테스트·미구현 표식 0 | G-K6.2 의 패턴·제외 | == 0 |
| G-M6.3 | TC-M6.T2.a user 직접 삽입 두 곳 | grep `insert\((h\.schema\.\|schema\.)user\)` in `apps/server/src packages/auth/src packages/db/src packages/omniroute/src packages/runtime/src` | == 2 |
| G-M6.4 | TC-M6.T3.a 운영 문서 | grep `OmniRoute 호출 기록은 지워지지 않는다` in `deploy/README.md` | == 1 |
| G-M6.5 | TC-M6.T4.b 봉인 모두 유효 | `node scripts/gate.mjs --status --json` 에서 S0~S7·K0~K6·M0~M5 | 모두 ✅ |
| G-M6.6 | TC-M6.T4.b 처음 커밋부터 순서 위반 없음 | `node scripts/gate.mjs --assert-order --base "$(git rev-list --max-parents=0 HEAD)"` | 종료코드 0 |
| G-M6.7 | ruleset · TC-M6.T4.c | `node scripts/check-required-checks.mjs --repo henryj-dev/magnetosphere` | 종료코드 0 |
| G-M6.8 | TC-M6.T4.a CI 단계 잡 | grep `^\s+run: node scripts/gate\.mjs M6\b` in ci.yml | == 1 |
| G-M6.9 | 어댑터 밖 관리 호출 0 | G-K4.23 과 같음 | == 0 |

`node scripts/gate.mjs M6 --seal`

가장 중요한 검사는 G-M6.3 이다. 3단계가 지키는 규칙(정책·기본 한도·권한 칼럼)은 모두 "회원은 정해진 입구로만 생긴다"에 기대고, 입구를 하나 더 내는 변경은 어느 기능 시험에도 걸리지 않는다.

---

## 최종 목표표

계획서 9장 3단계 완료 기준("정책별 시나리오와 7장 회귀 테스트 통과")과 그 밑의 숫자를 옮긴 것이다.

| 지표 | 목표 | 검사 |
|---|---|---|
| **정책별 시나리오가 통과하는 조합 수** | **6 / 6** | G-M5.1 ~ G-M5.6 (TC-M5.T1.a~d) |
| 7장 회귀 (3단계 몫) | 2 / 2 + 3단계 추가 3 / 3 | G-M5.7 · G-M5.8, G-M2.1 |
| 설치 직후 공개 가입 | 403 (`invite_only`) | G-M3.1, TC-M5.T1.a |
| 거부한 가입이 남기는 행·메일 | 0 (네 DB) | G-M0.5, G-M3.1 |
| 초대 하나로 생기는 회원 | 정확히 1 (다섯 DB, 동시 10건) | G-M2.7 · G-M2.8 |
| 하루 가입 상한 초과 | 0 (다섯 DB, 동시 10건) | G-M3.8 · G-M3.10 |
| 정지 뒤 첫 키 요청·옛 세션 | 거부 (403 · 401) | G-M4.10, G-M4.18, G-M5.1 ~ 6 |
| 새 회원 기본 월 한도 | $5 (설정값 복사, Q16) | G-M3.7, TC-M5.T1.b |
| 가입 응답 시간 차 (있는·없는 계정) | < 30ms, 응답 ≥ 400ms | G-M3.13 |
| 메일 지연이 응답에 더하는 몫 | < 150ms (1단계 250ms 에서 낮춤) | G-M3.14 · G-M3.16 |
| 초대 만료 | 기본 7일 · 최대 30일 (Q4) | G-M2.3 |
| 활성 관리자 0명이 되는 동작 | 0 (동시 강등 포함) | G-M4.4 |
| 확인 항목 | 4 / 4, 설계 막음 0 | G-M0.2 · G-M0.3 |
| 미정 질문 | 0 / 18 | G-M0.11 |

최종 판정은 **정책별 시나리오 6/6 조합**이다. 3단계가 새로 만드는 동작은 "회원이 어떤 입구로, 어떤 상태로 생기고 멈추는가"이고, 그 입구(Better Auth 훅·초대 차지·하루 상한)와 멈춤(세션·키 반영)이 모두 DB 방언과 런타임 차이를 지나간다. 여섯 조합에서 시나리오가 실제로 도는지가 나머지 지표를 묶는다.

## 막혔을 때

- **게이트가 빨간데 원인을 모름**: `node scripts/gate.mjs <단계> --explain`. `통과 n / 기대 m`이면 `-t` 패턴에 걸린 TC 목록을 먼저 본다.
- **봉인 뒤 회귀**: 봉인을 고치지 않는다. 고친 커밋을 올린 뒤 `--seal`을 다시 돈다 (R3). 병합은 머지 커밋만.
- **확인 결과가 계획서와 다름 (M0)**: `V*.json`을 `blocking: true`로 두고 계획서를 개정한다. 특히 V29(가입 거부 훅이 행을 남김)면 판정 자리를 `hooks.before`로 옮기고 M3.T1 을 `(폐기)` + 새 번호로 바꾼다. `gates.config.mjs`는 그 단계 `checks`만 고친다.
- **질문 결정이 추천과 다름**: 이 문서 맨 위의 그 질문 "영향" 줄을 따라 `(Q<n> 의존)` TC 를 고친다. 스키마가 바뀌는 질문(Q4 (나), Q9 (나), Q16 (나))은 M1.T4 의 0003 에 넣는다. 단계가 생기는 질문(Q2 (나))은 이 문서를 개정해 단계를 더하고 `gates.config.mjs`에 새 단계(새 경로 `outputs`)를 넣는다 — 잠긴 단계의 `needs`는 못 고치므로 새 단계는 M5 의 `needs`가 아니라 새 단계 자신의 `needs`로 잇고, M5 앞에 와야 하면 이 계획 브랜치에서 M5 `needs`를 고친다 (아직 병합 전이면 된다).
- **`--assert-order`가 3단계 단계를 이유로 거부**: 바꾼 파일이 아직 🔒 인 단계의 `outputs`에 걸렸다. 그 파일은 그 단계에서 고친다.
- **잠긴 단계의 `outputs`를 아직 병합 안 된 브랜치에서 고쳐야 함**: 2단계 실행판 「막혔을 때」와 같다. 봉인 파일이 없는 계획 브랜치라면 원격 브랜치를 지우고 다시 올린다. `--no-verify`로 넘기지 않는다.
- **가입 응답 시간 시험이 CI 에서 흔들림 (M3.T5)**: 최소 시간 400ms 를 늘리기 전에 세 번 잰 흩어짐을 PR 에 남긴다. 차이가 DB 쓰기가 아니라 비밀번호 해시에서 나면 해시를 없는 계정에도 돌리는 쪽(Better Auth 내부)을 먼저 본다.
- **Docker 메모리(4GB) 부족**: 계약 환경·시험 DB·mailpit 이 이미 떠 있다. E2E 묶음은 조합마다 띄우고 내린다.
- **일정 부족**: 단계를 건너뛰지 않는다. 면제 가능한 단계가 없다. 범위를 줄이려면 계획서를 개정하고 해당 작업을 `(폐기)`로 표시한다. 줄일 후보: M2.T3(초대 정리), M4.T4(자기 탈퇴, Q10 (나)).
- **사용자 OmniRoute(`localhost:20128`)와 충돌**: 모든 시험은 20170(계약)에서 돈다. 20128 을 쓰는 검사가 보이면 그 검사가 잘못된 것이다.

## 확인 결과에 기댄 TC 목록

| TC | 기대는 확인 결과·결정 | 결과가 다르면 |
|---|---|---|
| TC-M0.T2.a·b, TC-M2.T2.*, TC-M3.T1.a·b | V29 가입 거부 훅의 원자성·서버 호출 구분 | 판정 자리를 `hooks.before`로, 초대 수락을 다른 표시로 |
| TC-M0.T3.a·b, TC-M4.T3.a·b·d | V30 세션 행 삭제 즉시성, 비밀번호 변경 기본 동작 | 계획서 4.5 에 지연을 적거나 쿠키 캐시를 끔 |
| TC-M0.T4.a·b, TC-M4.T3.a·c·e | V31 로그인 거부 훅, 재설정·인증 링크 자동 로그인 | 로그인 차단 자리를 `hooks.before` 경로별로 |
| TC-M0.T5.a, TC-M3.T1.b·d | V32 기본으로 열린 회원 변경 경로 | `disabledPaths` 목록 |
| TC-M3.T1.a (재현 대상) | Q1 공개 가입을 먼저 막는가 | Red 재현 대상을 정책 표로 |
| (단계 구성) | Q2 화면 범위 | 단계 하나 추가 |
| TC-M2.T1.e, TC-M3.T1.a, TC-M5.T1.a | Q3 정책마다 초대 | 표 |
| TC-M2.T1.c, TC-M2.T2.a | Q4 한 번만·7일·30일 | 0003 칼럼, 동시 수락 기대 수 |
| TC-M2.T1.e, TC-M2.T2.c, TC-M5.T1.a | Q5 이메일 지정 초대 = 인증됨 | 메일 없는 invite_only 의 키 발급 |
| TC-M2.T2.d, TC-M3.T2.a, TC-M5.T1.b | Q6 승인 범위 | 표 |
| TC-M0.T4.*, TC-M4.T3.a·c·e | Q7 pending·suspended 로그인 차단 | 로그인 허용 + /api/me 차단으로 |
| TC-M1.T2.a, TC-M4.T1.b | Q8 전이 표·거절 = 행 삭제 | 표 |
| TC-M1.T4.a, TC-M4.T2.b, TC-M6.T3.a | Q9 행 유지 + 개인정보 지움 | 0003, 삭제 단언 |
| TC-M4.T4.a | Q10 자기 탈퇴 | M4.T4 `(폐기)` |
| TC-M4.T1.e | Q11 역할 둘 | 값 검사·권한 TC |
| TC-M1.T2.b, TC-M4.T1.d | Q12 관리자 보호 셋 | 표 |
| TC-M3.T3.a·b, TC-M5.T1.b | Q13 UTC·자기 가입만·null/0 | 상한 단언 |
| TC-M1.T1.a, TC-M3.T2.b, TC-M3.T1.d, TC-M5.T1.c | Q14 정확히 일치·이메일 변경 막음 | 비교 함수 |
| TC-M1.T1.b, TC-M3.T1.c, TC-M3.T4.b | Q15 메일 = `mail_settings` 행, fail-closed | 판정 |
| TC-M2.T2.d, TC-M3.T2.c, TC-M5.T1.b | Q16 기본 한도 복사, max_keys NULL 유지 | 스키마·분배 코드(다) |
| TC-M1.T3.a·b | Q17 action 목록·개인정보 없음 | 목록 |
| TC-M1.T1.b | Q18 `sso_only` 저장 거부 (IdP 없음) | 400 으로 |

## 코드 미확인 TC 목록

1·2단계 코드(`packages/auth/src/index.ts`·`rate-limit.ts`, `packages/db/src/schema/common.ts`·`seed.ts`·`auth-options.ts`, `apps/server/src/app.ts`·`config.ts`·`setup/*`·`routes/{guard,keys,issue,admin-limits}.ts`·`keys/{target,apply,reconcile,alerts}.ts`·`queue/index.ts`, `tests/e2e/keys/env.mjs`, `packages/auth/test/*`)는 열어 보고 검출줄에 그 사실을 적었다. 아래는 기대는 코드나 동작이 아직 없어 열어 보지 못한 것이다.

| TC | 열어 보지 못한 것 | 처음 확인되는 곳 |
|---|---|---|
| TC-M0.T2.b | better-auth 1.7.7 `databaseHooks` 의 두 번째 인자 모양 (서버 호출 때) | M0.T2 |
| TC-M0.T4.b | `autoSignInAfterVerification`·재설정 뒤 자동 로그인의 1.7.7 기본값 | M0.T4 |
| TC-M0.T5.a, TC-M3.T1.b | 1.7.7 `auth.api`의 user 생성·변경 경로 목록 | M0.T5 |
| G-M0.5 ~ 8 | `packages/auth` 시험 실행기(`scripts/test.mjs`)가 `-t` 하나를 DB 넷에 도는지와 그 통과 수 | M0.T2 (다르면 `expectPassed`만 고친다) |
| TC-M3.T5.a | Workers 에서 요청 안의 `setTimeout` 기다림이 CPU 시간 한도에 걸리지 않는지 | M3.T5 |
| TC-M5.T1.b | Resend 어댑터의 보낼 주소를 시험에서 바꿀 수 있는지 (`packages/auth/src/mail/resend.ts`) | M5.T1 |
| TC-M5.T1.* | `tests/e2e/run.mjs`의 `--scenario` 인자에 `members`·`members-regress`를 더할 자리 (2단계 K5.T2 가 `keys`를 넣은 방식) | M5.T1 |
