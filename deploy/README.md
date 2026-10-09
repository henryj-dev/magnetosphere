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

### 구성

| 서비스 | 하는 일 | 호스트 포트 |
|---|---|---|
| caddy | 공개 입구. V16 허용 목록 9개 `/v1` 경로만 OmniRoute 로, 그 밖의 `/v1/*` 는 404, 나머지는 app | 80, 443 (`HTTP_PORT`·`HTTPS_PORT`) |
| migrate | 커밋된 마이그레이션을 적용하고 끝나는 일회성 서비스. app 은 이것이 성공해야 뜬다 | 없음 |
| app | 회원 앱 (Node, `apps/server/Dockerfile`) | 없음 |
| omniroute | OmniRoute 3.8.51 (digest 고정) | `127.0.0.1:20128` (대시보드, 루프백만) |
| mysql / postgres | 프로필 `mysql`(8.0) · `postgres`(14) | 없음 |

- OmniRoute 대시보드는 서버의 루프백에만 열린다. 제공자 등록은 SSH 터널로 한다: `ssh -L 20128:127.0.0.1:20128 <서버>` 뒤 `http://localhost:20128`.
- app 은 `edge` 망(Caddy 만 있는 망)에서 온 `X-Forwarded-For` 만 믿는다 (`TRUSTED_PROXIES`, 기본 `10.203.57.0/29` = `EDGE_SUBNET`).
  이 망 대역이 서버의 다른 망과 겹치면 `.env` 에 `EDGE_SUBNET` 과 `TRUSTED_PROXIES` 를 같은 값으로 바꾼다.
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
