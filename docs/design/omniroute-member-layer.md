# Magnetosphere — OmniRoute 회원 계층 설계

작성일: 2026-10-09

실행판(1단계)은 [`../plan/phase1-todo.md`](../plan/phase1-todo.md) 다.
2단계 실행판은 [`../plan/phase2-todo.md`](../plan/phase2-todo.md) 다.
상태: 초안 v5.7 (설계 검토 1회 + S1 확인 + S2 리뷰 + S4 보안 리뷰 + K0 확인 반영)

변경 이력
- v5.7: 확인 15번 결정(선택지 B). 1분 분배는 오늘(UTC) 창만 분석으로 부르고, 지난 날 몫은 `usage_daily`에 키·날짜별로 저장한다. 날이 바뀐 첫 분배가 어제를 확정 저장하고, 하루 한 번 이번 달 1일~어제를 다시 불러 대조한다(차이는 `alert.usage_drift`). 측정 기준은 오늘 창 p95 ≤ 2초·회원 하나 ≤ 1초·대조 ≤ 임대 55초 (5.3·5.4·5.9·8장).
- v5.6: K0 확인(`../verify/` V12·V13·V15·V18·V19·V20)과 설계 공백 결정 반영. Q1 남은 한도가 0 이면 키를 끈다(`disabled_reason` `limit`, 한도가 다시 생기면 자동으로 켬, 목표 상태 입력에 남은 한도). Q2 재시도 간격 1분·2분·10분·30분 (실행기 최소 주기 1분). Q3 4번째 재시도 실패 → 작업 `failed`·키 `sync_state` `failed`, 정합성 점검이 계속 다시 맞추고 `failed` 30분이 지나면 "오래 실패". Q4 키 발급 요청 수 제한 회원당 1시간 10회·IP 당 1시간 30회 (429). Q5 1분 분배가 달 바뀜을 스스로 판단 (월간 cron 없음). Q6 "관리자에게 알린다" = `audit_log` action `alert.<종류>`. 확인 결과로 재발급은 `regenerate` 대신 새 키 발급 + 옛 키 삭제, 삭제는 끄고 60초가 지난 뒤 `DELETE` (V18·V19), 쿼터 풀 공동 예산은 쓰지 않고 분배 유지 (V12), 월 기준은 UTC (V20). 확인 15번(분석 API 성능)은 기준을 넘어 5.3 의 1분 분배 분석 호출 방식이 아직 열려 있다.
- v5.5: S4 보안 리뷰 반영. Workers 조합의 요청 수 제한 저장소도 DB(`rate_limit`)로 바꾼다 (KV 아님).
- v5.4: S2 리뷰 반영. Docker 조합의 요청 수 제한 저장소를 Better Auth `rateLimit` storage `"database"`(`rate_limit` 테이블)로 확정하고, 스키마를 바꾸는 Better Auth 옵션을 스키마 생성기와 공유한다. MySQL 계열 시각은 `DATETIME(3)`, 토큰·식별자 칼럼은 `utf8mb4_bin`.
- v5.3: S1 Better Auth 확인 반영 (V17·V26). SQLite 드라이버를 libsql로 고정, Drizzle 어댑터 `transaction: true` 필수, 권한 칼럼 입력 차단의 실제 동작.
- v5.2: S1 확인 결과 반영 (`../verify/`). 부트스트랩 API 확정(`POST /api/cli/connect`), 관리 토큰 `write` 범위와 그 권한 상승 한계, 키 끄기 즉시 반영, Caddy 허용 목록 9개, OmniRoute 필수 비밀 값은 `INITIAL_PASSWORD` 하나.
- v5.1: 지원 DB를 SQLite, MySQL, Postgres, D1 네 가지로 확정. 런타임 조합과 스키마 작성 규칙 추가.
- v5: 설계 검토(critic) 반영 + 범위 결정. 회원별 키 여러 개(관리자가 최대 개수 지정)와 "남은 한도 분배" 방식, Caddy 허용 목록, OmniRoute 부트스트랩, 권한 칼럼 입력 차단, 메일 없을 때 정책 제한, 키 목표 상태 계산, 세션 무효화 추가. 런타임은 Node(SQLite·Postgres)와 Workers(D1·Postgres)를 처음부터 지원. 부가기능은 2차로, SSO는 OIDC 먼저 SAML 다음.
- v4: 0단계 Better Auth 실측 반영. SSO 등록 권한·도메인 검사·비밀 값 암호화·SAML 검증 강화.
- v3: 0단계 OmniRoute 실측 반영. 앞단 프록시를 버리고 OmniRoute 키 직접 발급(A안)으로 변경.
- v2: 외부 사용자 허용, 오픈소스 전제, 자체 회원 + OIDC·SAML.
- v1: 팀 내부용, Workers + D1 전제.

근거 자료
- `../research/phase0-omniroute.md` — OmniRoute 3.8.51 실측
- `../research/phase0-better-auth.md` — better-auth 1.7.7, Keycloak 26.4.0 실측

## 1. 목표

OmniRoute를 LLM 게이트웨이로 그대로 쓰고, 그 위에 회원 기능을 얹는 오픈소스 프로젝트를 만든다.

- 누구나 자기 환경에 설치할 수 있다. 회원 앱은 Docker(Node)와 Cloudflare Workers에서 돌고, DB는 SQLite, MySQL, Postgres, D1을 지원한다.
- 자체 회원 기능(이메일·비밀번호)을 기본으로 제공한다.
- 운영자가 설정 화면에서 OIDC IdP를, 그다음 단계에서 SAML IdP를 연결할 수 있다.
- 외부 사용자 가입을 받을 수 있고, 가입 정책은 운영자가 고른다.
- 회원은 OmniRoute API 키를 여러 개 발급받을 수 있다. 최대 개수는 관리자가 회원별로 정한다.
- 회원은 자기 사용량을, 운영자는 전체 사용량을 화면에서 본다.
- 회원별 월 한도를 건다. 키가 여러 개여도 회원 단위로 지켜진다.

### 1차 범위 밖

- 형식 변환, 제공자 관리, 대체 라우팅, 요청 기록, 비용 계산, 요청 차단 — OmniRoute가 맡는다. 회원 앱은 OmniRoute 설정(키, 예산)을 바꿀 뿐 요청 경로에 끼지 않는다.
- 결제 연동 — OmniRoute 비용은 가격표 기반 추정치라 그대로 청구에 쓸 수 없다.
- 2차로 미루는 부가기능: 매직 링크, 회원별 모델 제한, 회원 앱 안의 가격표 편집 화면(1차는 OmniRoute 대시보드로 안내), CAPTCHA, 키별 분당 요청 수 제한.
- SCIM, 조직·팀 단위 멀티테넌시.
- 프롬프트·응답 본문 저장.

## 2. OmniRoute에서 확인한 사실

| 항목 | 결과 | 설계에 주는 영향 |
|---|---|---|
| 비용 헤더 | 비스트리밍만 정확. 스트리밍은 토큰·비용이 0 | 헤더를 쓰지 않는다 |
| 호출 로그 | 토큰(캐시 분리)·`apiKeyId` 있음, 비용 없음, 요청당 2줄 | "최근 요청" 목록에만 쓴다. 완료 기록만, 허용한 필드만 |
| 키별 분석 | `/api/usage/analytics?apiKeyIds=&startDate=&endDate=`가 스트리밍 포함 정확 | 사용량 화면과 한도 계산의 데이터 원천 |
| 키별 예산 | `/api/usage/budget`. 넘으면 `429 BUDGET_EXCEEDED`. 지출은 60초마다 기록 | 차단은 OmniRoute에 맡기고, 회원 앱은 키별 예산 값을 조정한다 (5.3) |
| 비용 | 토큰 × OmniRoute 가격표 추정치. 가격을 고치면 과거도 재계산 | 화면에 "추정 비용"으로 표시 |
| 키 관리 | `POST /api/keys`가 원문 키를 한 번 돌려줌. 이후 원문 노출 꺼짐 | 원문은 저장하지 않는다 |
| 관리 인증 | `oma_live_…` 접근 토큰(범위 `read`/`write`/`admin`). 비밀번호로 `POST /api/cli/connect`에서 발급. 키 생성·수정·삭제·예산·분석·로그는 `write`면 된다 (V10) | 서버 간 호출은 `write` 접근 토큰 |
| 키 끄기 | `PATCH isActive=false` 직후 요청부터 `403 permission_denied` (V11) | 발급·정지 순서에 지연을 둘 필요 없음 |
| 키 없는 `/v1` | Docker 이미지 3.8.51은 `REQUIRE_API_KEY=true`가 기본이라 `401`. 문서상 기본값은 `false` | Compose에 명시하고 계약 테스트로 검사 |
| `/v1` 아래 관리 경로 | 루트 `/v1/*`는 `/api/v1/*` 전체의 별칭. `/v1/management/*`·`/v1/agents/*`는 회원 키로 `403`이지만 `/v1/registered-keys`, `/v1/combos`, 한도 조회, `/v1/explain/routing`, `/v1/vscode/*` 등은 **회원 키로 200** (V16) | Caddy는 허용 목록 9개만 연다 (7장) |
| Claude Code | 루트 `/v1/messages` | 허용 목록에 포함 |
| 저장소 | SQLite(WAL). 단일 인스턴스 | OmniRoute는 항상 상시 서버 1대 |

