#!/usr/bin/env bash
# V27 컨테이너를 멈추고 지운다.
set -euo pipefail
for n in v27-mysql v27-pg; do
  docker rm -f "$n" >/dev/null 2>&1 && echo "[down] $n 삭제" || echo "[down] $n 없음"
done
