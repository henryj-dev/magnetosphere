# A1 — 관리자 MFA 설계 (초안)

> **상태: 설계 · 1단계(A1.T1 저장소·TOTP·정책·마이그레이션 0007) 구현 완료, 2단계(서버 연결) 진행 중 (p4/a1-mfa)**
> 통합계획(`/Users/henry/.claude/plans/parsed-launching-key.md`) 4절 A1의 구현 설계다. 게이트 단계 `A1`(needs M6)의 실행 순서·판정은 [`phase4-todo.md`](phase4-todo.md) A1 절이 정한다.
> 정책 수치는 공통 회원 수치 1차(2026-10-18 사용자 결정, orc 전달)를 배포 설정 값으로 쓴다 (3절). seed 길이만 4단계 Q12 로 남았다.
> 이 문서는 migration 적용·배포 승인이 아니다.

## 1. 결론: 앱 소유 MFA 모듈

Better Auth 1.7.7 `twoFactor` 플러그인은 켜지 않는다. 앱 플러그인 엔드포인트 `/api/auth/admin-mfa/*`를 두고, 테이블과 검증은 앱이 소유한다. `signup-confirmation`과 같은 방식이다.

SDK 플러그인을 버린 이유는 다음과 같다(설치 dist 소스 읽기로 확인).

| SDK 동작 | 요구와의 충돌 |
|---|---|
| 복구 코드를 복호화 가능한 JSON 배열로 보관하고 `includes`로 비교 | 해시 보관 요구를 만족할 수 없다 |
| `verifyTOTP`에 시간 step 재사용 방어가 없음 | 같은 코드를 시간창 안에서 다시 쓸 수 있다 |
| after-hook이 `/sign-in/email`·`username`·`phone`만 가로챔 | SSO 콜백에 MFA가 걸리지 않는다 |
| 해제가 비밀번호만 요구, `trustDevice` 30일 쿠키 | 관리자 MFA 면제 경로가 생긴다 |
| enable/verify/disable 때 세션 삭제·재생성 | `sessionBefore`의 authVersion·credential 지문 결합과 충돌한다 |
| secret 암호화에 사용자/행 AAD 결합이 없음 | 전용 AAD 요구를 만족하지 못한다 |

wrapper로 고치려면 거의 전부를 덮어써야 해서 SDK를 쓸 이점이 없다.

**동작 모델:** 1차 인증(비밀번호, 나중에 SSO)은 평소처럼 세션을 만들되, MFA 칼럼이 비어 있는 **부분 세션**이 된다. 정상 관리자 권한은 서버 가드가 세션의 MFA 충족 여부로 판정한다. 그래서 인증 경로가 늘어도 MFA를 빠뜨리지 않는다.

## 2. 데이터 모델 (새 migration, 번호는 구현 시점의 다음 번호)

### session 추가 칼럼 (`SESSION_ADDITIONAL_FIELDS`, 모두 `input: false`·`returned: false`)

| 칼럼 | 뜻 |
|---|---|
| `mfa_verified_at` | MFA를 마친 시각 |
| `mfa_factor_id` | 충족에 쓴 factor |
| `mfa_method` | `totp` 또는 `recovery` |
| `mfa_policy_version` | 충족 당시 정책 해시 |

**충족 조건:** `mfa_verified_at`이 있다. `mfa_factor_id`가 현재 active factor다. `mfa_policy_version`이 현재 정책 해시다. 기존 `validSession`(authVersion·credential 지문)도 통과한다.

별도 테이블이 아니라 세션 칼럼에 두는 이유: 세션 철회 문장(`revokeSessionsStatement`)과 함께 증거도 원자적으로 사라진다. 새 테이블은 `user`·`session`·`mfa_factor`를 `ON DELETE CASCADE`로 참조하지만(0007), libsql·D1에서 `foreign_keys`가 켜져 있다고 보장할 수 없어 MFA 충족 판정은 cascade 에 기대지 않는다. cascade 는 정리 보조일 뿐이다. 기존 세션은 칼럼이 비어 있으므로 MFA 충족으로 소급되지 않는다.

### 새 테이블 (모두 owner `app`)

