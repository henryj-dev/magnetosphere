// Keycloak(:8181) 에 realm "v26", OIDC 비밀 클라이언트 "v26-oidc"(groups 클레임 매퍼),
// 그룹 "omni-admins" 와 테스트 사용자 alice(그룹 소속)를 만든다. 이미 있으면 건너뛴다(409).
const KC = "http://127.0.0.1:8181";
const tok = await (await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
  method: "POST",
  body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "admin", password: "admin" }),
})).json();
const H = { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json" };
async function r(method, path, body) {
  const res = await fetch(`${KC}/admin${path}`, { method, headers: H, body: body && JSON.stringify(body) });
  if (res.status >= 400 && res.status !== 409) throw new Error(`${method} ${path} ${res.status} ${await res.text()}`);
  console.log(`[kc] ${method} ${path} ${res.status}`);
  return res;
}
await r("POST", "/realms", { realm: "v26", enabled: true, sslRequired: "none" });
await r("POST", "/realms/v26/groups", { name: "omni-admins" });
await r("POST", "/realms/v26/users", {
  username: "alice", email: "alice@example.com", emailVerified: true, firstName: "Alice", lastName: "Kim", enabled: true,
  credentials: [{ type: "password", value: "alicepw", temporary: false }], groups: ["/omni-admins"],
});
await r("POST", "/realms/v26/clients", {
  clientId: "v26-oidc", protocol: "openid-connect", publicClient: false, secret: "v26-oidc-secret",
  redirectUris: ["http://localhost:3998/*"], standardFlowEnabled: true,
  protocolMappers: [{
    name: "groups", protocol: "openid-connect", protocolMapper: "oidc-group-membership-mapper",
    config: { "claim.name": "groups", "full.path": "false", "id.token.claim": "true", "access.token.claim": "true", "userinfo.token.claim": "true" },
  }],
});
console.log("[kc] 설정 완료");
