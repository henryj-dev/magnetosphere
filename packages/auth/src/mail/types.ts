// 메일 어댑터 공통 인터페이스 (계획서 4.8). 어댑터는 실패하면 예외를 던진다. 조용히 삼키지 않는다.
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/** 공급자 오류 응답. 상태 코드와 본문 일부를 담는다 */
export class MailError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | null,
    detail: string,
  ) {
    super(`[mail:${provider}] 보내지 못했다${status === null ? "" : ` (HTTP ${status})`}: ${detail.slice(0, 500)}`);
    this.name = "MailError";
  }
}
