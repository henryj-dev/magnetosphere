// M1.T1 설정 저장소 (SQLite). 값 검사·정규화(TC-M1.T1.a), 정책 검사(TC-M1.T1.b), 시드 기본값 채우기(TC-M1.T1.c).
// 동시 쓰기는 다섯 DB 에서 따로 본다 (concurrent.db.test.ts·concurrent.workers.test.ts, TC-M1.T1.d).
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, seedAppSettings } from "@magnetosphere/db/src/seed.ts";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { mailConfigured, readSettings, SettingsError, writeAppSetting, writeSetting, type SettingKey } from "../../src/settings/index.ts";
import { MAIL_SETTINGS_KEY } from "../../src/setup/mail.ts";
import { makeTestEnv, type TestEnv } from "../helpers.ts";

const NOW = new Date("2026-10-11T00:00:00.000Z");
let t: TestEnv;
let h: DbHandle;
beforeEach(async () => {
  t = await makeTestEnv();
  h = await connectNode(t.env.DATABASE_URL);
});
afterEach(async () => {
  await h?.close();
  t?.cleanup();
});

const rows = async () => {
  const s = h.schema.appSettings;
  return (await h.db.select().from(s)).map((r: any) => [r.key, r.value, r.updatedAt?.getTime(), r.updatedBy]).sort();
};

/** 그 쓰기가 SettingsError(code) 를 던지고 app_settings 가 그대로인지 */
async function rejected(key: SettingKey, value: unknown, code: string): Promise<void> {
  const before = await rows();
  const err = await writeSetting(h, key, value, "admin-1", NOW).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `${key} = ${JSON.stringify(value)}`).toBeInstanceOf(SettingsError);
  expect((err as SettingsError).code, `${key} = ${JSON.stringify(value)}`).toBe(code);
  expect(await rows(), `${key} = ${JSON.stringify(value)}: 행 변화 0`).toEqual(before);
}

const stored = async (key: string) => {
  const s = h.schema.appSettings;
  const [r] = await h.db.select().from(s).where(eq(s.key, key));
  return r ? JSON.parse(r.value) : undefined;
};

