// wrangler-dev.mjs 의 타입 (E2E 실행기가 node 로 바로 import 하므로 구현은 .mjs 로 둔다)
export declare const SERVER_DIR: string;
export declare const ROOT: string;
export declare function freePort(): Promise<number>;
export declare function wrangler(args: string[], env?: Record<string, string>): { code: number; out: string; err: string };
export declare function d1Query(persistTo: string, sql: string): Record<string, any>[];
export interface WranglerDev {
  baseUrl: string;
  output(): string;
  waitOutput(re: RegExp, n?: number, timeoutMs?: number): Promise<string>;
  close(): Promise<void>;
}
export declare function startWranglerDev(opts: {
  env?: "d1" | "mysql" | "pg";
  persistTo: string;
  vars: Record<string, string>;
  hyperdrive?: string;
  config?: string;
  testScheduled?: boolean;
}): Promise<WranglerDev>;
export declare function lastSetupToken(output: string): string | null;
