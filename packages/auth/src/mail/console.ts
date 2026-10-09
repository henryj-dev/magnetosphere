// 콘솔 어댑터 (개발용). 메일을 보내지 않고 내용을 출력한다. 출력 함수는 바꿔 끼울 수 있다 (테스트가 가로챈다).
import type { MailMessage, Mailer } from "./types.ts";

// 메일 본문에는 인증·재설정 토큰이 든 링크가 있다. 운영에서 로그로 새지 않게 NODE_ENV=production 이면 만들기를 거부한다
// (S3 보안 리뷰 L3). Workers 처럼 process 가 없는 곳에서는 globalThis.process 가 없어 이 검사를 건너뛴다.
export function consoleMailer(opts: { write?: (line: string) => void } = {}): Mailer {
  if ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.NODE_ENV === "production") {
    throw new Error("콘솔 메일 어댑터는 개발용이다. NODE_ENV=production 에서는 쓸 수 없다 (메일 링크의 토큰이 로그에 남는다)");
  }
  const write = opts.write ?? ((line: string) => console.log(line));
  return {
    async send(msg: MailMessage) {
      write(`[mail:console] 받는 사람: ${msg.to}\n[mail:console] 제목: ${msg.subject}\n${msg.text}`);
    },
  };
}
