// 런타임 어댑터 인터페이스 (계획서 3.2 "플랫폼 의존 코드는 런타임 어댑터로 모은다").
// 구현은 둘이다: node.ts (Docker — SQLite·MySQL·Postgres), workers.ts (Workers — D1·Hyperdrive MySQL·Postgres).
// 이 파일은 두 런타임 모두에서 import 된다. Node 전용 모듈을 여기서 부르지 않는다.
import type { ClientIp } from "@magnetosphere/auth";
import type { Lease } from "./lease.ts";

export type { ClientIp } from "@magnetosphere/auth";

/** 생성 스키마 세 벌 중 무엇을 쓰는지. D1 은 sqlite 를 쓴다 */
export type Provider = "sqlite" | "mysql" | "pg";

/**
 * DB 연결 하나. db·provider·schema 는 packages/auth 의 AuthDatabase 와 같은 모양이라 createAuth 에 그대로 넘긴다.
 * 연결은 항상 세션 시간대를 UTC 로 맞춘 상태다 (TC-S4.T1.d).
 */
export interface DbHandle {
  kind: "sqlite" | "mysql" | "pg" | "d1";
  provider: Provider;
  /** 생성 스키마(@magnetosphere/db/src/schema/*.ts)로 만든 Drizzle 연결. 방언마다 타입이 달라 느슨하게 둔다 */
  db: any;
  schema: Record<string, any>;
  close(): Promise<void>;
}

/** 주기 작업이 받는 것. 작업은 임대를 잡은 동안만 돈다 (K1.T2) */
export interface JobContext {
  db: DbHandle;
  /** 이 실행의 임대. DB 쓰기에 fenced(db, lease) 를 붙이면 임대를 잃은 뒤의 쓰기가 0행이 된다 */
  lease: Lease;
  /** 임대를 잃으면(하트비트 실패) 끊긴다. OmniRoute 호출에 넘겨 함께 멈춘다 */
  signal: AbortSignal;
}

export type Job = (ctx: JobContext) => Promise<void>;

/**
 * 요청 수 제한 저장소. Better Auth rateLimit 저장소는 스키마를 바꾸는 옵션이라 packages/db 의 AUTH_SCHEMA_OPTIONS 에
 * storage: "database" 로 고정돼 있다 (계획서 v5.4 3.2, TC-S3.T1.e). 어댑터는 그 값을 알려 주기만 한다.
 */
export interface RateLimitStore {
  storage: "database";
}

export interface Runtime {
  /** DB 연결. Node 는 프로세스 하나에 풀 하나, Workers 는 요청마다 새 연결 (V27) */
  db(): Promise<DbHandle>;
  /** 주기 작업. Node 는 프로세스 안 타이머, Workers 는 Cron Trigger 가 부른다. 둘 다 job_leases 임대 아래에서 돈다 */
  schedule(name: string, cron: string, fn: Job): void;
  rateLimitStore(): RateLimitStore;
  /** 비밀 값 (Node 는 환경 변수, Workers 는 env 바인딩). 없으면 undefined */
  secret(name: string): string | undefined;
  /** 요청의 클라이언트 IP. 못 정하면 null. packages/auth 의 요청 수 제한이 쓴다 */
  clientIp: ClientIp;
  /** 연결·타이머 정리 */
  close(): Promise<void>;
}

/**
 * 1단계 주기 작업이 쓰는 cron 모양만 받는다: "* * * * *"(매분), "*\/N * * * *"(N분마다, N 은 60 의 약수).
 * Workers Cron Trigger 와 같은 문자열을 쓰려고 cron 형식을 유지한다. 다른 모양은 조용히 틀리게 돌지 않게 거부한다.
 */
export function cronIntervalMinutes(cron: string): number {
  const m = /^(\*|\*\/(\d+)) \* \* \* \*$/.exec(cron.trim());
  const n = m ? (m[2] ? Number(m[2]) : 1) : NaN;
  if (!Number.isInteger(n) || n < 1 || 60 % n !== 0) throw new Error(`지원하지 않는 cron 모양: "${cron}" ("* * * * *" 또는 "*/N * * * *", N 은 60 의 약수)`);
  return n;
}

/**
 * clientIp 가 실제 요청에서 IP 를 정하는지 확인한다 (TC-S4.T1.e).
 * null 이면 Better Auth 가 모든 요청을 경로마다 한 칸에 세어 로그인 6번째 요청부터 전원이 429 를 받으므로 시작을 거부한다.
 */
export async function assertClientIp(clientIp: ClientIp, probe: Request): Promise<string> {
  const ip = await clientIp(probe);
  if (!ip) throw new Error("clientIp 가 요청의 클라이언트 IP 를 정하지 못한다. 신뢰 프록시·소켓 설정을 확인하라 (TC-S4.T1.e)");
  return ip;
}