- **`mfa_factor`**
  - `id`, `user_id`, `kind`(`totp`), `state`(`pending`·`active`·`revoked`)
  - `secret_enc`: `createCipher`로 암호화한다. AAD는 `mfa_factor.secret_enc|v1|{factorId}|{userId}`다.
  - 등록 당시 정책값 스냅샷: `period_s`, `digits`, `algorithm`
  - `last_used_step`: 재사용 차단 CAS 기준(bigint)
  - `pending_session_id`, `pending_auth_version`, `pending_expires_at`
  - `active_slot`·`pending_slot`(unique): 상태가 맞을 때만 `user_id`, 아니면 NULL. MySQL에는 부분 인덱스가 없어 "회원당 active 1개·pending 1개"를 이렇게 강제한다.
  - `created_at`, `activated_at`, `revoked_at`, `revoked_reason`, 인덱스 `idx_mfa_factor_user`
- **`mfa_recovery_code`**: `id`, `factor_id`, `user_id`, `code_hash`(HMAC-SHA256(서버 키, `factorId|code`)), `used_at`, `used_session_id`. unique(`factor_id`, `code_hash`).
- **`mfa_enrollment_grant`**: `id`, `user_id`, `token_hash`(unique), `purpose`(`bootstrap`·`promotion`·`reset`·`transition`), `issued_by`, `auth_version`, `expires_at`, `used_at`, `revoked_at`.
- **`mfa_proof`**(작업에 묶인 step-up 증명): `id`, `token_hash`(unique, HMAC-SHA256(서버 키, `mfa_proof|v1|token`) — 토큰 원문은 두지 않는다), `session_id`, `user_id`, `auth_version`, `factor_id`, `purpose`, `target`, `expires_at`, `used_at`. 민감 작업은 `X-MFA-Proof` 토큰을 같은 해시로 바꿔 소비 UPDATE 조건에 넣는다.

## 3. 정책 수치: 필수 설정, 기본값 없음

값은 공통 회원 수치 1차(2026-10-18 사용자 결정, orc 전달)를 따른다. 코드에는 기본값이 없고, 이 값은 배포 템플릿·운영 문서에 적는다.

| 설정 (`MFA_*`) | 1차 값 |
|---|---|
| TOTP step·digits·algorithm | 30초 · 6자리 · SHA-1 |
| 과거·미래 window | 앞뒤 1 step, 같은 step·과거 step 재사용 금지 (step CAS) |
| 민감 작업 최근성 (proof TTL) | 10분 |
| 관리자 세션 | 유휴 30분 · 절대 12시간 (일반 세션 A2 와 같음, 절대 TTL 은 일반 절대 TTL 이하만 받는다) |
| 실패 제한 | 5회 실패 뒤 1초부터 지수 지연 · 상한 15분 · 마지막 실패 15분 뒤 초기화 |
| 등록 grant 수명 | 24시간 (공통안 원문 "TOTP 등록 코드 24시간". 이메일 확인 링크 수명이 아니다) |
| 복구 코드 | 10개 |
| seed 길이 | **미정** — 4단계 Q12 (U5 전에 정한다) |

- 수치는 DB가 아니라 **배포 설정(env·wrangler vars)의 필수값**으로 둔다. DB에 두면 정책을 바꿀 주체(MFA를 마친 관리자)가 정책보다 먼저 필요해지고, DB 경로로 정책을 약화할 수 있다.
- 기동할 때 형식과 범위를 검사한다(정수, step > 0, window ≥ 0, 최근성 ≤ 세션 TTL 등).
- window 상한: `past + future + 1 ≤ TOTP_WINDOW_STEPS_LIMIT`(64, `totp.ts`). 공통 정책값이 아니라 요청 하나의 HMAC 계산량을 막는 구현 안전 한계다. 넘으면 `unavailable`(`implementation_limit`).
- 값이 없거나 범위를 벗어나면 정책 상태는 `unavailable`이다. 시작은 막지 않고, 관리자 가드는 503 `mfa_policy_unavailable`, 최초 설치는 503 `mfa_policy_required`로 닫힌다(fail-closed). 사유에는 설정 이름만 남기고 값은 남기지 않는다.
- 정규화한 정책의 해시가 `policy_version`이다. 정책이 바뀌면 모든 관리자에게 다시 MFA를 요구한다.

## 4. 흐름

### 설치 직후 (추천안 A)