## 3. 구조 (A안: OmniRoute 키 직접 발급)

```
회원 도구 ─(OmniRoute 키)─▶ Caddy ─ 허용 목록 경로만 ─▶ OmniRoute ─▶ 제공자
                             │                             ▲
브라우저 ─(세션)─────────────┴─▶ 회원 앱 (이 프로젝트) ────┘ 관리 API (oma_live_ 토큰)
IdP ◀──(OIDC/SAML)──▶            ├ 인증 (Better Auth)
                                 ├ 키 발급·정지 → /api/keys
                                 ├ 예산 조정 → /api/usage/budget
                                 ├ 사용량 화면 ← /api/usage/analytics
                                 └ DB: 회원, 키 매핑, 설정, 작업 큐, 감사 로그
```

- 요청 경로에 우리 코드가 없다. 회원 도구는 Caddy를 거쳐 OmniRoute에 바로 붙는다.
- Caddy는 허용 목록에 있는 `/v1` 경로만 OmniRoute로 넘기고, 그 밖의 `/v1/*`는 `404`를 돌려준다. 나머지 경로는 회원 앱으로 보낸다. OmniRoute 대시보드와 `/api/*`는 외부에서 닿지 않는다.
- 회원 앱은 관리 API를 내부망(Docker) 또는 보호된 별도 경로(Workers, 3.3)로 호출한다.

A안을 고른 이유
- OmniRoute가 키별 기록·분석·예산 차단을 이미 정확히 한다 (실측).
- 스트림 파싱, 요청 기록, 비용 대조가 빠져서 만들 코드가 크게 준다.
- 요청 경로에 우리 코드가 없어 지연과 장애 지점이 늘지 않는다.

A안의 위험과 대응
- 분석·로그 API 응답 형식이 명세에 없다 → OmniRoute 버전 고정, 계약 테스트, `omniroute/` 어댑터 한곳 집중.
- 회원 앱이 멈춰도 API 사용은 계속된다. 정지·한도 반영은 OmniRoute 호출이 성공해야 완료로 본다 → 즉시 실행, 짧은 재시도, 5분마다 정합성 점검 (5.7).
- 요청 단위 통제가 필요해지면 C안(얇은 프록시)을 Caddy 자리에 끼울 수 있다. 회원 앱 구조는 바뀌지 않는다.

### 3.1 기술 선택

| 영역 | 선택 | 이유 |
|---|---|---|
| 서버 프레임워크 | Hono | Node, Bun, Workers에서 같은 코드가 돈다 |
| 인증 | Better Auth + `@better-auth/sso` | 이메일·비밀번호, 이메일 인증, OIDC, SAML을 한 라이브러리에서 제공. SSO 제공자를 DB에 실행 중 등록할 수 있다 |
| ORM | Drizzle | SQLite, MySQL, Postgres, D1을 모두 지원. Better Auth Drizzle 어댑터가 네 DB를 지원한다 |
| 리버스 프록시 | Caddy | 설정이 짧고 HTTPS 인증서를 자동으로 받는다 |
| 웹 화면 | SvelteKit SPA 모드 (`adapter-static`, `ssr = false`), Svelte 5 | 정적 파일로 빌드해 Node(Hono가 제공)와 Workers 정적 자산 양쪽에 같은 결과물로 배포. 라우팅·레이아웃 기본 제공. 서버 기능은 쓰지 않아 Hono와 역할이 겹치지 않음. 코드 기준은 `frontend-fundamentals` 스킬 |
| 언어 | TypeScript | |
| 라이선스 | MIT (OmniRoute와 같게) | |

SAML·OIDC 프로토콜은 직접 구현하지 않는다.

### 3.2 실행 환경

처음부터 아래 조합을 지원한다. CI에서 조합마다 같은 테스트를 돌린다.

| 조합 | 회원 앱 | 회원 앱 DB | 작업 실행 | 요청 수 제한 저장소 |
|---|---|---|---|---|
| Docker + SQLite (기본) | Node 컨테이너 1개 | SQLite 파일 (libSQL `@libsql/client`) | 프로세스 안 스케줄러 | DB (`rate_limit`) |
| Docker + MySQL | Node 컨테이너 (여러 개 가능) | MySQL 8.0+ / MariaDB 10.11+ (InnoDB) | 프로세스 안 스케줄러 + DB 임대 잠금 | DB (`rate_limit`) |
| Docker + Postgres | Node 컨테이너 (여러 개 가능) | Postgres 14+ | 프로세스 안 스케줄러 + DB 임대 잠금 | DB (`rate_limit`) |
| Workers + D1 | Workers | D1 | Cron Trigger | DB (`rate_limit`) |
| Workers + MySQL | Workers | MySQL (Hyperdrive) | Cron Trigger | DB (`rate_limit`) |
| Workers + Postgres | Workers | Postgres (Hyperdrive) | Cron Trigger | DB (`rate_limit`) |

요청 수 제한 저장소가 모든 조합에서 DB 인 이유 (v5.5)
- Better Auth `rateLimit.storage` 는 스키마를 바꾸는 옵션이라 `AUTH_SCHEMA_OPTIONS` 에 `"database"` 로 고정했다. 런타임마다 다르게 두면 스키마 생성기와 실제 구성이 어긋난다 (TC-S3.T1.e).
- KV 는 결과적 일관성이라 지역이 다른 요청이 같은 키를 동시에 읽고 쓰면 횟수를 잃는다. 비밀번호 대입을 막는 한도에는 DB 의 원자적 갱신이 맞다.

DB 지원 원칙
- DB 종류는 환경 변수 `DATABASE_URL`의 형식(`file:`, `mysql://`, `postgres://`)이나 Workers 바인딩(D1)으로 고른다.
- Drizzle 스키마는 DB별로 세 벌(`sqlite`·`mysql`·`pg`, D1은 `sqlite` 공유)을 두되, 테이블·칼럼 이름과 의미는 같게 유지한다. 공통 스키마 정의에서 세 벌을 만들어 어긋나지 않게 한다.
- 마이그레이션도 DB별로 생성해 저장소에 넣는다. CI에서 빈 DB에 마이그레이션을 적용하는 테스트를 DB마다 돌린다.
- 스키마 작성 규칙 (네 DB 공통으로 동작하게)
  - 문자열 기본 키·고유 키는 `VARCHAR(n)`로 길이를 정한다 (MySQL은 길이 없는 `TEXT`에 기본 키·인덱스를 못 건다). id는 `VARCHAR(36)`.
  - 참·거짓은 Drizzle boolean으로 정의한다 (SQLite·D1은 정수, MySQL은 `TINYINT(1)`, Postgres는 `BOOLEAN`).
  - 시각은 UTC ISO 문자열 또는 DB별 timestamp 중 하나로 통일한다 (Better Auth 어댑터 규칙에 맞춤, 8장 확인 26번).
  - JSON 값은 문자열로 저장하고 앱에서 파싱한다. DB별 JSON 연산은 쓰지 않는다.
  - 금액은 `REAL` 대신 소수 자리를 정한 `DECIMAL(12,6)`(SQLite·D1은 실수)로 둔다.
  - 대소문자 구분: 이메일은 소문자로 바꿔 저장한다. MySQL 기본 정렬 규칙은 대소문자를 구분하지 않아 다른 DB와 결과가 달라질 수 있다.
  - SQLite 드라이버는 libSQL만 쓴다. better-sqlite3는 트랜잭션이 동기 전용이라 Better Auth 트랜잭션 경로에서 500이 나고, 그러면서도 user 행이 남아 원자성이 깨진다 (V26).
  - Better Auth Drizzle 어댑터는 네 DB 모두 `drizzleAdapter(db, { transaction: true })`. 기본값 false면 SSO 로그인이 `SSO_USER_RESOLUTION_REQUIRES_NATIVE_TRANSACTIONS`로 거부된다 (V26).
  - Better Auth는 이메일을 소문자로 바꿔 저장한다. Better Auth를 거치지 않고 이메일을 쓰거나 찾는 우리 코드도 같은 규칙을 따른다. 직접 넣으면 SQLite·Postgres는 대소문자 중복을 받고 MySQL·MariaDB는 정렬 규칙 때문에 거부해 DB마다 결과가 달라진다 (V26).
  - 요청 수 제한: Docker 조합은 Better Auth `rateLimit: { storage: "database" }`로 `rate_limit` 테이블에 센다. 여러 인스턴스가 한도를 함께 센다. 스키마를 바꾸는 Better Auth 옵션(추가 칼럼, 플러그인, `rateLimit` 저장소)은 `packages/db/src/auth-options.ts` 한 곳에 두고 스키마 생성기와 Better Auth 구성이 같이 쓴다.
  - 시각 칼럼은 MySQL·MariaDB에서 `DATETIME(3)`로 둔다. `TIMESTAMP`는 2038-01-19 이후 값을 거부한다. 값은 UTC로 쓰고 읽는다.
  - 정확히 같아야 하는 토큰·해시·식별자 칼럼(세션 토큰, 초대 토큰 해시, OmniRoute 키 id, SSO 제공자 id, 인증 식별자, 계정 id 등)은 MySQL·MariaDB에서 `utf8mb4_bin` 정렬로 만든다. 기본 정렬은 대소문자를 무시해 다른 DB와 결과가 달라진다. 인덱스가 걸린 `VARCHAR`는 utf8mb4 기준 3072바이트(768자) 안에 둔다.
  - 트랜잭션: SQLite(libSQL)·MySQL(InnoDB)·Postgres는 대화형 트랜잭션을 쓴다. D1만 배치(batch)로 대신하고, 트랜잭션이 꼭 필요한 기능은 D1에서 따로 처리한다 (아래 D1 제약).

