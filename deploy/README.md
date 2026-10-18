# 배포 안내

Docker Compose 설치(회원 앱 + OmniRoute + Caddy)와 Workers 배포를 적는다. 근거는 계획서 3.2·3.3·4.7·7장이다.

## Docker Compose 설치

1. 비밀 값 만들기: `node scripts/init.mjs [--db sqlite|mysql|postgres] [--url https://<도메인>]`
   - `.env` 에 OmniRoute 운영 비밀 값 전부(V21)와 회원 앱 비밀 값을 무작위로 만든다. 이미 있으면 덮지 않고 종료코드 1 이다.
   - `.env.setup` 에는 회원 앱이 OmniRoute 에 처음 연결할 때 쓰는 `OMNIROUTE_INITIAL_PASSWORD` 만 들어간다.
2. 띄우기: `docker compose up -d --wait`
3. 최초 설치 토큰: `docker compose logs app | grep "최초 설치 토큰"` → `/setup` 에서 첫 관리자를 만든다.
   OmniRoute 접근 토큰은 같은 요청에서 자동으로 만들어진다 (응답 `omniroute: "connected"`).
4. 최초 설치가 끝나면 `.env.setup` 을 지우고 app 을 다시 띄운다.

   ```sh
   rm .env.setup
   docker compose up -d app
   ```

   `.env.setup` 의 비밀번호로는 OmniRoute admin 접근 토큰도 만들 수 있다. 회원 앱 환경에 남아 있으면 회원 앱이 털렸을 때
   write 최소 범위(계획서 5.8)가 의미 없어진다. 관리자가 있는데 이 값이 남아 있으면 app 이 시작할 때 경고를 한 줄 남긴다.

### 최초 설치는 한 인스턴스로 한다

관리자가 없는 채로 app 인스턴스가 여럿 뜨면 각자 시작할 때 설치 토큰을 새로 만들어 서로 덮는다. 마지막에 뜬 인스턴스의 토큰만 듣는다.
최초 설치(관리자 생성)는 app 을 한 인스턴스로 띄워 끝내고, 그다음에 늘린다 (`docker compose up -d --scale app=N`, MySQL·Postgres 프로필).
SQLite 는 인스턴스 하나만 쓴다.

### OmniRoute 를 공개하지 않는다