- 정책이 준비되지 않았으면 `POST /api/setup`이 설치 토큰을 **소비하기 전에** 503 `mfa_policy_required`를 낸다. 아직 관리자가 없어 잠길 대상이 없다. 운영자는 설정을 고친 뒤 다시 시도한다.
- 성공하면 관리자 생성과 bootstrap grant 생성을 한 단위로 처리한다. 201 응답에 grant 토큰을 한 번만 넣는다.
- grant가 만료되면 bootstrap 관리자에게 active factor가 없는 동안에만 `POST /api/setup/mfa-grant`로 다시 발급한다. 새 설치 토큰이 필요하다(Node는 기동 시 출력, Workers는 `SETUP_TOKEN` 시크릿).
- 위험: Workers 운영자가 MFA를 마치기 전에 `SETUP_TOKEN`을 지우면 재발급 경로가 없다. 운영 문서에 보존 안내를 넣는다.
- 거부한 안: 관리자를 먼저 만들고 TOTP 확인 뒤 설치를 마치는 2단계 설치(B)는 그 사이 `adminExists()`가 참이 되어 가입 판정이 열린다. 관리자를 만들고 정책 대기로 두는 안(C)은 정책을 바꿀 주체가 없어 영구히 잠긴다.

### 로그인

1. `/sign-in/email` → 부분 세션.
2. `GET admin-mfa/status`가 `challenge_required` 또는 `enrollment_required`를 알려 준다.
3. `POST admin-mfa/challenge` → 시간 step CAS와 세션 승격을 한 단위로 처리한다.
4. 부분 세션 허용 경로는 `/get-session`, `/sign-out`, `/admin-mfa/*`뿐이다. `hooks.before`에서 막아 `/change-password` 등은 403 `MFA_REQUIRED`다. 관리자 역할로 회원 API(`sessionMember`)를 쓰는 것도 막는다.
5. 부분 세션 수명은 challenge TTL로 제한한다.

### 등록·재등록

- `enroll/start`: 최초 등록은 grant 토큰, 재등록은 기존 MFA로 얻은 proof(`mfa.reenroll`)가 필요하다. **비밀번호만으로는 등록할 수 없다.** pending factor를 세션·authVersion·만료에 묶는다.
- `enroll/confirm`: 새 seed의 TOTP를 확인한 뒤 한 단위로 처리한다. pending→active, grant 소비, 옛 factor 폐기, 복구 코드 삽입, user authVersion +1, 다른 세션 삭제, 현재 세션을 새 버전·MFA 충족으로 다시 묶기(`safe-reset-adapter` credentialWriter 방식), 감사 기록.

### 민감 작업 step-up

- `POST admin-mfa/step-up {code|recoveryCode, purpose, target}` → `mfa_proof`를 만든다(TTL = 최근성 설정값).
- 민감 작업은 `X-MFA-Proof`를 받아 **작업 자신의 트랜잭션·batch 안에서** `UPDATE mfa_proof SET used_at … WHERE id ∧ session ∧ purpose ∧ target ∧ auth_version ∧ used_at IS NULL ∧ expires_at > now`를 실행한다. 1행이 아니면 작업 전체를 되돌린다.
- proof를 요구할 작업: 역할 변경, 관리자 초대, MFA 작업, 관리자 탈퇴(확정 제안). 설정·메일·OmniRoute 토큰 변경은 결정 필요.

### 복구 코드

- challenge·step-up에서 해시로 찾고 `UPDATE … WHERE used_at IS NULL`로 소비한다.
- 생성 응답에서만 보여 주고 다시 보여 주지 않는다. 재생성에는 proof가 필요하다.

### 해제·승격·초기화

- 관리자에게 MFA 해제 API는 없다. 교체(재등록)만 있고, factor 해제는 강등 처리 안에서만 일어난다.
- 승격(`role=admin`)에는 proof가 필요하다. 한 단위에서 authVersion +1, 대상 세션 철회, promotion grant 발급을 한다. grant 토큰은 행위자에게 한 번만 보여 준다. 대상은 grant 없이 등록할 수 없다.
- 초기화 `POST /api/admin/users/:id/mfa-reset`(proof `mfa.reset`, 자기 자신·bootstrap 대상 거부)은 회원 관리 뮤텍스 아래에서 factor 폐기, 대상 세션 철회, authVersion +1, reset grant 발급을 한다.
- 마지막 관리자 보호는 "active이면서 active factor를 가진 관리자 수"로 강화한다.

### 기존 관리자 전환

- migration 뒤 기존 세션은 모두 미충족이다.
- grant는 운영자 CLI(`apps/server/scripts/mfa-transition-grant.ts --email <관리자>`)가 발급하는 transition grant로만 얻는다 (2026-10-18 사용자 결정). 대상의 열린 grant 를 모두 취소하고 하나를 만들며, 토큰은 표준 출력에 한 번만 나가고 감사 `mfa.grant_issue {purpose: transition, via: cli}`를 남긴다.