- OmniRoute는 어느 조합이든 상시 서버 1대(Docker)에서 돈다. Workers 조합은 회원 앱만 Workers로 옮긴 형태다.
- 플랫폼 의존 코드는 `src/runtime/` 어댑터로 모은다: DB 연결, 작업 스케줄, 요청 수 제한 저장소, 비밀 값 읽기, 클라이언트 IP 얻기.
- 여러 인스턴스(MySQL·Postgres)에서는 작업이 중복 실행되지 않게 `job_leases` 테이블로 임대 잠금을 건다 (5.9).
- **D1 제약**: D1은 대화형 트랜잭션이 없어 Better Auth `resolveUser`(SSO 도메인 검사·역할 계산에 쓰는 훅)를 쓸 수 없다. 대체 수단(8장 확인 22번)이 검증되기 전까지 D1 조합에서는 SSO 설정 화면을 잠근다. 검사를 못 하는 채로 SSO를 여는 것보다 기능을 막는 쪽이 안전하다.

### 3.3 회원 앱 ↔ OmniRoute 연결

| 조합 | 연결 방식 |
|---|---|
| Docker | Compose 내부망으로 `http://omniroute:20128`. OmniRoute 포트는 외부에 열지 않는다 |
| Workers | Caddy에 관리용 호스트를 따로 두고, 회원 앱만 아는 비밀 헤더가 있을 때만 `/api/*`를 넘긴다. Cloudflare Tunnel로 서버 포트를 열지 않는 방식을 문서로 안내한다. 세부 방식은 8장 확인 24번 |

## 4. 인증과 회원

### 4.1 로그인 방식

| 방식 | 기본값 | 단계 |
|---|---|---|
| 이메일 + 비밀번호 | 켜짐 | 1단계. 가입, 이메일 인증, 비밀번호 재설정 |
| OIDC | 없음 | 5단계. 설정 화면에서 추가. Google Workspace, Okta, Entra ID, Keycloak, Authentik 등 |
| SAML 2.0 | 없음 | 6단계. 설정 화면에서 추가 |
| 이메일 매직 링크 | — | 2차 |

로그인 화면 동작
- 연결된 IdP 중 "로그인 화면에 버튼 표시"를 켠 것은 버튼으로 보여준다.
- 이메일을 먼저 입력받아, 도메인이 특정 IdP에 묶여 있으면 그 IdP로 보낸다.
- 운영자가 "SSO만 허용"을 켜면 비밀번호 로그인을 숨긴다. 비상용으로 최초 관리자 계정의 비밀번호 로그인은 남긴다 (`/login?local=1`).

### 4.2 가입 정책

| 정책 | 동작 | 메일 설정 필요 |
|---|---|---|
| `invite_only` | 운영자 초대 링크로만 가입 (기본값) | 아니요 (링크를 화면에서 복사) |
| `open` | 누구나 가입 | **예** |
| `domain_allowlist` | 허용한 이메일 도메인만 가입 | **예** |
| `sso_only` | 로컬 가입 막음. IdP 로그인 시 자동 생성(JIT) | 아니요 |
| `closed` | 신규 가입 막음 | 아니요 |

- 메일이 설정되지 않았으면 `open`·`domain_allowlist`를 고를 수 없다. 이메일 인증 없이는 도메인 제한도, "인증 후 키 발급"도 의미가 없기 때문이다.
- 기본값이 `invite_only`인 이유: 설치 직후 모르는 사람이 가입해 운영자 비용을 쓰는 일을 막는다.

`open`일 때 남용 방지
- 이메일 인증을 마쳐야 키를 발급할 수 있다.
- 가입 직후 상태는 기본 `pending`(운영자 승인 필요). 운영자가 설정에서 끌 수 있다.
- 신규 회원 기본 월 한도 (설정값, 기본 $5)와 기본 최대 키 개수 (설정값, 기본 2).
- 하루 가입 수 상한 (설정값, 기본 20). 넘으면 그날 가입을 막고 운영자에게 알린다.
- CAPTCHA는 2차.

초대
- 초대 링크는 역할과 만료 시각을 가진다.
- **관리자 역할 초대는 이메일 지정이 필수다.** 이메일이 없는 링크는 `member` 역할로만 만들 수 있다. 링크가 새어도 관리자 권한이 넘어가지 않게 한다.

### 4.3 SSO 제공자 설정 화면

관리자가 설정 → 인증 → "IdP 추가"에서 입력하는 값:

**공통**
- 표시 이름, 로그인 버튼 표시 여부, 켜기/끄기
- 연결할 이메일 도메인 (여러 개)
- JIT 생성 여부, 새 회원 기본 역할, 기본 월 한도, 기본 최대 키 개수
- 역할 매핑: 그룹 클레임·속성 이름, 관리자로 매핑할 그룹 값

**OIDC (5단계)**
- Issuer URL (discovery 문서로 엔드포인트 자동 채움)
- Client ID, Client Secret
- Scope (기본 `openid email profile`)
- PKCE 사용 (기본 켜짐)

**SAML (6단계)**
- IdP 메타데이터 URL 또는 XML 업로드
- 이메일·이름 속성 매핑
- 서명된 Assertion 요구: 항상 켜짐, 끄는 옵션 없음 (`wantAssertionsSigned: true`를 우리가 넣는다. Better Auth 기본값은 꺼짐)
- SP 서명키: 자동 생성(기본) 또는 업로드. IdP가 서명된 AuthnRequest를 요구하면(`WantAuthnRequestsSigned="true"`, Keycloak 기본) 키 없이는 로그인 시작부터 실패한다

**우리 쪽 값 (복사 버튼으로 표시)**
- OIDC Redirect URI
- SAML SP Entity ID, ACS URL, SP 메타데이터 URL

저장 뒤 "연결 테스트" 버튼으로 IdP 왕복 로그인을 해보고, 받은 클레임·속성을 보여준다.

등록 방식과 차단
- 등록·수정·삭제는 관리자 설정 화면의 서버 API에서 `auth.api.registerSSOProvider` 등을 호출해서만 한다. 우리 쪽 추가 설정은 `sso_provider_settings`에 둔다.
- **`@better-auth/sso`를 설치하는 순간부터** Better Auth의 공개 SSO 관리 경로를 모두 `disabledPaths`로 막는다: 등록(`/sso/register`), 수정, 삭제, 도메인 검증 경로. 정확한 경로 목록은 8장 확인 23번. 기본값은 로그인한 누구나 IdP를 등록할 수 있고, 0단계에서 이 경로로 기존 관리자 계정을 가로채는 데 성공했다.
- 그룹 클레임 이름을 `mapping.extraFields`에 자동으로 넣는다. 넣지 않으면 그룹 정보가 오지 않는다.
- SAML 그룹은 하나면 문자열, 여럿이면 배열로 온다. 항상 배열로 바꿔서 다룬다.
- 등록 API 응답에서 `clientSecret` 등 비밀 값을 지우고 돌려준다.

