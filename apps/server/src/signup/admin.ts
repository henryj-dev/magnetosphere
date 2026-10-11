// 가입 정책 설정 API (3단계 실행판 M2.T5, 계획서 4.2, Q15·Q16·Q18). 화면은 7단계다.
//   GET   /api/admin/settings/signup → 200 { settings, updatedAt, mailConfigured }
//   PATCH /api/admin/settings/signup { signupMode?, allowedDomains?, signupRequiresApproval?, dailySignupCap?, defaultLimitUsd?, defaultMaxKeys?,
//                                      updatedAt: { <바꾸는 필드>: <GET 이 준 updatedAt, 행이 없었으면 null> } } → 200 (GET 과 같은 모양)
//   - 활성 관리자만 (역할·상태는 DB 에서 읽는다, routes/guard.ts sessionAdmin). 변경 요청은 같은 출처만 (app.ts 가 /api/admin/* 에 sameOrigin).
//   - 값 검사·정책 검사는 설정 저장소(settings/)가 한다: 잘못된 값 400 invalid_value, 메일 없음 409 mail_required, 빈 허용 도메인 409 domains_required,
//     IdP 없음 409 no_idp. default_limit_usd 의 null 은 400 이다 (Q16 (가)).
//   - 키 단위로 쓴다. 바꾸는 키만, 읽은 updatedAt 이 그대로일 때만 쓴다. 그사이 다른 관리자가 그 키를 썼으면 409 stale_setting 이고 아무것도 바뀌지 않는다.
//   - 설정 쓰기와 감사 기록 settings.update 는 한 트랜잭션(D1 은 batch)이다. detail 은 바뀐 키와 앞뒤 값, 허용 도메인은 개수만 (Q17).
//   - 다음 가입부터 바로 적용된다. 판정은 요청마다 DB 에서 읽는다 (인스턴스 캐시 없음, TC-M2.T5.a).
import { Hono } from "hono";
import type { Services } from "../app.ts";
import { sessionAdmin } from "../routes/guard.ts";
import { checkSettings, commitSettings, mailConfigured, readSettings, SettingsError, settingsUpdatedAt, type SettingKey, type SignupSettings } from "../settings/index.ts";

/** API 필드 → 설정 키 */
const FIELDS = {
  signupMode: "signup_mode",
  allowedDomains: "allowed_domains",
  signupRequiresApproval: "signup_requires_approval",
  dailySignupCap: "daily_signup_cap",
  defaultLimitUsd: "default_limit_usd",
  defaultMaxKeys: "default_max_keys",
} as const satisfies Record<string, SettingKey>;
type Field = keyof typeof FIELDS;
const isField = (k: string): k is Field => Object.hasOwn(FIELDS, k);
const fieldOf = (key: SettingKey) => (Object.keys(FIELDS) as Field[]).find((f) => FIELDS[f] === key)!;

async function view(s: Services) {
  const [settings, updatedAt, mail] = await Promise.all([readSettings(s.db), settingsUpdatedAt(s.db, Object.values(FIELDS)), mailConfigured(s.db)]);
  return {
    settings: Object.fromEntries((Object.keys(FIELDS) as Field[]).map((f) => [f, settings[FIELDS[f]]])),
    updatedAt: Object.fromEntries((Object.keys(FIELDS) as Field[]).map((f) => [f, updatedAt[FIELDS[f]]?.toISOString() ?? null])),
    mailConfigured: mail,
  };
}

/** 감사 기록의 앞뒤 값. 허용 도메인은 개수만 남긴다 (도메인 목록은 운영 정보라 기록을 무겁게 하지 않는다) */
function change(key: SettingKey, before: SignupSettings, after: unknown) {
  if (key === "allowed_domains") return { fromCount: before.allowed_domains.length, toCount: (after as string[]).length };
  return { from: before[key], to: after };
}

/** 읽은 updatedAt. ISO 문자열이거나 null(행이 없었음). 그 밖은 undefined (잘못된 본문) */
function expectedAt(v: unknown): Date | null | undefined {
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function signupSettingsRoutes(services: () => Promise<Services>) {
  const r = new Hono();
  r.get("/", async (c) => {
    const s = await services();
    const admin = await sessionAdmin(c, s);
    if (admin instanceof Response) return admin;
    return c.json(await view(s));
  });
  r.patch("/", async (c) => {
    const s = await services();
    const admin = await sessionAdmin(c, s);
    if (admin instanceof Response) return admin;
    if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) return c.json({ error: "invalid_body" }, 400);
    const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return c.json({ error: "invalid_body" }, 400);
    const { updatedAt, ...body } = raw;
    const fields = Object.keys(body);
    if (fields.length === 0 || !fields.every(isField)) return c.json({ error: "invalid_body" }, 400);
    if (!updatedAt || typeof updatedAt !== "object" || Array.isArray(updatedAt)) return c.json({ error: "invalid_body" }, 400);
    const expected: Partial<Record<Field, Date | null>> = {};
    for (const f of fields) {
      const at = expectedAt((updatedAt as Record<string, unknown>)[f]);
      if (at === undefined) return c.json({ error: "invalid_body", field: f }, 400);
      expected[f] = at;
    }

    const changes = Object.fromEntries(fields.map((f) => [FIELDS[f], body[f]]));
    let normalized: Partial<SignupSettings>;
    try {
      normalized = await checkSettings(s.db, changes);
    } catch (e) {
      if (!(e instanceof SettingsError)) throw e;
      const field = fieldOf(e.key as SettingKey);
      return e.code === "invalid_value" || e.code === "unknown_key" ? c.json({ error: e.code, field }, 400) : c.json({ error: e.code, field }, 409);
    }
    const before = await readSettings(s.db);
    const keys = Object.keys(normalized) as SettingKey[];
    const now = new Date();
    try {
      await commitSettings(
        s.db,
        keys.map((key) => ({ key, value: normalized[key], expected: expected[fieldOf(key)] ?? null })),
        admin.id,
        now,
        {
          actorId: admin.id,
          action: "settings.update",
          target: "signup",
          detail: { section: "signup", changes: Object.fromEntries(keys.map((key) => [key, change(key, before, normalized[key])])) },
          ip: (await s.clientIp?.(c.req.raw)) ?? null,
          now,
        },
      );
    } catch (e) {
      if (e instanceof SettingsError && e.code === "stale_setting") return c.json({ error: "stale_setting" }, 409);
      throw e;
    }
    return c.json(await view(s));
  });
  return r;
}