## 5. 원자성

- **시간 step CAS:** `UPDATE mfa_factor SET last_used_step = :s WHERE id ∧ user_id ∧ state = 'active' ∧ (last_used_step IS NULL OR last_used_step < :s)`.
  - 단조 증가라 같은 step과 과거 step을 모두 거부한다(RFC 6238 §5.2 한 번만 수락).
  - 로그인·step-up·등록 확인이 같은 칼럼을 써서 여러 인증 경로가 한 재사용 기록을 공유한다.
  - pg·MySQL(READ COMMITTED)은 행 잠금 뒤 조건을 다시 평가하므로 동시 요청 중 하나만 1행을 얻는다. SQLite는 쓰기 차례 하나, D1은 단일 writer다.
  - 영향 행 수는 MySQL `affectedRows`(값이 늘 바뀌므로 정확), 나머지는 `RETURNING`.
  - 인스턴스 메모리 캐시를 두지 않는다.
- **복구 코드·proof·grant 소비:** 모두 `… AND used_at IS NULL` 단일 UPDATE.
- **여러 문장 단위:** Node는 `db.transaction`(READ COMMITTED), 잠금 순서 user → factor → session. D1은 batch로 묶고 각 CAS 뒤에 `CASE WHEN changes() = 1 … ELSE NULL` guard INSERT를 둔다(`safe-reset-adapter`·`guard-sql` 감사 guard와 같은 방식).

## 6. API·가드·요청 수 제한

| 경로 | 결과 |
|---|---|
| `GET admin-mfa/status` | `{state, method, recoveryRemaining, policy}` |
| `POST admin-mfa/enroll/start` | `{factorId, otpauthUri, secret, period, digits, algorithm, expiresAt}` |
| `POST admin-mfa/enroll/confirm` | `{recoveryCodes}` |
| `POST admin-mfa/challenge` | 세션 승격 |
| `POST admin-mfa/step-up` | `{proof, expiresAt}` |
| `POST admin-mfa/recovery-codes/regenerate` | 새 복구 코드 |
| `POST /api/admin/users/:id/mfa-reset` | reset grant |
| `POST /api/setup/mfa-grant` | bootstrap grant 재발급 |

- 모두 정확한 Origin, JSON 전용, `Cache-Control: no-store`.
- 잘못된 코드·재사용·factor 없음은 모두 401 `INVALID_MFA_CODE` 하나로 낸다.
- 그 밖의 오류: 403 `MFA_REQUIRED`·`MFA_ENROLLMENT_REQUIRED`·`MFA_GRANT_REQUIRED`·`MFA_PROOF_REQUIRED`, 409 `MFA_ENROLLMENT_EXPIRED`·`MFA_STALE`, 429, 503 `mfa_policy_unavailable`·`mfa_unavailable`(DB 장애).
- `sessionAdmin`: get-session 확인을 한 번만 하고 userId·sessionId를 함께 받는다(지금 `admitted()`가 두 번 확인하는 틈을 없앤다). session·user·active factor를 한 번에 읽어 MFA 충족을 판정한다. `sessionAdminWithProof(purpose, target)`를 새로 둔다.
- 요청 수 제한: `RATE_LIMIT_RULES`에 `/admin-mfa/*`(IP 기준), `consume()`로 회원·IP 칸을 센다. 수치는 3절 실패 제한 값이다.

## 7. 파일

- **새 파일:** `packages/auth/src/mfa/{totp,policy,store,session,plugin}.ts`(TOTP·base32는 WebCrypto HMAC로 직접 구현하고 RFC 6238 부록 B 벡터로 시험), `apps/server/src/mfa/{admin,proof}.ts`, migration 3벌과 업그레이드 시험, 전환 CLI(승인 뒤).
- **수정:** `packages/db/src/schema/common.ts`와 생성 스키마, `packages/auth/src/{index,rate-limit}.ts`, `apps/server/src/routes/guard.ts`, `apps/server/src/admin/{members,guard-sql,self-delete}.ts`, `apps/server/src/invites/{admin,accept}.ts`, `apps/server/src/setup/{index,routes}.ts`, `apps/server/src/audit/index.ts`(새 감사 action, 금지 detail 키에 secret·otp·code·recovery·seed·uri 추가), `app.ts`·`config.ts`·`node.ts`·`workers.ts`.
- **재사용:** `createCipher`(`packages/runtime/src/crypto.ts`), `consume`·`ipBucket`, `revokeSessionsStatement`, `auditStatement`·D1 guard, `ensureMemberMutex`·`lockMemberMutex`·`lockUsers`·`changed`(`admin/guard-sql.ts`), credentialWriter 방식, `constantTimeEqual`, `setSessionCookie`, `validAuthVersion`·`activeAuthUser`, 초대 차지 UPDATE 방식.