### 4.4 계정 연결

- IdP가 보낸 이메일을 믿는 조건: 그 IdP에 연결된 도메인의 이메일일 때만.
  - Better Auth는 이 검사를 하지 않는다 (0단계 실측). `resolveUser`에서 이메일 도메인이 IdP 도메인 목록에 없으면 `reject`한다. 실측으로 막히는 것을 확인했다.
  - D1 조합의 대체 수단은 3.2 참고.
- 기존 로컬 계정과 연결(`link`)하는 조건: 위 도메인 검사 통과 **그리고** 로컬 계정이 이메일 인증을 마친 상태(`emailVerified = true`).
  - 공격자가 피해자 이메일로 로컬 계정을 먼저 만들어 두고, 피해자가 나중에 IdP로 로그인할 때 그 계정에 붙는 선점 공격을 막는다.
  - 인증 안 된 로컬 계정이 있으면 연결하지 않고, 회원에게 "로컬 계정 이메일 인증 후 연결"을 안내한다.
- `trustEmailVerified`는 켜지 않는다.
- 회원은 내 정보 화면에서 연결된 로그인 방식을 보고 끊을 수 있다. 마지막 남은 로그인 방식은 끊을 수 없다.

### 4.5 역할과 세션

| 역할 | 권한 |
|---|---|
| `member` | 자기 키·사용량 |
| `admin` | 전체 회원·사용량, 설정, IdP 관리 |

- IdP 역할 매핑은 로그인할 때마다 다시 계산한다. 최초 관리자는 매핑 결과와 관계없이 `admin`을 유지한다.
- 구현: `resolveUser`(트랜잭션 안, 원본 클레임 수신)에서 도메인 검사와 함께 역할을 계산한다. `provisionUser` + `provisionUserOnEveryLogin: true` 경로를 쓸 때는 세션이 생긴 뒤 실행되므로, 역할 갱신이 실패하면 방금 만든 세션을 무효화한다.
- **세션 무효화**: 다음 경우에 해당 회원의 모든 세션을 지운다.
  - 역할 변경, 정지, 탈퇴
  - IdP 삭제·비활성화 (그 IdP로 만든 세션)
  - 비밀번호 변경 (현재 세션 제외)

### 4.6 권한 칼럼 보호

- Better Auth `user` 테이블에 더하는 칼럼(`role`, `status`, `monthly_limit_usd`, `max_keys`, `is_bootstrap_admin`)은 모두 `input: false`로 둔다. Better Auth 추가 칼럼은 기본이 입력 허용이라, 지정하지 않으면 가입·회원정보 수정 요청 본문에 `role=admin`을 넣어 관리자가 될 수 있다.
- 실제 동작 (V17): 회원정보 수정은 다섯 칼럼 모두 `400 FIELD_NOT_ALLOWED`. 가입은 기본값이 있는 칼럼(`role`, `status`, `is_bootstrap_admin`)을 조용히 기본값으로 바꿔 200, 기본값이 없는 칼럼(`monthly_limit_usd`, `max_keys`)은 400. 어느 경우든 DB에는 기본값이 남는다.
- 이 칼럼은 관리자 API에서만 바꾼다. 회귀 테스트는 칼럼마다 따로 보내 "200 + 기본값 유지" 또는 "400 + 계정 미생성"을 통과로 본다.

### 4.7 최초 설치

Compose 설치용 스크립트(`./setup.sh` 또는 `npx <이름> init`)가 `.env`를 만든다.
- OmniRoute `INITIAL_PASSWORD`(유일한 필수 값)와, OmniRoute가 비어 있으면 자동 생성해 데이터 볼륨에 저장하는 `JWT_SECRET`(32자 이상)·`API_KEY_SECRET`(16자 이상)·`STORAGE_ENCRYPTION_KEY`·`OMNIROUTE_WS_BRIDGE_SECRET`를 모두 무작위로 만들어 `.env`에 고정한다 (V21). 자동 생성에 맡기면 볼륨을 잃거나 나중에 다른 `STORAGE_ENCRYPTION_KEY`를 넣었을 때 OmniRoute가 시작을 거부한다. 이 밖에 `APP_ENCRYPTION_KEY`, Better Auth 비밀 값.
- `REQUIRE_API_KEY=true`를 명시한다.

설치 흐름
1. 회원 앱이 처음 뜨면 콘솔에 일회용 설치 토큰을 출력한다.
2. `/setup`에서 토큰을 넣고 최초 관리자 계정을 만든다.
3. **OmniRoute 부트스트랩**: 회원 앱이 `POST /api/cli/connect {password: INITIAL_PASSWORD, name, scope: "write", expiresInDays}`로 `oma_live_` 접근 토큰을 만들고 암호화해 저장한다 (V10). 범위 확인은 `GET /api/cli/whoami`. 사람이 OmniRoute 대시보드에 들어가지 않아도 된다. Workers 조합처럼 자동으로 못 하는 경우에는 토큰을 직접 붙여 넣는다.
4. 회원이 도구에 넣을 공개 주소를 입력한다.
5. 메일 발송 설정 (선택). 설정하지 않으면 가입 정책 선택지가 줄어든다 (4.2).
6. 제공자(상위 LLM API 키) 등록 안내: OmniRoute 대시보드는 외부에 열리지 않으므로, Compose가 대시보드를 `127.0.0.1:20128`에만 묶어 두고 SSH 터널로 접속하는 방법을 화면과 문서로 안내한다.

### 4.8 메일 발송

1단계부터 어댑터로 둔다: SMTP, Resend, Cloudflare Email Service, 콘솔 출력(개발용). 설정 화면에서 고르고 테스트 메일을 보낼 수 있다.

## 5. OmniRoute 연동

### 5.1 회원 도구 설정

키 관리 화면에서 도구별 설정 예시를 보여준다.
- Claude Code: `ANTHROPIC_BASE_URL=https://<공개 주소>`, `ANTHROPIC_AUTH_TOKEN=<회원 키>`
- OpenAI 호환 도구: base URL `https://<공개 주소>/v1`, API 키 `<회원 키>`

### 5.2 키 수명주기

최대 개수
- 회원별 최대 키 개수 = `user.max_keys`, 비어 있으면 설정의 기본값(`default_max_keys`).
- 활성·비활성 키를 합쳐 센다. 삭제한 키는 세지 않는다.
- 관리자는 회원 관리 화면에서 회원별로 바꿀 수 있다. 줄였을 때 이미 가진 키는 그대로 두고 새 발급만 막는다.

발급 순서 (중간에 실패해도 한도 없는 키가 켜진 채 남지 않게)
1. 회원 상태 `active`, 이메일 인증, 최대 개수, 남은 한도 > 0 확인. 남은 한도가 0이면 발급을 거부한다.
2. `POST /api/keys`로 생성
3. 즉시 `PATCH isActive=false`
4. 예산 설정 (5.3의 계산식)
5. `PATCH isActive=true`
6. 원문을 화면에 한 번만 표시
- 2~5 중 하나라도 실패하면 만든 키를 `DELETE`로 되돌리고 오류를 보여준다. 되돌리기도 실패하면 작업 큐에 넣는다. (원문이 회원에게 가기 전이라 아래 "삭제"의 60초 규칙이 필요 없다.)
- 발급·재발급 요청 수 제한: 회원당 1시간 10회, 클라이언트 IP 당 1시간 30회. 넘으면 `429` (7장, Q4). 저장소는 `rate_limit` 테이블 (여러 인스턴스 공유).

그 밖의 동작
| 동작 | OmniRoute 호출 |
|---|---|
| 이름 변경 | 없음 (우리 DB만) |
| 끄기·켜기 | `PATCH isActive` (켜기는 목표 상태가 활성일 때만, 5.7) |
| 재발급 | 새 키 발급(위 순서) + 옛 키 삭제(아래). `regenerate`는 쓰지 않는다 (아래 이유) |
| 삭제 | 즉시 `PATCH isActive=false`, 끈 뒤 60초가 지나면 `DELETE /api/keys/{id}` (작업 큐 `key.delete`, 끈 시각 + 2분). 매핑은 `deleted_at`만 남기고 지우지 않는다 |
| 회원 정지·탈퇴 | 5.7의 목표 상태 계산으로 모든 키 끄기·삭제 (삭제는 위 순서) |

