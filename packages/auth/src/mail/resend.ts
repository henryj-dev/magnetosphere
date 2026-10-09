// Resend 어댑터 (fetch, Node·Workers 공용). https://resend.com/docs/api-reference/emails/send-email
import { MailError, type MailMessage, type Mailer } from "./types.ts";

export const RESEND_ENDPOINT = "https://api.resend.com/emails";

export function resendMailer(opts: { apiKey: string; from: string; fetch?: typeof fetch }): Mailer {
  const doFetch = opts.fetch ?? fetch;
  return {
    async send(msg: MailMessage) {
      const res = await doFetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: opts.from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
      });
      if (!res.ok) throw new MailError("resend", res.status, await res.text().catch(() => ""));
    },
  };
}
