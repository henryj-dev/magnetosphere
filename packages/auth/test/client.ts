// 쿠키 상자 하나를 가진 간단한 HTTP 클라이언트. 요청은 handler(Request → Response)에 바로 넣는다.
export const BASE = "http://localhost:3000";

export type Handler = (req: Request) => Promise<Response>;

export interface Res {
  status: number;
  json: any;
  location: string | null;
  setCookie: string[];
}

export function client(handler: Handler, extraHeaders: () => Record<string, string> = () => ({})) {
  const jar = new Map<string, string>();
  const take = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      const k = kv.slice(0, i);
      const v = kv.slice(i + 1);
      if (/max-age=0/i.test(c) || v === "") jar.delete(k);
      else jar.set(k, v);
    }
  };
  async function req(method: string, pathOrUrl: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${BASE}/api/auth${pathOrUrl}`;
    const res = await handler(
      new Request(url, {
        method,
        headers: {
          origin: BASE,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
          ...extraHeaders(),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: "manual",
      }),
    );
    take(res);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, location: res.headers.get("location"), setCookie: res.headers.getSetCookie() };
  }
  return {
    jar,
    req,
    post: (p: string, b: unknown = {}, h?: Record<string, string>) => req("POST", p, b, h),
    get: (p: string, h?: Record<string, string>) => req("GET", p, undefined, h),
  };
}

let seq = 0;
/** 테스트마다 겹치지 않는 이메일 */
export const email = (tag = "u") => `${tag}-${Date.now().toString(36)}-${seq++}@example.test`;
export const PASSWORD = "correct-horse-battery-staple";