삭제·재발급 순서의 이유 (8장 확인 18·19번, OmniRoute 3.8.51 실측)
- `DELETE`와 `regenerate` 직후 최대 60초 동안 옛 원문 키가 그대로 통과한다 (키 검증 캐시). 그 요청은 키 id 없이 기록돼 회원 사용액에도, 예산에도 잡히지 않는다. 예산 차단 중인 키도, 꺼 둔 키도 `regenerate`하면 옛 원문 키가 다시 통과한다.
- `PATCH isActive=false`는 바로 막는다(403, 확인 11번). 끈 상태로 60초가 지나면 옛 원문 키는 401 이고, 그 뒤 `DELETE`해도 다시 열리지 않는다.
- 그래서 삭제는 "끄기 → 60초 이상 기다림 → `DELETE`"이고, 재발급은 같은 id 를 살리는 `regenerate` 대신 새 id 의 키를 발급하고 옛 키를 같은 순서로 지운다. 옛 id 의 사용액은 삭제한 키처럼 회원 사용액에 남는다 (5.3).
- 재발급은 발급과 같은 조건을 본다(남은 한도 > 0 등). 최대 개수는 지울 옛 키를 빼고 센다.

- OmniRoute 키 이름은 `m_<회원 id 앞 8자리>_<키 id 앞 8자리>`. 이메일 같은 개인정보를 넣지 않는다.
- 원문 키는 저장하지 않는다. `omniroute_key_id`와 끝 4자리만 둔다.

### 5.3 회원 단위 한도 — 남은 한도 분배

OmniRoute 예산은 키 단위다. 회원이 키를 여러 개 가져도 회원 한도를 지키기 위해, 회원 앱이 각 키의 예산 값을 계속 조정하고 실제 차단은 OmniRoute가 한다.

계산 (회원마다)
```
회원 이번 달 사용액 = Σ usage_daily(회원의 모든 키, 삭제한 키 포함, 이번 달 1일 ~ 어제).cost_usd
                    + 오늘 창 analytics(오늘 00:00 UTC ~ 지금).byApiKey 중 회원의 키 cost
남은 한도         = max(월 한도 − 회원 이번 달 사용액, 0)
남은 한도 > 0 이면  키별 월 예산 = 그 키의 이번 달 사용액 + 남은 한도
남은 한도 = 0 이면  회원의 키를 끈다 (disabled_reason = limit, 5.7)
```
- 각 키는 "남은 한도"만큼만 더 쓸 수 있다. 어느 키로 쓰든 회원 전체가 한도에 닿으면 모든 키를 끈다.
- 남은 한도 0 에서 예산 대신 키를 끄는 이유 (Q1, 8장 확인 20번): OmniRoute 는 예산 0 을 무제한으로 보고, 사용액 > 예산일 때만 막는다(같으면 요청 하나가 더 통과한다). 그래서 "키 사용액 + 0" 예산으로는 사용액 0 인 키를 막지 못하고, 사용액이 있는 키도 한 번 더 통과한다. 끄기는 바로 막는다 (확인 11번).
- 남은 한도가 다시 0보다 커지면(새 달, 관리자가 한도를 올림) `limit` 때문에 꺼진 키만 예산을 먼저 건 뒤 다시 켠다. 회원·관리자가 끈 키는 그대로 둔다.
- 삭제한 키의 사용액도 회원 사용액에 들어가므로, 키를 지우고 다시 받아도 한도가 초기화되지 않는다 (삭제한 키 기록이 분석에 남는다, 확인 18번).
- 월 한도가 비어 있으면(무제한) 예산을 걸지 않는다.
- 달은 UTC 로 자른다. OmniRoute 월 예산도 매달 1일 00:00 UTC 에 초기화된다 (확인 20번).

실행 시점
- 키 발급·재발급 직후, 관리자가 한도를 바꾼 직후
- 1분마다 전체 회원 (활성 키가 있는 회원과 `limit` 때문에 꺼진 키가 있는 회원)
- 새 달: 1분 분배가 `app_settings`에 남긴 마지막 실행 달(UTC)과 지금 달을 비교해, 바뀌었으면 그 실행에서 새 달 기준으로 다시 계산한다 (`limit`으로 꺼진 키 다시 켜기 포함). 월간 cron 은 따로 두지 않는다 (Q5. `cronIntervalMinutes`가 "0 0 1 * *"를 받지 않는다)

분석 호출 (확인 15번: 기록 300,000·키 300 에서 필터 없는 한 달 호출은 CI x64 p95 5.6~6.4초라 1분마다 부르기에 느리다)
- 1분 분배는 오늘 창 하나만 부른다: `analytics(startDate = 오늘 00:00 UTC, endDate = 지금)`, `apiKeyIds` 없이 전체 키 한 번, `byApiKey`를 매핑으로 회원별로 묶는다. 하루 분량이라 기록 수가 늘어도 빠르다 (측정 기준 p95 ≤ 2,000ms).
- 지난 날 몫은 우리 DB `usage_daily`(키·날짜별 비용, 5.9)에 둔다. 키는 OmniRoute 키 id 이고 매핑에 있는 키만 둔다 (삭제한 키 포함).
- 날 확정: 날이 바뀐 뒤 처음 도는 분배가 어제 창(어제 00:00 ~ 오늘 00:00 UTC)을 한 번 불러 어제 값을 저장한다. 마지막으로 확정한 날은 `app_settings.usage_daily_confirmed`에 둔다.
- 하루 한 번 대조: 같은 첫 분배가 이번 달 1일 ~ 어제를 다시 불러 저장값을 덮는다. 분석 비용은 조회 시점 가격표로 계산돼 가격표가 바뀌면 지난 날 값도 바뀌기 때문이다. 저장값과 다르면(키·날마다 차이 > 0.000001) `audit_log`에 `alert.usage_drift`(차이 난 키·날 수와 합계)를 남긴다. 이 호출은 느려도 되지만 임대(55초) 안에 끝나야 한다 (측정: 가장 나쁜 경우인 지난 29일 p95 ≤ 55,000ms). 한 번 호출이 어댑터 제한 시간에 걸리면 그 실행은 대조를 멈추고, 다음 실행부터 날 단위로 나눠 하루씩 부른다 (진행한 날을 `app_settings`에 남김).
- 즉시 분배(발급·재발급·한도 변경 직후)는 그 회원 키의 저장값 합 + 오늘 창(`apiKeyIds` = 그 회원 키)으로 계산한다.

한계 (문서에 적는다)
- OmniRoute 지출은 60초마다 기록되고 예산 조정도 1분 주기라, 짧은 시간에 몰아 쓰면 한도를 넘을 수 있다. 최악의 경우 대략 "남은 한도 × 동시에 쓰는 키 수"까지 넘는다. 최대 키 개수가 이 폭을 제한한다.
- 동시에 보낸 요청은 지출이 반영되기 전에 모두 예산 검사를 통과하므로, 한도에 닿는 순간 진행 중이던 요청만큼("동시 요청 수 × 요청 비용") 더 넘을 수 있다.
- 분석·날 확정 호출이 실패하는 동안 분배는 예산을 고치지 않는다(fail-closed). 그동안 한도 반영은 실패한 기간만큼 늦는다. 10분 넘게 이어지면 관리자에게 알린다(`alert.rebalance_stalled`, 하루 한 번).
- 비용은 OmniRoute 가격표 추정치 기준이다.
- 날 경계 (UTC 자정 직후 몇 분): 자정 직전에 시작해 자정 뒤에 기록되는 요청이 있다 (OmniRoute 지출 기록 60초 지연). 그 기록의 시각이 어제면, 어제를 확정한 뒤 들어온 몫은 저장값에도 오늘 창에도 없다. 다음 날 대조 전까지(최대 하루) 회원 사용액에서 빠진다. 크기는 대략 회원의 "자정 전후 1분 사용량"이고, 그만큼 한도를 더 쓸 수 있다.
- 가격표 반영: 가격표가 바뀌어도 지난 날 저장값은 다음 날 첫 대조 전까지(최대 하루) 옛 가격 그대로다. 오늘 창은 바로 새 가격이다.

OmniRoute 쿼터 풀 일정 예산은 배정된 키 여럿의 소비를 합쳐 막는다(8장 확인 12번). 하지만 풀은 제공자 연결 하나에 묶여 다른 제공자로 가는 요청을 합치지 못하고, 창이 달력 월이 아닌 슬라이딩이며, 3.8.51 은 차단을 본문 없는 500 으로 낸다. 회원 한도로 쓰지 않고 분배를 유지한다. 키 그룹(`/api/keys/groups`)은 모델 허용·차단 전용이다.

