# 회원 앱 Node 이미지 (Docker 조합, 실행판 S6.T2). 저장소 최상위를 빌드 문맥으로 쓴다:
#   docker build -f apps/server/Dockerfile .
# 서버는 TypeScript 를 빌드하지 않고 Node 24 타입 지우기로 바로 돈다 (`node apps/server/src/node.ts`).
# 워크스페이스 패키지도 .ts 그대로라서 node_modules 안으로 복사하지 않고(pnpm deploy 를 쓰지 않는다) 저장소 모양을 유지한다.
# Node 는 node_modules 안의 .ts 는 타입을 지우지 않는다.
# 같은 이미지가 두 가지로 돈다: app (기본 명령) 과 migrate (`node apps/server/src/migrate.ts`, 일회성).

ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
# package.json 의 packageManager(pnpm@11.9.0)를 corepack 이 받는다
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
WORKDIR /repo
# 의존성 설치 층을 소스 변경과 떼어 둔다 (소스만 바뀌면 설치를 다시 하지 않는다)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/auth/package.json packages/auth/
COPY packages/db/package.json packages/db/
COPY packages/omniroute/package.json packages/omniroute/
COPY packages/runtime/package.json packages/runtime/

# ---------- SPA 빌드 (apps/web → apps/web/build) ----------
FROM base AS web
# 루트 prepare 스크립트(git 훅 설정)는 이미지에 쓸모가 없어 스크립트를 돌리지 않는다. 네이티브 바이너리는 선택 의존성으로 온다
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @magnetosphere/web
COPY . .
RUN pnpm -C apps/web build && test -f apps/web/build/index.html

# ---------- 실행 이미지 ----------
FROM base AS app
RUN pnpm install --frozen-lockfile --ignore-scripts --prod --filter "@magnetosphere/server..." \
 && rm -rf /pnpm/store /root/.cache /root/.local/share/pnpm
COPY . .
COPY --from=web /repo/apps/web/build apps/web/build
# SQLite 기본 위치. 이름 있는 볼륨이 이 폴더 소유자(node)를 물려받는다
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
USER node
EXPOSE 3000
CMD ["node", "apps/server/src/node.ts"]
