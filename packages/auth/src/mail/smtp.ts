// SMTP 어댑터 (nodemailer, Node 전용). Workers 가 import 하는 경로(src/index.ts, src/mail/index.ts)에서 부르지 않는다.
// 별도 진입점 @magnetosphere/auth/mail/smtp 로만 쓴다.
import nodemailer from "nodemailer";
import { MailError, type MailMessage, type Mailer } from "./types.ts";

export interface SmtpOptions {
  host: string;
  port: number;
  /** true: 처음부터 TLS (보통 465). false: 평문으로 붙고 서버가 STARTTLS 를 내면 올린다 (보통 587) */
  secure: boolean;
  /** secure false 일 때 STARTTLS 를 강제한다. 서버가 STARTTLS 를 내지 않으면 보내지 않는다 */
  requireTLS?: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export function smtpMailer(opts: SmtpOptions): Mailer {
  const transport = nodemailer.createTransport({
    host: opts.host,
    port: opts.port,
    secure: opts.secure,
    requireTLS: opts.requireTLS ?? false,
    ...(opts.user ? { auth: { user: opts.user, pass: opts.pass ?? "" } } : {}),
  });
  return {
    async send(msg: MailMessage) {
      try {
        await transport.sendMail({ from: opts.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
      } catch (e) {
        throw new MailError("smtp", null, (e as Error).message);
      }
    },
  };
}