### 5.4 사용량 조회

| 화면 | OmniRoute 호출 |
|---|---|
| 내 사용량 | `GET /api/usage/analytics?apiKeyIds=<회원의 키 id들, 삭제한 키 포함>&startDate&endDate` → `summary`, `dailyTrend`, `byModel` |
| 키별 사용량 | 같은 응답의 `byApiKey` |
| (1분 분배) | `GET /api/usage/analytics?startDate=<오늘 00:00 UTC>&endDate=<지금>` → `byApiKey`. 지난 날 몫은 `usage_daily` (5.3) |
| 최근 요청 | `GET /api/usage/call-logs?apiKey=<키 id>` → 완료 기록만. `apiKey`는 이름·id 부분 일치라 어댑터가 `apiKeyId`로 다시 정확히 거른다 (확인 13번) |
| 전체 현황 | `GET /api/usage/analytics` → `byApiKey`를 매핑으로 회원 단위로 묶음 |

- 회원에게 보내는 필드는 허용 목록으로 거른다: 시각, 모델, 상태, 입력·출력·캐시 토큰, 소요 시간. `account`, `connectionId`, `provider`, `error` 원문은 운영자 계정·제공자 정보가 드러날 수 있어 보내지 않는다.
- 응답을 60초 캐시한다. 캐시 키에 회원 id와 기간을 넣는다.

### 5.5 비용 표시

- 화면에 "추정 비용"으로 쓰고, 무료·구독 제공자 요청에도 비용이 붙을 수 있다고 안내한다.
- 가격표는 OmniRoute 것 하나만 쓴다. Compose 기본값으로 `PRICING_SYNC_ENABLED=true`를 켠다.
- 1차에서 가격표 수정은 OmniRoute 대시보드로 안내한다 (SSH 터널).

### 5.6 OmniRoute 어댑터와 계약 테스트

- OmniRoute 호출은 `src/omniroute/` 한곳에서만 한다.
- 쓰는 응답 필드만 zod 스키마로 검사한다. 형식이 달라지면 조용히 틀린 값을 보여주지 않고 오류를 낸다.
- 계약 테스트: CI에서 고정 버전 OmniRoute 컨테이너와 가짜 상위 서버(0단계 `mock-upstream.mjs`)를 띄워 검사한다.
  - 키 없는 `/v1/models`·`/v1/chat/completions`는 `401`
  - 허용 목록 밖 `/v1/*`는 Caddy에서 `404`
  - 키 생성 → 끄기 → 예산 → 켜기 → 요청 → 분석·로그·예산 응답
  - 끈 키는 즉시 거부 (8장 확인 11번)
  - 예산 초과 시 `429 BUDGET_EXCEEDED`
- OmniRoute 버전을 올릴 때 이 테스트가 통과해야 한다.

### 5.7 키 목표 상태와 정합성

키가 OmniRoute에서 켜져 있어야 하는지는 여러 값으로 정해진다. 이를 한 함수로 계산한다.

```
입력: 키 state·disabled_reason, 회원 status, 회원 남은 한도(5.3, 월 한도가 비어 있으면 무제한)
목표 = 삭제됨     (키 state = deleted 또는 회원 status = deleted)
     | 꺼짐       (회원 status ≠ active
                   또는 키가 회원·관리자 때문에 꺼짐 (disabled_reason ∈ {member, admin})
                   또는 남은 한도 = 0)
     | 켜짐       (그 밖)
```
- `api_keys.disabled_reason`(`member` 회원이 끔 / `admin` 관리자가 끔 / `user_status` 회원 상태 때문 / `limit` 남은 한도 0 때문)을 기록한다. 회원 정지를 풀면 `user_status` 때문에 꺼진 키만, 남은 한도가 다시 0보다 커지면 `limit` 때문에 꺼진 키만 다시 켠다 (켜기 전에 예산을 먼저 건다, 5.3).
- 남은 한도가 0보다 큰 회원의 키는 키를 끄지 않고 키별 예산으로 막는다 (5.3).
- 삭제됨의 반영은 "끄기 → 끈 뒤 60초가 지나면 `DELETE`"다 (5.2).

반영
- 회원 정지·키 끄기·삭제의 끄기는 요청을 받은 즉시 OmniRoute에 반영한다. 실패하면 작업 큐에서 1분, 2분, 10분, 30분 간격으로 재시도한다 (Q2. 작업 실행기는 Node 타이머·Workers Cron 모두 최소 주기가 1분이라 1분보다 짧은 간격을 지킬 수 없다). 첫 시도는 요청 안에서 바로 한다.
- 4번째 재시도도 실패하면 작업을 `failed`로, 그 키의 `sync_state`를 `failed`로 두고 관리자에게 알린다 (`alert.job_failed`, Q3). 정합성 점검이 `failed` 키도 목표 상태로 계속 다시 맞춘다. `failed`로 30분이 지난 작업을 "오래 실패"로 본다 (관리 화면, 7단계).
- 반영이 끝나기 전까지 화면에 "반영 중"을 표시한다. 정지는 반영이 끝나야 "완료"로 본다.

정합성 점검 (5분마다)
- OmniRoute 키 목록을 읽어, 모든 키의 실제 상태를 목표 상태와 비교해 맞춘다. 회원 상태와 남은 한도도 함께 본다.
- 매핑에 없는 `m_` 접두사 키 → 관리자에게 알린다 (`alert.unknown_m_key`, 자동 삭제 안 함). 다만 `scopes`에 `manage`·`admin`이 붙은 키는 매핑이 없어도 끈다 (5.8).
- 오래 실패한 작업은 관리자 화면에 띄운다.

관리자 알림 (Q6)
- "관리자에게 알린다"는 `audit_log`에 action `alert.<종류>` 행을 쓰는 것이다 (`alert.unknown_m_key`, `alert.manage_scope_key`, `alert.job_failed`). `target`에 키·작업 id, `detail`에 OmniRoute 오류 코드·상태(비밀 값 제외). 알림을 보는 화면은 7단계다.

### 5.8 관리 토큰 범위

- 회원 앱이 쓰는 `oma_live_` 토큰은 `write` 범위로 만든다 (V10). `write`로는 제공자 연결 수정이 403이고 제공자 키는 가려져 나온다.
- **한계 (V10 실측)**: OmniRoute 3.8.51에서 `write` 토큰은 회원 키에 `scopes: ["manage"]`를 붙일 수 있고, 그 키로 `admin` 토큰을 만들 수 있다. 회원 앱이 뚫리면 결국 제공자 연결까지 넘어갈 수 있다는 뜻이라, `write` 범위는 실수 방지일 뿐 침해 시 피해를 줄여 주지 못한다. 문서(SECURITY.md)에 이 한계를 그대로 적는다.
- 대응
  - 회원 앱은 OmniRoute 키의 `scopes`를 절대 쓰지 않는다. 어댑터의 키 수정 함수는 `isActive`·이름만 보낸다 (5.6).
  - 정합성 점검(5.7)이 `m_` 키 중 `scopes`에 `manage`·`admin`이 있는 것을 찾으면 그 키를 끄고 관리자에게 알린다 (`alert.manage_scope_key`). 매핑이 없는 `m_` 키도 끈다(권한 상승을 열어 둘 이유가 없다). 매핑된 키는 꺼진 이유와 상관없이 `disabled_reason`을 `admin`으로 고정해 회원이 다시 켜지 못하게 한다.
  - OmniRoute 쪽에 "`write` 토큰이 키 범위를 올리지 못하게" 해 달라는 보고를 올린다 (공개 준비 단계).

### 5.9 데이터 모델

Better Auth 테이블(`user`, `session`, `account`, `verification`, `ssoProvider`, `rateLimit`)은 그대로 쓰고, `user`에 칼럼을 더한다. 사용량 데이터는 OmniRoute에 있으므로 우리 DB에 두지 않는다.

아래는 의미를 보여주는 SQLite 표기다. 실제 스키마는 3.2의 작성 규칙에 따라 Drizzle로 DB별로 만든다 (id는 `VARCHAR(36)`, 금액은 `DECIMAL(12,6)` 등).

