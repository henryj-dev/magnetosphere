// 설치 뒤 메일 설정 API (3단계 실행판 M2.T5, Q20 (가)). 설치 때 메일을 건너뛴 설치도 open·domain_allowlist 를 고를 수 있게 한다 (Q15).
//   PUT  /api/admin/settings/mail { provider: "resend", from, apiKey } → 200 { mailConfigured: true, provider, from }
//        설치(setup/index.ts)와 같은 검사(validMailInput)·같은 암호화 AAD(app_settings.mail_settings.apiKey)로 저장한다. 응답·감사 기록에 API 키를 넣지 않는다.
//        설정 쓰기와 감사 기록 settings.update 는 한 트랜잭션(D1 은 batch)이다. 메일 설정을 지우는 API 는 없다 (Q15).
//   POST /api/admin/settings/mail/test → 200 { sent: true }. 관리자 자신에게 테스트 메일 한 통. 관리자당 1시간 5회 (429 rate_limited).
//        메일 설정이 없으면 409 mail_required, 보내지 못하면 502 mail_failed.
// 활성 관리자만, 변경 요청은 같은 출처만 (app.ts sameOrigin).
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Services } from "../app.ts";
import { consume, sessionAdmin } from "../routes/guard.ts";
import { commitAppSetting, mailConfigured } from "../settings/index.ts";
import { MAIL_SETTINGS_KEY, storedMailSettings, validMailInput } from "../setup/mail.ts";

/** 테스트 메일 요청 수 제한: 관리자당 1시간 5회 */
export const MAIL_TEST_LIMIT = { max: 5, windowMs: 60 * 60_000 } as const;

export function mailSettingsRoutes(services: () => Promise<Services>) {
  const r = new Hono();
  r.put("/", async (c) => {
    const s = await services();
    const admin = await sessionAdmin(c, s);
    if (admin instanceof Response) return admin;
    if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) return c.json({ error: "invalid_body" }, 400);
    const body = await c.req.json().catch(() => null);
    if (!validMailInput(body)) return c.json({ error: "invalid_mail" }, 400);
    const stored = await storedMailSettings(body, s.cipher);
    const now = new Date();
    await commitAppSetting(s.db, MAIL_SETTINGS_KEY, stored, admin.id, now, {
      actorId: admin.id,
      action: "settings.update",
      target: "mail",
      // 보내는 주소(이메일)와 API 키는 넣지 않는다 (Q17)
      detail: { section: "mail", provider: stored.provider },
      ip: (await s.clientIp?.(c.req.raw)) ?? null,
      now,
    });
    return c.json({ mailConfigured: true, provider: stored.provider, from: stored.from });
  });
  r.post("/test", async (c) => {
    const s = await services();
    const admin = await sessionAdmin(c, s);
    if (admin instanceof Response) return admin;
    if (!(await consume(s.db, `mail-test|${admin.id}`, MAIL_TEST_LIMIT.max, MAIL_TEST_LIMIT.windowMs, Date.now()))) return c.json({ error: "rate_limited" }, 429);
    if (!(await mailConfigured(s.db)) || !s.mailer) return c.json({ error: "mail_required" }, 409);
    const u = s.db.schema.user;
    const [row] = await s.db.db.select({ email: u.email }).from(u).where(eq(u.id, admin.id));
    try {
      await s.mailer.send({
        to: row.email,
        subject: "Magnetosphere 테스트 메일",
        text: "메일 설정이 동작합니다. 이 메일은 관리자가 설정 API 로 보낸 테스트 메일입니다.",
        html: "<p>메일 설정이 동작합니다. 이 메일은 관리자가 설정 API 로 보낸 테스트 메일입니다.</p>",
      });
    } catch (e) {
      console.error("[mail] 테스트 메일을 보내지 못했다", e);
      return c.json({ error: "mail_failed" }, 502);
    }
    return c.json({ sent: true });
  });
  return r;
}
