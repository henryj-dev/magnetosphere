// Node·Workers 공용 메일 어댑터. SMTP(nodemailer, Node 전용)는 @magnetosphere/auth/mail/smtp 에서 따로 가져온다.
export type { MailMessage, Mailer } from "./types.ts";
export { MailError } from "./types.ts";
export { consoleMailer } from "./console.ts";
export { resendMailer, RESEND_ENDPOINT } from "./resend.ts";
export { cloudflareBindingMailer, cloudflareRestMailer, cloudflareEndpoint, type SendEmailBinding } from "./cloudflare.ts";
export { verifyEmailMessage, resetPasswordMessage, VERIFY_SUBJECT, RESET_SUBJECT } from "./messages.ts";