```sql
-- Better Auth user 테이블 추가 칼럼 (additionalFields, 모두 input: false)
--   role               TEXT NOT NULL DEFAULT 'member'   -- member | admin
--   status             TEXT NOT NULL DEFAULT 'active'   -- pending | active | suspended | deleted
--   monthly_limit_usd  REAL                             -- NULL이면 무제한
--   max_keys           INTEGER                          -- NULL이면 설정 기본값
--   is_bootstrap_admin INTEGER NOT NULL DEFAULT 0

CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,           -- signup_mode, allowed_domains, default_limit_usd, default_max_keys,
                                         -- signup_requires_approval, daily_signup_cap, public_base_url,
                                         -- budget_rebalance_month (1분 분배의 마지막 실행 달, UTC "YYYY-MM", 5.3),
                                         -- usage_daily_confirmed (확정·대조한 마지막 날, UTC "YYYY-MM-DD", 5.3), ...
  value      TEXT NOT NULL,              -- JSON
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE sso_provider_settings (
  provider_id       TEXT PRIMARY KEY,    -- Better Auth ssoProvider.providerId
  display_name      TEXT NOT NULL,
  show_button       INTEGER NOT NULL DEFAULT 1,
  enabled           INTEGER NOT NULL DEFAULT 1,
  jit_enabled       INTEGER NOT NULL DEFAULT 1,
  default_role      TEXT NOT NULL DEFAULT 'member',
  default_limit_usd REAL,
  default_max_keys  INTEGER,
  group_claim       TEXT,
  admin_groups      TEXT                 -- JSON 배열
);

CREATE TABLE invites (
  id          TEXT PRIMARY KEY,
  email       TEXT,                      -- role = admin이면 NOT NULL (앱에서 검사)
  token_hash  TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL DEFAULT 'member',
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_by  TEXT NOT NULL
);

CREATE TABLE api_keys (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES user(id),
  omniroute_key_id TEXT NOT NULL UNIQUE,
  key_preview      TEXT NOT NULL,        -- 끝 4자리
  label            TEXT,
  state            TEXT NOT NULL,        -- active | disabled | deleted
  disabled_reason  TEXT,                 -- member | admin | user_status | limit
  sync_state       TEXT NOT NULL DEFAULT 'synced',  -- synced | pending | failed
  budget_usd       REAL,                 -- 마지막으로 OmniRoute에 건 월 예산
  created_at       TEXT NOT NULL,
  deleted_at       TEXT
);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);

CREATE TABLE usage_daily (               -- 지난 날 키별 비용 (5.3). 1분 분배는 오늘 창만 부르고 이것을 더한다
  key_id     TEXT NOT NULL,              -- OmniRoute 키 id (api_keys.omniroute_key_id, 삭제한 키 포함)
  day        TEXT NOT NULL,              -- UTC 날짜 YYYY-MM-DD
  cost_usd   REAL NOT NULL,              -- DECIMAL(12,6)
  updated_at TEXT NOT NULL,              -- 날 확정·대조 때 갱신
  PRIMARY KEY (key_id, day)
);

CREATE TABLE omniroute_jobs (
  id          TEXT PRIMARY KEY,
  action      TEXT NOT NULL,             -- key.apply_state, key.delete, budget.set, key.rollback, ...
  payload     TEXT NOT NULL,             -- JSON
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  next_run_at TEXT NOT NULL,
  done_at     TEXT,
  failed_at   TEXT                       -- 4번째 재시도 실패 시각 (5.7). 지금 − failed_at > 30분이면 오래 실패
);

CREATE TABLE job_leases (                -- 여러 인스턴스에서 주기 작업 중복 실행 방지
  name         TEXT PRIMARY KEY,         -- budget_rebalance, reconcile, ...
  holder       TEXT NOT NULL,
  locked_until TEXT NOT NULL
);

CREATE TABLE audit_log (
  id         TEXT PRIMARY KEY,
  actor_id   TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,                       -- JSON, 비밀 값 제외
  ip         TEXT,
  created_at TEXT NOT NULL
);
```

## 6. 화면

| 화면 | 보는 사람 | 내용 |
|---|---|---|
| 로그인·가입 | 모두 | 이메일·비밀번호, IdP 버튼, 이메일 도메인 기반 SSO 이동, 초대 수락 |
| 내 사용량 | 회원 | 이번 달 추정 비용과 한도 비율, 일별 추이, 모델별 비중, 최근 요청 |
| 키 관리 | 회원 | 발급(원문 한 번만, 남은 발급 가능 개수 표시), 이름 변경, 끄기, 키별 이번 달 사용량, 도구별 설정 예시 |
| 내 정보 | 회원 | 이름, 비밀번호 변경, 연결된 로그인 방식 |
| 전체 현황 | 관리자 | 회원별 추정 비용 순위, 모델별 사용량, 오류 수 |
| 회원 관리 | 관리자 | 초대, 승인, 정지, 역할·월 한도·최대 키 개수 변경 |
| 설정 → 일반 | 관리자 | 가입 정책, 허용 도메인, 승인 필요 여부, 하루 가입 상한, 기본 한도, 기본 최대 키 개수 |
| 설정 → 인증 | 관리자 | 로컬 로그인 켜기/끄기, SSO만 허용, IdP 목록·추가·테스트 (D1 조합에서는 잠김) |
| 설정 → 연결 | 관리자 | OmniRoute 연결 상태, 공개 주소, 메일 발송, 동기화 오류, OmniRoute 대시보드 접속 안내 |
| 감사 로그 | 관리자 | 설정·회원·키 변경 이력 |

## 7. 보안

OmniRoute 노출
- Compose에 `REQUIRE_API_KEY=true`를 명시한다.
- Caddy는 허용 목록 9개만 OmniRoute로 넘긴다 (V16): `/v1/messages`, `/v1/messages/count_tokens`, `/v1/chat/completions`, `/v1/completions`, `/v1/responses`, `/v1/responses/*`, `/v1/embeddings`, `/v1/models`, `/v1/models/*`. 그 밖의 `/v1/*`는 404다. 일반 회원 키로도 `/v1/registered-keys`(다른 키 목록), `/v1/combos`, `/v1/explain/routing` 등이 200이라 접두사 개방은 정보 노출이다. images·audio·batches·files 같은 경로는 1차에서 열지 않는다.
- OmniRoute 대시보드는 `127.0.0.1`에만 묶는다. 내부 WebSocket 포트도 외부에 열지 않는다.
- OmniRoute `INITIAL_PASSWORD`와 운영 필수 비밀 값은 설치 스크립트가 무작위로 만든다.

비밀 값
- `oma_live_` 토큰, OIDC Client Secret, SAML 개인키는 `APP_ENCRYPTION_KEY`로 암호화해 DB에 둔다. Better Auth는 `ssoProvider.oidcConfig`·`samlConfig`에 평문 JSON으로 저장하고 `databaseHooks`도 걸리지 않으므로, DB 어댑터를 감싸 `ssoProvider` 저장·수정 때 암호화하고 조회 때 복호화한다.
- 회원 API 키 원문은 저장하지 않는다. 초대 토큰은 해시만 저장한다.
- OmniRoute 키 이름·메타데이터에 개인정보를 넣지 않는다.

인증
- 권한 칼럼은 `input: false` (4.6).
- 공개 SSO 관리 경로 전부 차단 (4.3).
- 도메인 밖 이메일 거부, 인증된 로컬 계정만 연결, `trustEmailVerified` 끔 (4.4).
- SAML: `wantAssertionsSigned: true`, `saml: { requireTimestamps: true, algorithms: { onDeprecated: "reject" } }`. 나머지 검증(서명 제거·변조·재서명·재사용·Audience·IdP 시작 로그인 차단)은 Better Auth 기본값으로 막히는 것을 실측으로 확인했다.
- OIDC는 state, nonce, PKCE.
- 세션 쿠키 `HttpOnly`, `Secure`, `SameSite=Lax`. 회원 앱 변경 API는 CSRF 보호.
- 역할 변경·정지·IdP 삭제 때 세션 무효화 (4.5).

요청 수 제한
- 로그인·가입·비밀번호 재설정·키 발급에 요청 수 제한을 건다. 키 발급·재발급은 회원당 1시간 10회, 클라이언트 IP 당 1시간 30회 (넘으면 `429`, 5.2).
- Caddy 뒤에서 클라이언트 IP를 바르게 얻도록 신뢰할 프록시와 IP 헤더를 설정한다 (Better Auth `advanced.ipAddress`, 런타임 어댑터). 설정하지 않으면 모든 요청이 Caddy IP 하나로 묶여 제한이 엉뚱하게 걸린다. Workers는 `CF-Connecting-IP`.