describe("M1.T1 설정 저장소", () => {
  it("TC-M1.T1.a 잘못된 설정 값은 SettingsError·행 변화 0, 도메인은 소문자·punycode 로 저장한다 (Q14·Q16)", async () => {
    await seedAppSettings(h.db, h.schema as { appSettings: unknown }, NOW);
    const bad: [SettingKey, unknown][] = [
      ["signup_mode", "Open"],
      ["signup_mode", "anyone"],
      ["daily_signup_cap", -1],
      ["daily_signup_cap", 1.5],
      ["daily_signup_cap", "20"],
      ["allowed_domains", ["*.a.com"]],
      ["allowed_domains", ["a.com:443"]],
      ["allowed_domains", ["user@a.com"]],
      ["allowed_domains", ["localhost"]],
      ["allowed_domains", "a.com"],
      ["allowed_domains", Array.from({ length: 101 }, (_, i) => `d${i}.example`)],
      ["default_limit_usd", 1e13],
      ["default_limit_usd", -0.01],
      // Q16 남은 결정 (가): 기본 한도 null(무제한)은 받지 않는다
      ["default_limit_usd", null],
      ["default_limit_usd", Number.POSITIVE_INFINITY],
      ["default_max_keys", -1],
      ["default_max_keys", 2.5],
      ["signup_requires_approval", "true"],
    ];
    for (const [key, value] of bad) await rejected(key, value, "invalid_value");
    // 모르는 키는 정책 쓰기로 받지 않고, 정책 키는 검사 없는 쓰기로 받지 않는다
    await expect(writeSetting(h, "public_base_url" as SettingKey, "https://x", null, NOW)).rejects.toMatchObject({ code: "unknown_key" });
    await expect(writeAppSetting(h, "daily_signup_cap", -1, null, NOW)).rejects.toMatchObject({ code: "unknown_key" });
    expect(await stored("daily_signup_cap")).toBe(DEFAULT_SETTINGS.daily_signup_cap);

    // 대조: 맞는 값은 저장된다. 도메인은 가입 이메일과 같은 꼴(소문자·punycode)로 바꿔 저장한다
    expect(await writeSetting(h, "allowed_domains", ["A.COM"], "admin-1", NOW)).toEqual(["a.com"]);
    expect(await stored("allowed_domains")).toEqual(["a.com"]);
    await writeSetting(h, "allowed_domains", ["bücher.example", " Sub.A.com ", "a.com", "A.com"], "admin-1", NOW);
    expect(await stored("allowed_domains")).toEqual(["xn--bcher-kva.example", "sub.a.com", "a.com"]);
    expect((await readSettings(h)).allowed_domains).toEqual(["xn--bcher-kva.example", "sub.a.com", "a.com"]);
    await writeSetting(h, "daily_signup_cap", null, "admin-1", NOW);
    expect((await readSettings(h)).daily_signup_cap, "null = 상한 없음 (Q13)").toBeNull();
    await writeSetting(h, "daily_signup_cap", 0, "admin-1", NOW);
    expect((await readSettings(h)).daily_signup_cap).toBe(0);
    await writeSetting(h, "default_limit_usd", 999_999.999_999, "admin-1", NOW);
    expect((await readSettings(h)).default_limit_usd).toBe(999_999.999_999);
    await writeSetting(h, "default_limit_usd", 0, "admin-1", NOW);
    expect((await readSettings(h)).default_limit_usd).toBe(0);
    // 쓴 사람·시각이 남는다
    const s = h.schema.appSettings;
    const [row] = await h.db.select().from(s).where(eq(s.key, "default_limit_usd"));
    expect({ by: row.updatedBy, at: row.updatedAt.getTime() }).toEqual({ by: "admin-1", at: NOW.getTime() });
  });

  it("TC-M1.T1.b 메일·도메인·IdP 가 없으면 그 정책을 저장하지 않는다 — signup_mode 그대로 (Q15·Q18)", async () => {
    await seedAppSettings(h.db, h.schema as { appSettings: unknown }, NOW);
    expect(await mailConfigured(h)).toBe(false);
    await rejected("signup_mode", "open", "mail_required");
    await rejected("signup_mode", "domain_allowlist", "mail_required");
    await rejected("signup_mode", "sso_only", "no_idp");
    // 메일이 생기면 open 은 되지만, 도메인이 비면 domain_allowlist 는 안 된다
    await writeAppSetting(h, MAIL_SETTINGS_KEY, { provider: "resend", from: "a@b.example", apiKey: "enc" }, "admin-1", NOW);
    expect(await mailConfigured(h)).toBe(true);
    await rejected("signup_mode", "domain_allowlist", "domains_required");
    await rejected("signup_mode", "sso_only", "no_idp");
    expect((await readSettings(h)).signup_mode, "거부 뒤 signup_mode 그대로").toBe("invite_only");

    // 대조: 조건을 채우면 저장된다
    await writeSetting(h, "signup_mode", "open", "admin-1", NOW);
    expect((await readSettings(h)).signup_mode).toBe("open");
    await writeSetting(h, "allowed_domains", ["a.com"], "admin-1", NOW);
    await writeSetting(h, "signup_mode", "domain_allowlist", "admin-1", NOW);
    expect((await readSettings(h)).signup_mode).toBe("domain_allowlist");
    // domain_allowlist 인 동안 도메인을 비우지 못한다
    await rejected("allowed_domains", [], "domains_required");
    // 켜진 IdP 가 생기면 sso_only 도 저장된다 (5단계 경로). 꺼진 IdP 는 세지 않는다
    const p = h.schema.ssoProviderSettings;
    await h.db.insert(p).values({ providerId: "kc-off", displayName: "꺼짐", enabled: false });
    await rejected("signup_mode", "sso_only", "no_idp");
    await h.db.insert(p).values({ providerId: "kc", displayName: "Keycloak", enabled: true });
    await writeSetting(h, "signup_mode", "sso_only", "admin-1", NOW);
    expect((await readSettings(h)).signup_mode).toBe("sso_only");
    // 메일·도메인이 필요 없는 정책은 늘 저장된다
    for (const mode of ["invite_only", "closed"] as const) {
      await writeSetting(h, "signup_mode", mode, "admin-1", NOW);
      expect((await readSettings(h)).signup_mode).toBe(mode);
    }
    await writeSetting(h, "allowed_domains", [], "admin-1", NOW);
    expect((await readSettings(h)).allowed_domains).toEqual([]);
  });

  it("TC-M1.T1.c 읽기는 시드 기본값을 채운다 — allowed_domains 행 없음 → [], 시드 다섯 키 → 시드 값", async () => {
    // 행이 하나도 없어도(운영은 시드를 돌리지 않는다) 여섯 키가 모두 정해진 모양으로 온다
    expect(await readSettings(h)).toEqual({ ...DEFAULT_SETTINGS, allowed_domains: [] });
    await seedAppSettings(h.db, h.schema as { appSettings: unknown }, NOW);
    expect(await stored("allowed_domains"), "시드에 allowed_domains 는 없다").toBeUndefined();
    const s = await readSettings(h);
    expect(s).toEqual({ ...DEFAULT_SETTINGS, allowed_domains: [] });
    expect(Array.isArray(s.allowed_domains)).toBe(true);
  });

  it("TC-M1.T1.e 깨진 보안 설정 행은 더 닫힌 값으로 읽는다 — signup_mode closed·cap 0·승인 true·도메인 [], 기본 한도는 5, 경고 로그", async () => {
    await seedAppSettings(h.db, h.schema as { appSettings: unknown }, NOW);
    const t2 = h.schema.appSettings;
    const put = async (key: string, raw: string) => {
      await h.db.delete(t2).where(eq(t2.key, key));
      await h.db.insert(t2).values({ key, value: raw, updatedAt: NOW, updatedBy: null });
    };
    const warns: unknown[][] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void warns.push(a));
    try {
      // 손으로 고친 잘못된 값·깨진 JSON. 시드 값(invite_only·20·…)으로 읽으면 운영자가 둔 closed·0 보다 열린다
      await put("signup_mode", "{깨짐");
      await put("daily_signup_cap", JSON.stringify(-5));
      await put("signup_requires_approval", JSON.stringify("no"));
      await put("allowed_domains", JSON.stringify("a.com"));
      await put("default_limit_usd", JSON.stringify(null));
      expect(await readSettings(h)).toEqual({
        signup_mode: "closed",
        daily_signup_cap: 0,
        signup_requires_approval: true,
        allowed_domains: [],
        default_limit_usd: DEFAULT_SETTINGS.default_limit_usd,
        default_max_keys: DEFAULT_SETTINGS.default_max_keys,
      });
      const lines = warns.map((a) => a.map(String).join(" "));
      for (const key of ["signup_mode", "daily_signup_cap", "signup_requires_approval", "allowed_domains", "default_limit_usd"]) {
        expect(lines.some((l) => l.includes(key)), `경고 로그에 ${key}`).toBe(true);
      }
      // 대조: 맞는 값은 경고 없이 그대로다
      warns.length = 0;
      await put("signup_mode", JSON.stringify("open"));
      expect((await readSettings(h)).signup_mode).toBe("open");
      expect(warns.map((a) => a.map(String).join(" ")).some((l) => l.includes("signup_mode"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
