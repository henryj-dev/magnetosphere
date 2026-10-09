// 인증 경로 요청 수 제한과 클라이언트 IP (계획서 3.2, 7장 "요청 수 제한").
//
// 요청 수 제한은 Better Auth 내장 rateLimit 을 쓴다. 저장소는 AUTH_SCHEMA_OPTIONS 의 storage: "database"
// (rate_limit 테이블)라 여러 인스턴스가 한도를 함께 센다. 키는 "<클라이언트 IP>|<경로>" 다.
//
// 클라이언트 IP: Better Auth 1.7.7 은 IP 를 요청 헤더에서만 읽는다 (@better-auth/core utils/ip getIP,
// advanced.ipAddress.ipAddressHeaders · trustedProxies). 소켓 상대 주소를 모르므로 "신뢰할 프록시에서 온 요청만
// X-Forwarded-For 를 믿는다"를 표현할 수 없다. trustedProxies 는 X-Forwarded-For 안의 홉을 오른쪽부터 걷어낼 뿐이라,
// 프록시를 거치지 않고 직접 온 요청이 헤더를 지어내면 그대로 믿는다.
// 그래서 handler 를 감싼다: 런타임 어댑터의 clientIp(req)(Node 는 소켓 주소 + 신뢰 프록시, Workers 는
// CF-Connecting-IP — S4.T1)로 IP 를 정하고, 우리만 쓰는 헤더 CLIENT_IP_HEADER 에 넣어 Better Auth 가 그 헤더만
// 읽게 한다 (ipAddressHeaders). 들어온 요청의 같은 이름 헤더는 항상 지우므로 클라이언트가 지어낼 수 없다.
// clientIp 가 null 이면 헤더를 비우고, Better Auth 는 모든 요청을 경로마다 한 칸("no-trusted-ip")에 센다.
import { getIPFromHeader, isValidIP } from "@better-auth/core/utils/ip";

/** 런타임 어댑터의 clientIp() 모양 (S4.T1 packages/runtime). 못 정하면 null */
export type ClientIp = (req: Request) => string | null | Promise<string | null>;

/** Better Auth 가 IP 를 읽는 유일한 헤더. withClientIp 만 쓴다 */
export const CLIENT_IP_HEADER = "x-magnetosphere-client-ip";

// 경로별 한도 (window 초 동안 max 회). 키는 Better Auth customRules 형식 (* 는 한 단계 와일드카드).
export const RATE_LIMIT_RULES = {
  "/sign-in/*": { window: 60, max: 5 },
  "/sign-up/*": { window: 60, max: 5 },
  "/request-password-reset": { window: 300, max: 3 },
  "/reset-password": { window: 300, max: 5 },
  "/reset-password/*": { window: 300, max: 10 },
  "/send-verification-email": { window: 300, max: 3 },
} as const;

/** Better Auth 옵션 조각 */
export function rateLimitOptions<S extends object>(schemaPart: S) {
  return {
    ...schemaPart,
    // 기본값은 운영 환경에서만 켜진다. 개발·테스트에서도 같은 규칙으로 돈다.
    enabled: true,
    window: 60,
    max: 100,
    customRules: RATE_LIMIT_RULES,
  };
}

export const ipAddressOptions = { ipAddressHeaders: [CLIENT_IP_HEADER] };

/** handler 앞에서 clientIp 로 IP 를 정해 CLIENT_IP_HEADER 에 싣는다 */
export function withClientIp(handler: (req: Request) => Promise<Response>, clientIp: ClientIp) {
  return async (req: Request) => {
    const ip = await clientIp(req);
    const headers = new Headers(req.headers);
    headers.delete(CLIENT_IP_HEADER);
    if (ip) headers.set(CLIENT_IP_HEADER, ip);
    return handler(new Request(req, { headers }));
  };
}

/**
 * 소켓 상대 주소와 X-Forwarded-For 로 클라이언트 IP 를 정한다 (Node 런타임 어댑터가 쓴다).
 * - 상대가 신뢰 프록시가 아니면 상대 주소. X-Forwarded-For 는 보지 않는다.
 * - 상대가 신뢰 프록시면 X-Forwarded-For 를 오른쪽부터 걸어 신뢰 프록시가 아닌 첫 주소. 프록시는 받은 상대 주소를
 *   오른쪽에 덧붙이므로 클라이언트가 왼쪽에 지어 넣은 값에는 닿지 않는다. 그런 주소가 없으면 상대 주소.
 * trustedProxies 는 IP 또는 CIDR (예: "172.16.0.0/12"). 잘못된 항목은 무시되므로 어댑터가 시작할 때
 * @better-auth/core/utils/ip 의 findInvalidTrustedProxies 로 검사한다 (S4.T1).
 */
export function resolveClientIp(peer: string | null | undefined, forwardedFor: string | null | undefined, trustedProxies: readonly string[]): string | null {
  if (!peer || !isValidIP(peer)) return null;
  const own = getIPFromHeader(peer);
  if (trustedProxies.length === 0) return own;
  const chain = forwardedFor ? `${forwardedFor}, ${peer}` : peer;
  return getIPFromHeader(chain, { trustedProxies: [...trustedProxies] }) ?? own;
}
