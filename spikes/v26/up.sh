#!/usr/bin/env bash
# V26 스파이크용 컨테이너(MySQL 8.0, MariaDB 10.11, Postgres 14, Keycloak 26.4.0)를 띄우고
# 준비될 때까지 기다린 뒤 Keycloak 에 realm·OIDC 클라이언트·테스트 사용자를 만든다. 여러 번 실행해도 된다.
set -euo pipefail
cd "$(dirname "$0")"

start() { # name docker-run-args...
  local name=$1; shift
  if docker ps --format '{{.Names}}' | grep -qx "$name"; then
    echo "[up] $name 이미 실행 중"
  elif docker ps -a --format '{{.Names}}' | grep -qx "$name"; then
    echo "[up] $name 재시작"; docker start "$name" >/dev/null
  else
    echo "[up] $name 생성"; docker run -d --name "$name" "$@" >/dev/null
  fi
}

start v26-mysql -p 127.0.0.1:13306:3306 \
  -e MYSQL_ROOT_PASSWORD=v26root -e MYSQL_DATABASE=v26 -e MYSQL_USER=v26 -e MYSQL_PASSWORD=v26pass \
  mysql:8.0
start v26-mariadb -p 127.0.0.1:13307:3306 \
  -e MARIADB_ROOT_PASSWORD=v26root -e MARIADB_DATABASE=v26 -e MARIADB_USER=v26 -e MARIADB_PASSWORD=v26pass \
  mariadb:10.11
start v26-pg -p 127.0.0.1:15432:5432 \
  -e POSTGRES_USER=v26 -e POSTGRES_PASSWORD=v26pass -e POSTGRES_DB=v26 \
  postgres:14
start v26-keycloak -p 127.0.0.1:8181:8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:26.4.0 start-dev

wait_for() { # label cmd...
  local label=$1; shift
  for _ in $(seq 1 180); do
    if "$@" >/dev/null 2>&1; then echo "[up] $label 준비됨"; return 0; fi
    sleep 1
  done
  echo "[up] $label 준비 시간 초과" >&2; return 1
}

# 초기화 중 임시 서버도 ping 에는 응답하므로, 앱 계정으로 TCP 접속해 실제 쿼리가 되는지 본다.
wait_for v26-mysql docker exec v26-mysql mysql -h127.0.0.1 -P3306 -uv26 -pv26pass v26 -e 'SELECT 1'
wait_for v26-mariadb docker exec v26-mariadb mariadb -h127.0.0.1 -P3306 -uv26 -pv26pass v26 -e 'SELECT 1'
wait_for v26-pg docker exec v26-pg psql -h127.0.0.1 -U v26 -d v26 -c 'SELECT 1'
wait_for v26-keycloak curl -fsS http://127.0.0.1:8181/realms/master/.well-known/openid-configuration

node kc-setup.mjs
