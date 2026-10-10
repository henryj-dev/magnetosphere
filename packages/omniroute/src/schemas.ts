// OmniRoute 3.8.51 응답 중 회원 앱이 쓰는 필드만 검사한다 (계획서 5.6). 모르는 필드는 버린다.
// 형식이 바뀌면 조용히 NaN·0·undefined 가 흐르지 않고 OmniRouteFormatError 가 난다 (TC-S5.T2.f).
// 필드 근거: docs/research/phase0-omniroute.md, docs/verify/V10.json, 계약 환경 실측.
import { z } from "zod";

export const SCOPES = ["read", "write", "admin"] as const;
export const scopeSchema = z.enum(SCOPES);

/** POST /api/cli/connect */
export const accessTokenSchema = z.object({
  token: z.string().startsWith("oma_live_"),
  id: z.string().min(1),
  scope: scopeSchema,
  expiresAt: z.string().nullable(),
});

/** GET /api/cli/whoami */
export const whoamiSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  scope: scopeSchema,
  expiresAt: z.string().nullable(),
});

/** POST /api/keys. key 는 원문이고 이때 한 번만 온다 */
export const createdKeySchema = z.object({
  id: z.string().min(1),
  key: z.string().startsWith("sk-"),
  name: z.string(),
});

/**
 * GET /api/keys. scopes 는 정합성 점검이 manage·admin 이 붙은 키를 찾는 데 쓴다 (계획서 5.8).
 * total 은 키 전체 수다. limit 을 주지 않으면 모든 키가 한 번에 온다 (V28). 어댑터는 keys 가 total 보다 적으면 오류로 끝낸다
 */
export const keyListSchema = z.object({
  total: z.number().int().nonnegative(),
  keys: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      isActive: z.boolean(),
      scopes: z.array(z.string()),
    }),
  ),
});

/** PATCH /api/keys/{id}. 바꾼 값만 돌려준다 */
export const keyActiveSchema = z.object({ isActive: z.boolean() });
export const keyNameSchema = z.object({ name: z.string() });

/** POST /api/usage/budget */
export const budgetSchema = z.object({
  success: z.literal(true),
  apiKeyId: z.string(),
  budget: z.object({
    monthlyLimitUsd: z.number(),
    resetInterval: z.enum(["daily", "weekly", "monthly"]),
  }),
});

// 비용은 음수일 수 없다. 음수가 오면 남은 한도 계산이 한도를 늘린다 (S5 보안 리뷰 L4)
const money = z.number().finite().nonnegative();
const count = z.number().int().nonnegative();

/** GET /api/usage/analytics */
export const analyticsSchema = z.object({
  summary: z.object({
    totalCost: money,
    totalRequests: count,
    promptTokens: count,
    completionTokens: count,
  }),
  byApiKey: z.array(
    z.object({
      apiKeyId: z.string().nullable(),
      requests: count,
      cost: money,
    }),
  ),
});

/**
 * GET /api/usage/call-logs. 요청 하나에 진행 기록과 완료 기록 두 줄이 온다 (0단계 2절).
 * 진행 기록은 apiKeyId 가 비어 있다. 어댑터는 apiKeyId 가 있는 완료 기록만 돌려준다.
 */
export const callLogsSchema = z.array(
  z.object({
    id: z.string(),
    timestamp: z.string(),
    status: z.number().int(),
    model: z.string().nullable(),
    requestedModel: z.string().nullable(),
    apiKeyId: z.string().nullable(),
    tokens: z.object({
      in: count.nullable(),
      out: count.nullable(),
      cacheRead: count.nullable().optional(),
      cacheWrite: count.nullable().optional(),
    }),
  }),
);

/** 본문을 쓰지 않는 응답 (DELETE, 로그인) */
export const unusedBodySchema = z.unknown();
