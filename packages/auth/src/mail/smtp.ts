// SMTP 어댑터 (nodemailer, Node 전용). Workers 가 import 하는 경로(src/index.ts, src/mail/index.ts)에서 부르지 않는다.
// 별도 진입점 @magnetosphere/auth/mail/smtp 로만 쓴다.
import nodemailer from "nodemailer";
import { MailError, type MailMessage, type Mailer } from "./types.ts";

export interface SmtpOptions {
  host: string;
  port: number;
  /** true: 처음부터 TLS (보통 465). false: 평문으로 붙고 서버가 STARTTLS 를 내면 올린다 (보통 587) */
  secure: boolean;
  /**
   * secure false 일 때 STARTTLS 를 강제한다. 서버가 STARTTLS 를 내지 않으면 보내지 않는다.
   * 기본값은 !secure — 중간자가 STARTTLS 를 벗겨 내면 비밀번호와 재설정 링크가 평문으로 나가므로 (S3 보안 리뷰 L2).
   * 평문 개발 서버(mailpit 등)에만 명시적으로 false 를 준다.
   */
  requireTLS?: boolean;
  user?: string;
  pass?: string;
  from: string;
}

// 단계별 제한(nodemailer)과 한 번 보내는 데 걸리는 총 상한. 소켓이 계속 조금씩 움직여도 총 상한에서 끊는다 (M5 리뷰 MEDIUM).
const CONNECTION_TIMEOUT_MS = 5_000;
const GREETING_TIMEOUT_MS = 5_000;
const SOCKET_TIMEOUT_MS = 10_000;
const TOTAL_DEADLINE_MS = 15_000;
const TIMEOUT_DETAIL = "SMTP 서버 응답 시간 초과";

class SmtpDeadline extends Error {}

export function smtpMailer(opts: SmtpOptions): Mailer {
  return {
    async send(msg: MailMessage) {
      // 보낼 때마다 transport 를 따로 만들고 닫는다 — 닫아도 동시에 보내는 다른 요청이 끊기지 않는다
      const transport = nodemailer.createTransport({
        host: opts.host,
        port: opts.port,
        secure: opts.secure,
        requireTLS: opts.requireTLS ?? !opts.secure,
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        greetingTimeout: GREETING_TIMEOUT_MS,
        socketTimeout: SOCKET_TIMEOUT_MS,
        ...(opts.user ? { auth: { user: opts.user, pass: opts.pass ?? "" } } : {}),
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          transport.sendMail({ from: opts.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new SmtpDeadline()), TOTAL_DEADLINE_MS);
          }),
        ]);
      } catch (e) {
        // 시간 초과는 라이브러리 원문 대신 고정 문구만 쓴다 (호스트·주소가 API 응답과 로그에 새지 않게)
        const timedOut = e instanceof SmtpDeadline || (e as { code?: unknown }).code === "ETIMEDOUT";
        throw new MailError("smtp", null, timedOut ? TIMEOUT_DETAIL : (e as Error).message);
      } finally {
        clearTimeout(timer);
        transport.close();
      }
    },
  };
}
