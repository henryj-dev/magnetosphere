// 실제 Keycloak 로그인 화면을 fetch 로 통과해 Better Auth 의 OIDC 콜백까지 몬다.
import { KC, ISSUER, BASE } from "./auth.mjs";

const unescape = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

export async function registerProvider(c, providerId) {
  return c.post("/sso/register", {
    providerId, issuer: ISSUER, domain: "example.com",
    oidcConfig: {
      clientId: "v26-oidc", clientSecret: "v26-oidc-secret", scopes: ["openid", "email", "profile"],
      mapping: { email: "email", name: "name", extraFields: { groups: "groups" } },
    },
  });
}

// 반환: Better Auth 콜백 응답(c.req 결과)
export async function oidcLogin(c, providerId, user = "alice", pw = "alicepw") {
  const start = await c.post("/sign-in/sso", { providerId, callbackURL: BASE + "/done" });
  if (start.status !== 200 || !start.json?.url) throw new Error("sign-in/sso 실패 " + start.status + " " + start.text.slice(0, 300));
  const kcJar = new Map();
  const kcCookie = () => [...kcJar].map(([k, v]) => `${k}=${v}`).join("; ");
  const keep = (res) => { for (const s of res.headers.getSetCookie()) { const [kv] = s.split(";"); const i = kv.indexOf("="); kcJar.set(kv.slice(0, i), kv.slice(i + 1)); } };
  let res = await fetch(start.json.url, { redirect: "manual" });
  keep(res);
  const html = await res.text();
  const action = unescape(html.match(/<form[^>]*action="([^"]+)"/)[1]);
  res = await fetch(action, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: kcCookie() },
    body: new URLSearchParams({ username: user, password: pw, credentialId: "" }),
  });
  const loc = res.headers.get("location");
  if (!loc || !loc.startsWith(BASE)) throw new Error("Keycloak 로그인 후 리다이렉트 이상 " + res.status + " " + loc);
  return c.get(loc);
}
export { KC };