## 8. 시험

- **TC 접두:** `TC-A1.T{n}.{x}`. 봉인된 단계 선택식(`H1[.]`, `M4.T3` 등)과 겹치지 않는다. phase4의 U 단계 이름과도 섞지 않는다.
- **단위:** RFC 6238 벡터, 시간창 경계, 정책 누락·범위 밖 → unavailable, 다른 factor·user AAD 복호화 거부, 로그·감사·오류에 비밀 문자열 없음.
- **DB 4종 + D1:** 같은 코드 두 번 → 1회만 성공. 서로 다른 경로를 섞은 동시 N건 → 정확히 1건 성공. 복구 코드 동시 소비 → 1건. proof 재사용·다른 purpose·target·세션 거부. CAS 0행이면 batch 전체 되돌림. migration 뒤 기존 세션 미충족.
- **서버·E2E:** password-only·부분 세션·미등록·정책 버전 불일치·factor 교체 뒤 옛 세션의 관리 API 거부(직접 호출 포함), 부분 세션의 `/change-password` 403, 설치 → grant → 등록 → 정상 세션, grant 없는 등록 거부, 승격·초기화, 마지막·bootstrap 관리자 보호, Workers D1 같은 흐름.
- **Red:** CAS 조건 `<`를 빼면 재사용 시험이 실패하고, `sessionAdmin` MFA 판정을 끄면 거부 시험이 실패해야 한다. 격리 worktree 변이로 확인하고 약화 커밋은 남기지 않는다.

## 9. 결정 현황

| 항목 | 상태 |
|---|---|
| TOTP step·digits·algorithm, window, 최근성, 관리자 idle·절대 TTL, 실패 제한, 등록 grant 수명, 복구 코드 개수 | 결정됨 — 공통 회원 수치 1차 (3절) |
| seed 길이 | 미정 — 4단계 Q12 (참고 근거 RFC 4226 §4 R6, 기본값 아님) |
| challenge·pending TTL | 구현 값 확인 뒤 3절 표에 더한다 (공통안에 없음, 최근성·등록 grant 수명 이하) |
| 설치 경로 | 결정됨 — A: 정책 미준비면 설치 토큰 소비 전 503 `mfa_policy_required`로 거부 |
| 기존 관리자 전환 | 결정됨 — 운영자 CLI transition grant (4절) |
| proof 토큰 저장 | 결정됨 — 원문 없이 HMAC 해시만 (`mfa_proof.token_hash`) |
| FK | 결정됨 — 0007 에 `ON DELETE CASCADE`, 단 판정은 cascade 에 기대지 않음 (2절) |
| window 상한 | 결정됨 — 구현 안전 한계 64 step (3절) |
| 복구 코드 형식·엔트로피, 소진·분실 절차, 2인 승인, 복구 사용 뒤 재등록 강제 | 공통안 대기 |
| grant 전달 방식(행위자 표시 또는 메일), 관리자 초대 수락 때 grant 처리 | 제품 결정 |
| 설정·메일·OmniRoute 토큰 변경에 proof 요구 | 제품 결정 (결정 전에는 요구하지 않음) |
| 세션 토큰 회전 여부 | 구현 확인 필요 |

## 10. 위험·미확인

- **봉인된 단계 시험:** 관리자를 만들어 비밀번호만으로 관리 API를 부르는 시험 파일이 약 32개다. A1 뒤에는 실패한다. 시험 전용 정책값을 쓰는 공용 MFA fixture로 바꿔야 하며, 봉인 단계의 `-t` 선택식과 기대 통과 수는 그대로 맞아야 한다.
- **미확인:** Better Auth 1.7.7에 세션 추가 칼럼을 바꾸는 공개 엔드포인트(update-session 등)가 없는지, 플러그인 엔드포인트 안 `setSessionCookie` 토큰 회전 동작, 순차 배포 중 인스턴스 간 정책 해시 차이로 생기는 재요구 반복, D1 batch `RETURNING` 영향 행 판정.
- **잠김:** bootstrap 관리자 한 명이 TOTP와 복구 코드를 모두 잃으면 앱 안에 복구 경로가 없다(의도). 복구는 운영자 CLI transition grant 로만 한다 (4절).