- OmniRoute 20128 포트와 /api/* 는 공개로 열지 않는다. 방화벽·보안 그룹·포트 포워딩으로 20128 을 열거나, Caddy 에 OmniRoute `/api/*` 를 넘기는 규칙을 더하지 않는다.
  공개 주소로 닿는 OmniRoute 경로는 Caddy 허용 목록 9개 `/v1` 경로뿐이다. 대시보드는 SSH 터널로만 쓴다.
- 2단계 전까지 Workers 조합은 Cloudflare Tunnel·Access 로만 연결한다. Workers 가 OmniRoute 관리 API 를 부를 길을 공개 인터넷에 열지 않는다
  (Cloudflare Tunnel 로 서버 포트를 열지 않고, Cloudflare Access 서비스 토큰으로 막는다). 회원 앱 쪽 구현은 2단계(V24)다.
  그 전까지 Workers 조합은 설치 화면에서 OmniRoute 접근 토큰을 붙여 넣는다.

### 구성

| 서비스 | 하는 일 | 호스트 포트 |
|---|---|---|
| caddy | 공개 입구. V16 허용 목록 9개 `/v1` 경로만 OmniRoute 로, 그 밖의 `/v1/*` 는 404, 나머지는 app | 80, 443 (`HTTP_PORT`·`HTTPS_PORT`) |
| migrate | 커밋된 마이그레이션을 적용하고 끝나는 일회성 서비스. app 은 이것이 성공해야 뜬다 | 없음 |
| app | 회원 앱 (Node, `apps/server/Dockerfile`) | 없음 |
| omniroute | OmniRoute 3.8.51 (digest 고정) | `127.0.0.1:20128` (대시보드, 루프백만) |
| mysql / postgres | 프로필 `mysql`(8.0) · `postgres`(14) | 없음 |

- OmniRoute 대시보드는 서버의 루프백에만 열린다. 제공자 등록은 SSH 터널로 한다: `ssh -L 20128:127.0.0.1:20128 <서버>` 뒤 `http://localhost:20128`.
- app 은 `edge` 망의 Caddy 고정 주소에서 온 `X-Forwarded-For` 만 믿는다 (`TRUSTED_PROXIES`, 기본 `CADDY_EDGE_IP/32` = `10.203.57.2/32`).
  망 전체가 아니라 Caddy 주소 하나만 믿는다. 망 게이트웨이(호스트에서 들어온 연결의 출발지)를 프록시로 보지 않게 하려는 것이다.
  이 망 대역이 서버의 다른 망과 겹치면 `.env` 에 `EDGE_SUBNET`, 그 안의 `CADDY_EDGE_IP`, 그 안이면서 Caddy 주소 밖인 `EDGE_IP_RANGE` 를 함께 바꾼다.
  `TRUSTED_PROXIES` 는 `CADDY_EDGE_IP` 를 따라가므로 따로 바꾸지 않는다. 주소가 대역 밖이면 `docker compose up` 이 실패한다.
  신뢰 목록 밖의 상대가 `X-Forwarded-For` 를 보내면 app 이 경고를 한 번 남긴다. 이 경고가 보이면 프록시 설정을 확인한다.
- Caddy 앞에 다른 부하 분산기가 있으면 `deploy/Caddyfile` 전역 옵션에 `servers { trusted_proxies static <주소> }` 를 더한다.
  그러지 않으면 모든 요청이 그 부하 분산기 주소 하나로 세어진다.
- 외부 사용자에게 제공할 때는 OmniRoute 의 요청 본문 기록을 끄기를 권한다 (계획서 7장).

## Workers 배포

설정은 `apps/server/wrangler.toml` 이다. 환경이 셋이다: `d1`, `mysql`(Hyperdrive), `pg`(Hyperdrive).
OmniRoute 는 어느 조합이든 상시 서버 한 대(위 Compose)에서 돈다. Workers 에서 OmniRoute 관리 API 로 닿는 방식(비밀 헤더 + Cloudflare Tunnel)은
계획서 3.3·V24 이고 2단계에서 정한다. 그 전에는 설치 화면에서 OmniRoute 접근 토큰을 붙여 넣는다.

1. `wrangler.toml` 의 D1 `database_id` 또는 Hyperdrive `id` 를 실제 값으로 바꾼다 (`wrangler d1 create`, `wrangler hyperdrive create`).
   `BETTER_AUTH_URL` 도 공개 주소로 바꾼다.
2. 시크릿: `wrangler secret put <이름> --env <환경>` — `BETTER_AUTH_SECRET`, `APP_ENCRYPTION_KEY`, `SETUP_TOKEN`.
   `SETUP_TOKEN` 은 `openssl rand -base64 32` 로 만든다. 32자보다 짧으면 회원 앱이 시작을 거부한다 (Node 는 시작 때, Workers 는 첫 요청 때 500).
   `POST /api/setup` 은 클라이언트 IP 마다 10분에 10회까지만 받는다 (429).
   Workers 에서는 `SETUP_TOKEN` 이 필수이고 그 값이 설치 토큰이다. 없으면 관리자가 생기기 전까지 `/api/setup` 이 503 `setup_token_required` 다
   (인증 없는 요청으로 토큰을 만들거나 갈 수 없게 한다). Docker(Node)는 선택이다. 없으면 시작할 때마다 새 토큰을 로그에 한 번 낸다.
3. 배포: `node deploy/workers-deploy.mjs --env d1|mysql|pg`. 마이그레이션을 먼저 적용하고 배포한다.
   - d1: `wrangler d1 migrations apply DB --remote` → `wrangler deploy`
   - mysql·pg: `MIGRATE_DATABASE_URL`(Hyperdrive 가 가리키는 DB 의 직접 주소)로 `apps/server/src/migrate.ts` → `wrangler deploy`
   - `--dry-run` 은 실행할 단계만 순서대로 출력한다.
4. 최초 설치가 끝나면 `OMNIROUTE_INITIAL_PASSWORD` 시크릿을 넣었다면 지운다 (`wrangler secret delete`). 남아 있으면 첫 요청 때 경고가 나온다.

## 가입 정책과 초대

가입 정책(`signup_mode`)은 다섯이다. 기본값은 `invite_only` 이다. 설치 직후 모르는 사람이 가입해 비용을 쓰는 일을 막는다.

| 정책 | 동작 | 메일 설정 필요 |
|---|---|---|
| `invite_only` | 초대 링크로만 가입 (기본값) | 아니요 |
| `open` | 누구나 가입 | 예 |
| `domain_allowlist` | 허용한 이메일 도메인만 가입 (정확히 일치, 목록이 비면 아무도 못 한다) | 예 |
| `closed` | 신규 가입을 막는다. 초대도 막는다: 만들기는 409 `signup_closed`, 수락은 사유를 가리지 않는 400 `invalid_invite` | 아니요 |
| `sso_only` | 로컬 가입을 막고 IdP 로그인으로만 가입. IdP 로그인은 아직 지원하지 않는다 (5단계 계획). 켜진 IdP 가 없으면 저장이 409 `no_idp` 로 거부된다. 초대는 `closed` 와 같이 만들기 409 `signup_closed`, 수락 400 `invalid_invite` | 아니요 |

- 메일이 설정되지 않았으면 `open`·`domain_allowlist` 를 저장할 수 없다 (409 `mail_required`). 가입 때도 다시 확인해 403 으로 거부한다.
- 공개 가입이 거부되면 403 과 사유 코드(`signup_closed`·`domain_not_allowed`·`mail_required`·`signup_cap`)를 돌려준다.
- 하루 가입 상한은 UTC 날짜로 센다. 실제로 회원 행이 생긴 자기 가입만 세고 초대 수락은 세지 않는다. 넘으면 그날 남은 자기 가입이 403 `signup_cap` 이다.
  `null` 은 상한 없음, `0` 은 자기 가입을 모두 막는다. 동시에 들어온 가입은 상한을 조금 넘을 수 있다.
- 승인은 자기 가입(`open`·`domain_allowlist`)에만 건다. `signup_requires_approval`(기본 켬)이면 가입 직후 `pending` 이고 관리자가 승인해야 `active` 가 된다. 초대 수락은 승인 없이 바로 `active` 다.

### 초대

- 초대 링크는 한 번만 쓴다. 만료는 기본 7일이고 1~30일로 정할 수 있다. 관리자가 취소할 수 있다.
- 이메일을 지정한 초대는 그 이메일로만 수락된다. 수락이 곧 이메일 인증이다.
- 이메일 없는 초대는 링크를 쥔 사람이 어떤 이메일로든 수락할 수 있어, 공개 가입과 같은 확인(아래)을 거친다. 메일이 없는 설치에서는 만들 수 없다.
- 링크 원문은 만들 때의 응답에서만 볼 수 있다. DB 에는 해시만 남는다. 이메일을 지정한 초대는 메일 설정 없이도 만들 수 있다.
- 만료·취소한 뒤 30일이 지난 미사용 초대는 1분 작업이 지운다. 사용한 초대는 남는다.

### 이메일 인증 확인

공개 가입과 이메일 없는 초대 가입의 인증 링크는 `GET` 으로 열기만 해서는 인증되지 않는다. `GET` 은 안내(`password_confirmation_required`)만 돌려준다.
메일 보안 도구가 링크를 미리 열어도 인증되지 않게 하려는 것이다. 인증 완료는 `POST` 로 토큰과 가입 때 정한 비밀번호를 함께 보내야 한다.
비밀번호를 잊었으면 비밀번호 재설정(`request-password-reset`)을 쓴다.

## 회원 탈퇴와 데이터 처리

관리자 삭제와 자기 탈퇴(`DELETE /api/me`, 비밀번호 재확인)는 같은 삭제 처리를 쓴다. 첫 관리자(`is_bootstrap_admin`)는 삭제할 수 없다.

- `user` 행은 남기고 개인정보만 지운다. 이메일은 `deleted-<id>@invalid`, 이름은 빈 값, 상태는 `deleted` (되돌릴 수 없다).
- 지우는 것: `account`, `session`, 그 회원의 `verification`(재설정 토큰·가입 인증 토큰).
- 초대: 그 회원이 수락한 초대의 `email` 은 같은 익명 이메일로 바꾸고 `used_by` 는 남긴다. 삭제 전 그 이메일로 보낸 미사용·미철회 초대는 철회한다.
- 남는 것: `api_keys` 행(삭제 표시, 사용액 근거), `usage_daily`, `audit_log`, 그리고 OmniRoute 쪽 기록.
- OmniRoute 호출 기록은 지워지지 않는다. 회원 앱은 OmniRoute 의 호출 기록과 키별 사용량을 지울 수 없고, 탈퇴 처리도 건드리지 않는다.
  기록에 남은 키 id 는 삭제된 회원의 `api_keys` 행으로만 이어진다. 기록 자체를 없애야 하면 OmniRoute 에서 따로 정리한다.
- OmniRoute 키는 끄고, 60초가 지난 뒤 `DELETE` 한다. 끄기 직후에는 옛 원문 키가 최대 60초 통과한다. 작업 큐는 이 대기를 `KEY_DELETE_DELAY_MS`(120초, `apps/server/src/queue/index.ts`)로 잡는다.
  설계 문서의 키 삭제 절도 "끈 시각 + 2분" 이라 현재 코드와 맞는다. 60초는 OmniRoute 가 요구하는 최소 대기이고, 앱은 실행기 주기(1분)를 감안해 2분에 집행한다.
- 삭제 처리는 회원 행과 관리자 행을 잠그고 한 단위로 한다. MySQL 에서 다른 트랜잭션이 같은 행을 잡고 있을 때의 잠금 대기 시간은 서버의 `innodb_lock_wait_timeout` 설정을 따른다 (MySQL 기본 50초).
  이 앱이 정한 값이 아니므로 운영 수치로 가정하지 않고, 필요하면 DB 설정에서 확인한다. Postgres 는 코드에서 `lock_timeout` 5초를 먼저 건다.

## 메일 발송 설정 (다음 M5, 개발 중)

아래 내용은 아직 커밋되지 않았고 E2E 로 확인하는 중이다. 지금 운영 중인 기능으로 읽지 않는다. 병합되면 이 절을 사실에 맞게 고친다.

- Node: `provider: "smtp"` (host·port·secure·requireTLS·user·password·from). Cloudflare: `provider: "cloudflare"` 와 `from` (`send_email` 바인딩 `EMAIL`, 저장하는 비밀 값 없음).
- SMTP 는 `secure: false` 이면 `requireTLS` 기본이 켜짐이다. 평문은 `secure: false` 와 `requireTLS: false` 를 둘 다 명시했을 때만 쓴다. `secure: true` 와 `requireTLS: false` 조합은 저장이 거부된다.
- 관리자가 입력한 SMTP host 는 LAN·loopback 주소도 받는다. 서버가 그 주소로 연결하므로 내부망 접근(SSRF)은 관리자 권한을 믿는 구조다. 관리자 계정을 보호하고 서버의 외부 연결을 방화벽으로 제한한다.
- Workers 는 SMTP 를 지원하지 않는다 (400 `smtp_unsupported`). Workers 에서 바인딩이 없으면 Cloudflare 저장도 거부된다 (`cloudflare_unsupported`).
- D1 조합은 SSO(`sso_only`·IdP)를 지원하지 않기로 했다. 설정 화면도 잠근다.

## 회원 한도의 한계

회원 월 한도는 결제 상한이 아니다. 회원 앱이 1분마다 회원의 남은 한도를 키별 예산으로 나눠 걸고, 실제 차단은 OmniRoute 가 한다 (계획서 5.3).

- 회원 한도는 계정 단위다. 사람 단위 상한이 아니다. 탈퇴 뒤 다시 가입하면 그달 한도를 새로 받는다 (삭제 이력은 이어지지 않는다). `open` 에서는 다른 이메일로 가입해도 새 한도를 받으므로, 외부 사용자에게 사람당 상한이라고 안내하지 않는다.
- 월은 UTC 기준이다.
- 설치 때 만든 첫 관리자는 월 한도가 없다 (`monthly_limit_usd` NULL). 설치 경로가 가입 훅의 기본 한도 복사를 거치지 않는다. 운영자 본인이라 의도한 동작이고, 첫 관리자가 아닌 관리자는 가입 때 기본 한도를 복사해 받는다.

- 짧은 시간에 몰아 쓰면 한도를 넘을 수 있다. OmniRoute 지출은 60초마다 기록되고 분배도 1분 주기라, 최악의 경우 대략 "남은 한도 × 동시에 쓰는 키 수"까지 넘는다. 회원당 최대 키 개수(기본 2)가 이 폭을 제한한다.
- 동시에 보낸 요청은 지출이 기록되기 전에 모두 예산 검사를 통과한다. 그래서 키가 하나여도 한도에 닿는 순간 진행 중이던 요청만큼("동시 요청 수 × 요청 비용") 더 넘을 수 있다.
- OmniRoute 분석 호출(사용액 조회)이 실패하는 동안 분배는 예산을 고치지 않는다(fail-closed, 예산을 풀지 않고 마지막 값을 둔다). 그동안 한도 반영은 실패한 기간만큼 늦는다. 10분 넘게 이어지면 감사 로그에 관리자 알림(`alert.rebalance_stalled`, 하루 한 번)이 남는다.
- 비용은 OmniRoute 가격표로 계산한 추정치다. 제공자가 실제로 청구하는 금액과 다를 수 있다.

## 알려진 운영 한계

- 탈퇴 전 그 이메일로 보낸 미사용 초대는 철회만 하고, 행은 철회 30일 뒤에 지운다. 그동안 초대 행에 이메일이 남는다.
- 익명화는 탈퇴 처리 때 수락한 초대에 적용된다. 이미 탈퇴한 회원의 수락 초대는 마이그레이션 0006 이 한 번 익명화했다. 그 밖의 과거 데이터는 소급하지 않는다.
- 같은 이메일로 탈퇴 처리와 재초대가 동시에 일어나면 경쟁이 남을 수 있다. 막는 장치를 확인하지 못했으니 탈퇴 직후 재초대는 결과를 확인한다.
- `session.expires_at` 에는 인덱스가 없어 만료 세션 정리가 1분마다 표를 훑는다. D1 에서는 읽은 행 수 비용이 생길 수 있고, 실제 비용은 확정하지 못했다 (UNKNOWN).
