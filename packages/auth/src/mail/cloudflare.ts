// Cloudflare Email Service 어댑터 (Node·Workers 공용).
// - Workers: send_email 바인딩 (env.EMAIL). from 객체 키는 email. 실패하면 바인딩이 E_* 코드로 예외를 던진다.
// - 그 밖: REST POST /accounts/{account_id}/email/sending/send. from 객체 키는 address. 응답은 Cloudflare 봉투
//   { success, errors, result: { delivered, permanent_bounces, queued } }.
//   https://developers.cloudflare.com/api/resources/email_sending/methods/send
import { MailError, type MailMessage, type Mailer } from "./types.ts";

/** Workers send_email 바인딩에서 쓰는 부분 */
export interface SendEmailBinding {
  send(msg: { to: string; from: { email: string; name?: string }; subject: string; text: string; html: string }): Promise<unknown>;
}

export interface CloudflareFrom {
  email: string;
  name?: string;
}

export const cloudflareEndpoint = (accountId: string) => `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`;

export function cloudflareBindingMailer(opts: { binding: SendEmailBinding; from: CloudflareFrom }): Mailer {
  return {
    async send(msg: MailMessage) {
      try {
        await opts.binding.send({ to: msg.to, from: opts.from, subject: msg.subject, text: msg.text, html: msg.html });
      } catch (e) {
        const err = e as { code?: string; message?: string };
        throw new MailError("cloudflare", null, `${err.code ?? ""} ${err.message ?? String(e)}`.trim());
      }
    },
  };
}

export function cloudflareRestMailer(opts: { accountId: string; apiToken: string; from: CloudflareFrom; fetch?: typeof fetch }): Mailer {
  const doFetch = opts.fetch ?? fetch;
  return {
    async send(msg: MailMessage) {
      const res = await doFetch(cloudflareEndpoint(opts.accountId), {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          to: msg.to,
          from: { address: opts.from.email, ...(opts.from.name ? { name: opts.from.name } : {}) },
          subject: msg.subject,
          text: msg.text,
          html: msg.html,
        }),
      });
      const body = await res.text().catch(() => "");
      if (!res.ok) throw new MailError("cloudflare", res.status, body);
      let json: any = null;
      try {
        json = JSON.parse(body);
      } catch {}
      if (json?.success === false) throw new MailError("cloudflare", res.status, body);
      if (json?.result?.permanent_bounces?.length) throw new MailError("cloudflare", res.status, `영구 반송: ${JSON.stringify(json.result.permanent_bounces)}`);
    },
  };
}