회귀 테스트로 옮길 공격 시나리오 (0단계·검토에서 나온 것)
- SAML 서명 제거, 변조, 다른 키 재서명, 재사용
- 도메인 밖 이메일로 SSO 로그인
- 일반 사용자의 IdP 등록·수정·삭제
- 피해자 이메일 로컬 계정 선점 후 SSO 연결
- 가입 요청에 `role`·`status`·`monthly_limit_usd` 넣기
- 이메일 없는 관리자 초대 링크 생성
- 키 삭제 후 재발급으로 한도 초기화
- 키 삭제·재발급 직후 옛 원문 키로 예산·기록 밖 사용 (확인 18·19번)
- 키 없는 `/v1` 요청, 허용 목록 밖 `/v1` 경로

운영 안내 (README)
- 외부 사용자에게 제공할 때는 정식 API 키로 연결한 제공자만 써야 한다. 개인 구독 계정 공유는 각 제공자 약관을 확인해야 한다.
- OmniRoute의 요청 본문 기록 설정은 운영자가 정한다. 외부 사용자 대상이면 끄기를 권한다.

## 8. 정해야 할 것 / 확인해야 할 것

**정한 것**
- 구조: A안 (OmniRoute 키 직접 발급) — v3
- 회원 키와 OmniRoute 키 1:1, 회원당 여러 개, 관리자가 최대 개수 지정 — v5
- 회원 단위 한도: 남은 한도 분배, 차단은 OmniRoute — v5
- SAML 서명 Assertion 요구: 항상 켜짐 — v4
- 런타임·DB: 회원 앱은 Docker(Node)·Workers, DB는 SQLite·MySQL·Postgres·D1을 처음부터 지원. D1은 SSO 잠금 상태로 시작 — v5.1
- 부가기능(매직 링크, 회원별 모델 제한, 가격표 편집, CAPTCHA, 키별 분당 제한)은 2차 — v5
- SSO 순서: OIDC 먼저, SAML 다음 — v5
- 웹 화면: SvelteKit SPA 모드, API는 Hono — v5.1
- 프로젝트 이름: **Magnetosphere** (npm `magnetosphere` 비어 있음, 2026-10-09 확인). 설명 문구 "Member & usage layer for OmniRoute". 이름에 `omniroute`는 넣지 않는다 (공식 프로젝트로 오해 방지) — v5.1

**정해야 할 것**
1. GitHub 원격 저장소 위치 — 공개 전에 정한다. 로컬 폴더는 `~/github/henryj-dev/magnetosphere`.

**확인 끝 (0단계)**
- OmniRoute 1~5: `../research/phase0-omniroute.md`
- Better Auth 6~9: `../research/phase0-better-auth.md`
- 검토 후 실측: 키 없는 `/v1`은 Docker 이미지 기본값으로 `401`, `/v1/management/…`는 `/api/v1/management/…` 별칭이며 회원 키로는 `403`

**확인 끝 (2단계 K0, `../verify/`)**
- 12. 공동 예산: 쿼터 풀 일정 예산이 키 여럿의 소비를 합쳐 막는다. 연결 하나·슬라이딩 창·차단 응답 500 이라 회원 한도로 쓰지 않는다 (5.3)
- 13. call-logs 키 거르기: `apiKey` 하나, 이름·id 부분 일치. 어댑터가 다시 정확히 거른다 (5.4)
- 15. 분석 API 성능: 필터 없는 한 달 호출은 CI x64 p95 5.6~6.4초로 1분마다 부르기에 느리다 → 1분 분배는 오늘 창만 부르고 지난 날은 `usage_daily`에 저장 (5.3, v5.7). 오늘 창·회원 하나·대조 측정값은 `../verify/V15.json`
- 18. 삭제한 키 기록은 분석에 남는다. 다만 `DELETE` 직후 60초 동안 옛 원문 키가 기록 없이 통과한다 → 삭제는 끄고 60초 뒤 (5.2)
- 19. `regenerate`는 같은 id·지출·예산을 유지하지만 옛 원문 키가 60초 동안 기록 없이 통과한다 → 재발급은 새 키 + 옛 키 삭제 (5.2)
- 20. 월 예산은 UTC, 매달 1일 00:00 초기화. 올리고 내리면 다음 요청부터. 사용액 > 예산일 때만 막고 0 은 무제한 → 남은 한도 0 이면 키를 끈다 (5.3, 5.7)

**확인 남음 (1단계 초반)**

OmniRoute
10. `oma_live_` 토큰으로 키 생성·예산·분석·키 목록 API가 통하는 최소 범위. `INITIAL_PASSWORD`로 토큰을 자동 발급하는 API 흐름.
11. `PATCH isActive=false`가 즉시 요청을 막는지.
16. Caddy 허용 목록에 넣을 경로와 Claude Code·Codex·Cursor 실제 동작.
21. 운영 환경 필수 비밀 값 목록 (`OMNIROUTE_WS_BRIDGE_SECRET` 등).
24. Workers 조합에서 회원 앱이 OmniRoute 관리 API에 닿는 방식 (Caddy 비밀 헤더 + Tunnel)과 그 보안성.

Better Auth
17. 추가 칼럼 `input: false`가 가입·회원정보 수정 경로 모두에서 막히는지.
22. D1에서 `resolveUser` 대신 도메인 검사·연결 조건을 강제할 수단 (`databaseHooks.account.create.before` 등). 통과하면 D1 SSO 잠금을 푼다.
23. `disabledPaths`로 막아야 할 SSO 관리·도메인 검증 경로의 정확한 목록.
25. 여러 인스턴스·Workers에서 Better Auth 요청 수 제한 저장소(secondaryStorage) 설정.
26. Better Auth Drizzle 어댑터와 `@better-auth/sso`가 MySQL·Postgres에서 테이블 생성, 시각 저장 방식, `resolveUser` 트랜잭션까지 SQLite와 같게 동작하는지. MySQL은 MariaDB도 함께.
27. Workers + MySQL(Hyperdrive) 조합에서 Drizzle MySQL 드라이버 동작.

(14번 키별 분당 요청 수 제한은 2차로 미룸)

## 9. 진행 순서

| 단계 | 내용 | 끝났다고 보는 기준 |
|---|---|---|
| 0. 확인 | OmniRoute, Better Auth·Keycloak 실측 | 끝 |
| 1. 뼈대 | Hono + Drizzle + Better Auth(이메일·비밀번호, 이메일 인증, 권한 칼럼 보호), 메일 어댑터, 런타임 어댑터, 설치 스크립트, 최초 설치 + OmniRoute 부트스트랩, Compose(Caddy 허용 목록, OmniRoute 고정), OmniRoute 어댑터 + 계약 테스트. 확인 10·11·16·17·21·26·27 | 여섯 조합(3.2) 모두에서 마이그레이션·설치·관리자 생성·로그인 성공. 계약 테스트 통과. 키 없는 `/v1`은 401 |
| 2. 키·한도 | 키 발급 순서, 최대 개수, 남은 한도 분배 작업, 목표 상태 계산, 작업 큐, 정합성 점검, 작업 임대 잠금. 확인 12·13·15·18·19·20 | Claude Code가 발급 키로 동작. 끈 키 거부. 여러 키로 나눠 써도 회원 한도에서 429. 삭제·재발급으로 한도가 초기화되지 않음 |
| 3. 회원·정책 | 가입 정책(메일 의존 제한 포함), 초대(관리자 초대 이메일 필수), 승인, 하루 가입 상한, 정지, 세션 무효화 | 정책별 시나리오와 7장 회귀 테스트 통과 |
| 4. 사용량 화면 | 내 사용량, 키별 사용량, 최근 요청(필드 허용 목록), 전체 현황 | 회원이 자기 데이터만 보임. 숫자가 OmniRoute 대시보드와 일치 |
| 5. OIDC | 설정 화면에서 OIDC 추가, 연결 테스트, JIT, 역할 매핑, 계정 연결 조건, 비밀 값 암호화 어댑터, 공개 SSO 경로 차단. 확인 22·23 | Keycloak·Google OIDC로 가입·로그인·역할 반영. 7장 SSO 회귀 테스트 통과 |
| 6. SAML | SAML 추가, SP 서명키 자동 생성, 검증 옵션 고정 | Keycloak SAML로 가입·로그인·역할 반영. SAML 공격 회귀 테스트 통과 |
| 7. 관리 화면 | 회원 관리, 설정, 감사 로그 | 관리자 시나리오 테스트 통과 |
| 8. 공개 준비 | README, 런타임별 설치 문서, IdP별 연결 가이드, SECURITY.md, CI 매트릭스 정리. 확인 24·25 | 처음 보는 사람이 문서만 보고 Docker와 Workers 각각 설치 성공 |
