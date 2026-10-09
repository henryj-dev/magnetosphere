# 0단계 확인 결과 — OmniRoute

확인일: 2026-10-09
대상: `diegosouzapw/omniroute:3.8.51` (Docker, 127.0.0.1:20140, 별도 데이터 볼륨 `omni-phase0-data`)
방법: 가짜 상위 서버(`phase0-assets/mock-upstream.mjs`, :18080)를 OpenAI 호환·Anthropic 호환 제공자로 붙이고 실제 요청을 보냄. 토큰 값을 일부러 특이하게 정함 (OpenAI 111/22, Anthropic 입력 333 + 캐시 읽기 44 + 캐시 쓰기 7 / 출력 55).

## 요약

| # | 항목 | 결론 | 방식 |
|---|---|---|---|
| 1 | 스트리밍 헤더 | 토큰·비용 헤더가 **0**으로 나온다. 비스트리밍만 정확 | 실측 |
| 2 | call-logs 필드 | 토큰(캐시 분리)·`apiKeyId`는 있고 **비용은 없다**. 요청당 줄이 2개 | 실측 |
| 3 | 요청 ID | 우리 `X-Request-Id`는 전달·기록되지 않는다. 요청 단위 짝짓기가 불안정 | 실측 |
| 4 | Claude Code 경로 | 루트 `/v1/messages` | 문서 + 실측 |
| 5 | 관리 API 인증 | 대시보드 쿠키 + `Origin` 헤더, 또는 `oma_live_…` 접근 토큰 | 문서 + 실측 |
| 추가 | 키별 분석 API | `/api/usage/analytics?apiKeyIds=`가 스트리밍 포함 정확히 집계 | 실측 |
| 추가 | 키별 한도 | 넘으면 `429 BUDGET_EXCEEDED`로 실제 차단 | 실측 |
| 추가 | 비용의 성격 | 실제 청구액이 아니라 토큰 × 가격표 **추정치**, 가격 바꾸면 과거도 재계산 | 문서 + 실측 |

## 1. 스트리밍 응답의 `X-OmniRoute-*` 헤더

| 요청 | tokens-in | tokens-out | response-cost |
|---|---|---|---|
| OpenAI 비스트리밍 | 111 | 22 | 0.0022100000 (가격 등록 후) |
| OpenAI 스트리밍 | **0** | **0** | **0.0000000000** |
| Anthropic 비스트리밍 | 384 | 55 | 0.0062115000 (가격 등록 후) |
| Anthropic 스트리밍 | **0** | **0** | **0.0000000000** |

- 헤더는 응답 시작 시점에 붙어서 스트리밍은 값을 알 수 없다.
- 스트림 본문의 usage는 회원에게 그대로 전달된다.
  - Anthropic: `message_start`(input 333, cache_read 44, cache_creation 7), `message_delta`(output 55) 그대로.
  - OpenAI: 클라이언트가 `stream_options.include_usage`를 안 보내도 OmniRoute가 상위에 `include_usage: true`를 넣고, 마지막 usage 청크를 클라이언트까지 내려준다 (mock 로그로 확인).
- 비스트리밍 Anthropic의 `tokens-in`(384)은 입력 + 캐시 읽기 + 캐시 쓰기 합계다. 헤더만으로는 캐시 토큰을 나눌 수 없다.

## 2. `/api/usage/call-logs`

- 응답은 배열. 페이지는 `limit`, `offset`만 명세에 있다.
- 필드: `id, timestamp, status, model, requestedModel, provider, providerDisplay, connectionId, account, apiKeyId, apiKeyName, tokens{in,out,cacheRead,cacheWrite|cacheCreation,reasoning,compressed}, duration, error, correlationId, comboName, sourceFormat, targetFormat, path, method, completed, completedAt, ...`
- **비용 필드 없음.**
- 스트리밍도 토큰이 정확히 기록된다 (111/22, 384/55 + 44/7).
- 요청 하나에 줄이 2개 나온다.
  - 진행 기록: `id`가 `<타임스탬프>-<6자리>`, `apiKeyId` 비어 있음, 캐시 필드 이름 `cacheCreation`.
  - 완료 기록: `id`가 UUID, `apiKeyId`·`requestedModel` 채워짐, 캐시 필드 이름 `cacheWrite`.
  - 두 줄은 `correlationId`로 이어진다. 집계에는 완료 기록만 써야 한다.

## 3. 요청 ID

- 프록시가 보낸 `X-Request-Id`는 상위로 전달되지 않고 call-logs에도 없다.
- 응답 헤더 `X-OmniRoute-Request-Id`:
  - 스트리밍: 진행 기록의 `id`와 같다 → `correlationId`로 완료 기록까지 찾을 수 있다.
  - 비스트리밍: UUID인데 로그의 `id`·`correlationId` 어느 쪽과도 맞지 않았다.
