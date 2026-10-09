#!/usr/bin/env bash
# V26 컨테이너를 지운다.
set -uo pipefail
for n in v26-mysql v26-mariadb v26-pg v26-keycloak; do
  docker rm -f "$n" >/dev/null 2>&1 && echo "[down] $n 삭제" || echo "[down] $n 없음"
done
