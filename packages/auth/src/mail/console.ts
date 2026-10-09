// 콘솔 어댑터 (개발용). 메일을 보내지 않고 내용을 출력한다. 출력 함수는 바꿔 끼울 수 있다 (테스트가 가로챈다).
import type { MailMessage, Mailer } from "./types.ts";

export function consoleMailer(opts: { write?: (line: string) => void } = {}): Mailer {
  const write = opts.write ?? ((line: string) => console.log(line));
  return {
    async send(msg: MailMessage) {
      write(`[mail:console] 받는 사람: ${msg.to}\n[mail:console] 제목: ${msg.subject}\n${msg.text}`);
    },
  };
}
