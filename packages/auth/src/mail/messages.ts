// 인증 메일·비밀번호 재설정 메일 본문. 링크는 Better Auth 가 BETTER_AUTH_URL(baseURL)로 만든 것을 그대로 넣는다.
import type { MailMessage } from "./types.ts";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function message(to: string, subject: string, lead: string, url: string, tail: string): MailMessage {
  return {
    to,
    subject,
    text: `${lead}\n\n${url}\n\n${tail}\n`,
    html: `<p>${escapeHtml(lead)}</p><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p><p>${escapeHtml(tail)}</p>`,
  };
}

export const VERIFY_SUBJECT = "[Magnetosphere] 이메일 주소 인증";
export const RESET_SUBJECT = "[Magnetosphere] 비밀번호 재설정";

export const verifyEmailMessage = (to: string, url: string) =>
  message(to, VERIFY_SUBJECT, "아래 링크를 열어 이메일 주소 인증을 마쳐 주세요.", url, "직접 가입하지 않았다면 이 메일은 무시해도 됩니다.");

export const resetPasswordMessage = (to: string, url: string) =>
  message(to, RESET_SUBJECT, "아래 링크를 열어 새 비밀번호를 정해 주세요. 링크는 한 번만 쓸 수 있습니다.", url, "요청하지 않았다면 이 메일은 무시해도 됩니다. 비밀번호는 바뀌지 않습니다.");