- 결론: 요청 하나하나를 OmniRoute 로그와 정확히 짝짓는 방식은 쓰지 않는다.

## 4. Claude Code 엔드포인트

- `ANTHROPIC_BASE_URL`에 루트 주소를 넣으면 Claude Code가 `/v1/messages`를 붙인다 (`docs/guides/CLAUDE-CODE-CONFIGURATION.md`).
- `Authorization: Bearer`와 `x-api-key` 둘 다 받는다 (실측).

## 5. 관리 API 인증

- 대시보드 비밀번호 로그인 → `auth_token` 쿠키. 조회는 쿠키만으로 되고, 변경 요청은 `Origin` 헤더가 맞아야 통과한다 (없으면 `AUTH_001`).
- 서버 간 호출에는 `oma_live_…` 접근 토큰(Settings → Access Tokens, 범위 `read`/`write`/`admin`)을 쓴다. 추론용 `sk-…` 키는 `manage` 범위를 주지 않으면 관리 API를 못 쓴다 (`docs/guides/MANAGEMENT-AUTH.md`).
- 이번 실측은 쿠키 방식만 했다. 접근 토큰 방식은 1단계에서 확인한다.

## 추가 1. 키별 분석 `/api/usage/analytics`

- 쿼리: `range`, `startDate`, `endDate`, `apiKeyIds`, `presets` (`docs/guides/COST_TRACKING.md`).
- 응답: `summary, dailyTrend, activityMap, byModel, byProvider, byApiKey, byAccount, byServiceTier, weeklyPattern, weeklyTokens, weeklyCounts, dailyByModel, modelNames, errorBreakdown`.
- 회원 B(요청 3건, 스트리밍 1건 포함): `cost 0.014633` = 0.00221 + 0.0062115 × 2. 정확.
- 회원 A(가격 등록 전 요청 4건): `cost 0.016843`. 가격 등록 뒤 과거 요청까지 다시 계산됐다.

## 추가 2. 키별 한도 `/api/usage/budget`

- `POST {apiKeyId, dailyLimitUsd, weeklyLimitUsd, monthlyLimitUsd}`, 경고 기준 기본 80%.
- 한도를 넘은 뒤 요청 → `429 {"code":"BUDGET_EXCEEDED","type":"rate_limit_error"}`.
- 주의: 키별 지출은 60초마다 모아서 기록된다 (`OMNIROUTE_SPEND_FLUSH_INTERVAL_MS`). 짧은 시간에 몰아서 쓰면 한도를 조금 넘길 수 있다.

## 추가 3. 비용은 추정치

- OmniRoute 비용 = 토큰 × 가격표 (사용자 지정 > LiteLLM 동기화(기본 꺼짐) > 내장 기본값). 상위 제공자가 실제로 청구한 금액이 아니다.
- 무료·구독 제공자로 처리된 요청에도 가격표 기준 비용이 붙는다.
- 분석 화면의 비용은 매번 다시 계산되므로 가격을 고치면 과거 비용도 바뀐다.
- 가격표 키는 `<제공자 id 또는 접두사>` → `<모델>` 구조 (`PATCH /api/pricing`).

## 설계에 주는 영향

1. **"OmniRoute 비용과 대조해 보정"(v2 5.4·5.5)은 뺀다.** 둘 다 추정치라 대조할 기준이 없다. 기준 데이터는 토큰이고, 비용은 가격표로 계산한 값으로 표시한다.
2. **OmniRoute가 이미 키별 분석과 한도 차단을 정확히 한다.** 회원 키를 OmniRoute 키에 1:1로 묶으면, 프록시가 스트림을 파싱해 직접 기록하지 않아도 회원별 분석·한도가 된다. 3장 구조(A안 / B안)를 다시 판단해야 한다.
3. 프록시를 두더라도 스트림 사용량은 본문에서 읽어야 한다 (헤더 0). OpenAI는 OmniRoute가 usage 청크를 넣어 주므로 프록시가 `include_usage`를 강제할 필요가 없다.
4. 요청 단위로 OmniRoute 로그와 짝짓는 설계는 쓰지 않는다.
5. 관리 API 호출은 `oma_live_…` 토큰으로 하고, 쿠키 방식을 쓸 일이 있으면 `Origin` 헤더를 붙인다.
6. 분석 API 응답 형식은 명세에 없다. OmniRoute 버전을 고정하고, 응답 형식 검사 테스트를 둔다.

## 정리

- 시험 컨테이너 `omni-phase0`와 가짜 서버(node, :18080)는 설계 확정 때까지 켜 둔다. 끝나면 `docker rm -f omni-phase0 && docker volume rm omni-phase0-data`, 가짜 서버 프로세스 종료.
