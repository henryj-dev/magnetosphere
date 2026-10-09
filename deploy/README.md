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
