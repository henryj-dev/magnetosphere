#!/usr/bin/env bash
# V27 스파이크용 MySQL 8.0 / Postgres 14 컨테이너를 띄우고 준비될 때까지 기다린다. 여러 번 실행해도 된다.
set -euo pipefail

start() { # name image port-mapping env...
  local name=$1; shift
  if docker ps --format '{{.Names}}' | grep -qx "$name"; then
    echo "[up] $name 이미 실행 중"
  elif docker ps -a --format '{{.Names}}' | grep -qx "$name"; then
    echo "[up] $name 재시작"; docker start "$name" >/dev/null
  else
    echo "[up] $name 생성"; docker run -d --name "$name" "$@" >/dev/null
  fi
}

start v27-mysql -p 127.0.0.1:23306:3306 \
  -e MYSQL_ROOT_PASSWORD=v27root -e MYSQL_DATABASE=v27 -e MYSQL_USER=v27 -e MYSQL_PASSWORD=v27pass \
  mysql:8.0
start v27-pg -p 127.0.0.1:25432:5432 \
  -e POSTGRES_USER=v27 -e POSTGRES_PASSWORD=v27pass -e POSTGRES_DB=v27 \
  postgres:14

wait_for() { # label cmd...
  local label=$1; shift
  for i in $(seq 1 90); do
    if "$@" >/dev/null 2>&1; then echo "[up] $label 준비됨"; return 0; fi
    sleep 1
  done
  echo "[up] $label 준비 시간 초과" >&2; return 1
}

# mysqladmin ping 은 초기화 중 임시 서버에도 응답하므로, 앱 계정으로 TCP 접속해 실제 쿼리가 되는지 본다.
wait_for v27-mysql docker exec v27-mysql mysql -h127.0.0.1 -P3306 -uv27 -pv27pass v27 -e 'SELECT 1'
wait_for v27-pg docker exec v27-pg psql -h127.0.0.1 -U v27 -d v27 -c 'SELECT 1'
