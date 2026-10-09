# Phase 0 확인 결과 — Better Auth SSO (설계 문서 8장 6~9번)

- 확인일: 2026-10-09
- 대상 버전: `better-auth@1.7.7`, `@better-auth/sso@1.7.7` (npm 최신), 내부 의존 `samlify@2.13.1`, `xml-crypto@6.x`, `node-rsa@1.1.1`
- 소스: GitHub `better-auth/better-auth` 태그 `v1.7.7` (`/tmp/ba-phase0/vendor/repo/packages/sso/src/...`). 아래 경로는 이 디렉터리 기준이다.
- 실측 환경: Keycloak `quay.io/keycloak/keycloak:26.4.0` (start-dev, :8180), Hono + Better Auth + better-sqlite3 (:3100), wrangler 4.115.0 / 로컬 workerd (:8799)
- 재현 스크립트: `/tmp/ba-phase0/scripts/` (`kc_setup.py`, `register.py`, `drive.py`, `attack.py`, `forge.mjs`), 앱 `/tmp/ba-phase0/app/server.mjs`, Workers 프로브 `/tmp/ba-phase0/worker/`

---

## 6. SAML 라이브러리와 Workers 호환 — 실측 (로컬 workerd)

**결론:** SAML 처리는 `samlify`가 맡고, `nodejs_compat`를 켠 Workers 런타임(로컬 workerd)에서 번들링과 실제 Keycloak 응답의 서명 검증까지 동작했다.

**근거**
- `@better-auth/sso/package.json` dependencies: `samlify ^2.13.1`, `@xmldom/xmldom`, `fast-xml-parser`, `jose`, `tldts`, `zod`. 자체 SAML 구현은 없고 `samlify.ts:1`에서 samlify를 감싼다. XML 스키마 검증은 `fast-xml-parser`의 `XMLValidator`로 바꿔 끼운다 (`index.ts:116-126`, Java 기반 validator 불필요).
- 플러그인 자체의 Node 전용 import: `utils.ts:1` `import { X509Certificate } from "node:crypto"` (인증서 정보 표시용 `parseCertificate`).
- samlify 이하 의존 트리의 Node 내장 모듈 사용: `crypto`(samlify, xml-crypto, node-rsa, xml-encryption), `zlib`(samlify `utility.js:48`, Redirect 바인딩 inflate), `fs`(samlify `libsaml.js:112`, `metadata.js:41` — 파일 경로를 줄 때만 호출), `constants`(node-rsa). 네이티브 애드온은 없다.
- `wrangler deploy --dry-run` (compat_date 2026-07-29, `nodejs_compat`): 성공. `Total Upload: 4609.76 KiB / gzip: 841.09 KiB`.
- `wrangler dev`(workerd)에서 프로브 결과: `{"zlib":"hello","x509":"CN=probe","samlify.sp":"true","betterAuth":"function"}`
- 같은 workerd에서 실제 Keycloak이 서명한 SAMLResponse를 `samlify.parseLoginResponse`로 검증:
  - 원본: `{"ok":true,"nameID":"dave@example.com",...,"audience":"http://localhost:3100/saml-sp"}`
  - 서명 제거본: `{"ok":false,"error":"FAILED_TO_VERIFY_SIGNATURE"}`
  - 서명 유지 + 이메일 변조본: `{"ok":false,"error":"FAILED_TO_VERIFY_SIGNATURE"}`

**확인하지 못한 것**
- 실제 Cloudflare 배포(프로덕션 런타임)는 하지 않았다. 로컬 workerd 기준이다.
- 암호화된 Assertion 복호화(`node-rsa`, `xml-encryption` 경로)와 AuthnRequest 서명은 Workers에서 돌려보지 않았다.
- D1 위에서 Better Auth 전체 SSO 흐름은 돌려보지 않았다. 아래 9번의 `resolveUser`는 D1에서 쓸 수 없다 (코드 확인).

**설계에 주는 영향**
- 2차 Workers 지원은 SAML 때문에 막히지 않는다. 다만 `nodejs_compat` 필수, 번들이 gzip 기준 약 0.85MB 늘어난다.
- 암호화 Assertion을 지원할지 정하면 그 경로만 Workers에서 따로 실측한다.

---

## 7. `ssoProvider` 비밀 값 저장 방식 — 실측 + 코드 확인

**결론:** OIDC `clientSecret`, SAML `privateKey`·`spMetadata.privateKey`·`encPrivateKey`·`idpMetadata.privateKey` 모두 `oidcConfig`/`samlConfig` TEXT 컬럼에 **평문 JSON**으로 들어간다. 암호화 옵션은 없다.

**근거**
- `routes/sso.ts:565-615` `buildOIDCConfig()`가 `JSON.stringify({ ..., clientSecret: body.oidcConfig.clientSecret, ... })`.
- `routes/sso.ts:701-720` `samlConfig: JSON.stringify({ ..., idpMetadata, spMetadata, privateKey: body.samlConfig.privateKey, ... })`.
- `routes/sso.ts:657-661` 저장은 `ctx.context.adapter.create({ model: "ssoProvider", ... })` — `internalAdapter`가 아니라서 `databaseHooks`가 걸리지 않는다. `databaseHooks`는 user/session/account/verification 같은 코어 모델용이다 (`core/src/types/init-options.ts:1426~`, `better-auth/src/db/with-hooks.ts`).
- 실측 DB 행 (`/tmp/ba-phase0/ssoProvider-row.txt`):
  `oidcConfig: '{"issuer":"http://localhost:8180/realms/test","clientId":"ba-oidc","clientSecret":"oidc-secret-123",...}'`
- 응답 노출: `POST /sso/register` 응답은 `clientSecret`을 평문으로 그대로 돌려준다 (실측). 조회용 `GET /sso/get-provider`·`/sso/providers`는 `sanitizeProvider`로 걸러 `clientIdLastFour`만 준다 (`routes/providers.ts:467-540`).
- 참고: 코어의 `account.encryptOAuthTokens`(`better-auth/src/oauth2/utils.ts:14,30`)는 account 테이블의 토큰에만 적용되고 `ssoProvider`와는 무관하다.
- 우회 수단으로 플러그인이 주는 것: `resolvePrivateKey` 콜백 (`types.ts:639`, private_key_jwt 키를 DB 밖에서 가져옴), `defaultSSO` (코드에 박는 정적 설정, 문서상 "for testing").

**설계에 주는 영향**
- 7장의 "평문이면 감싸는 훅" 방침이 필요하다. 훅 자리는 `databaseHooks`가 아니라 **DB 어댑터 래퍼**다. `model === "ssoProvider"`일 때 create/update에서 `oidcConfig`·`samlConfig`의 비밀 필드를 `APP_ENCRYPTION_KEY`로 암호화하고, findOne/findMany에서 복호화한다. 플러그인은 `adapter.create/findOne/findMany/update`만 쓰므로 이 방식으로 투명하게 감쌀 수 있다.
- `/sso/register` 응답에서 `clientSecret`을 지우는 after 훅(또는 우리 API가 대신 호출하고 응답을 가공)이 필요하다.
- private_key_jwt를 쓰는 IdP는 `resolvePrivateKey`로 키를 우리 암호화 저장소에서 꺼내게 한다.

---

## 8. SAML 응답 검증 기본 동작 — 실측 + 코드 확인

**결론:** 기본값에서 서명(응답 또는 Assertion 중 최소 하나), Issuer, Audience, Recipient/Destination, NotBefore/NotOnOrAfter, InResponseTo, Assertion ID 재사용, IdP 시작 SSO 차단을 모두 검사한다. 다만 **Assertion 자체 서명 강제(`wantAssertionsSigned`)는 기본 꺼짐**이고, 타임스탬프가 아예 없는 Assertion은 기본으로 통과한다.

**근거 (코드, `routes/saml-pipeline.ts` `processSAMLResponse`)**

| 검사 | 기본 | 위치 |
|---|---|---|
| 크기 제한 256KB | 켜짐 | `:298-305`, `constants.ts:67` |
| Assertion 1개만 허용 | 켜짐 | `:391` `validateSingleAssertion` |
| 서명 검증 | 켜짐. samlify `postFlow`가 `checkSignature: true`(`samlify/build/src/entity-sp.js:153`)로 호출되고, 서명이 하나도 없거나 검증 실패면 `FAILED_TO_VERIFY_SIGNATURE` (`samlify/build/src/flow.js:219-246`). 서명 래핑 공격 XPath 방어 포함 (`libsaml.js:464~`) | `:396` |
| Issuer = IdP entityID | 켜짐 (`ERR_UNMATCH_ISSUER`) | samlify `flow.js` postFlow |
| Assertion 자체 서명 강제 | **꺼짐**. `wantAssertionsSigned === true`일 때만 `verifySAMLAssertionSignature` 추가 실행 | `:450-455`, `routes/helpers.ts:168-175` |
| 서명 알고리즘(SHA-1 등) | 경고 후 통과가 기본, `saml.algorithms.onDeprecated: "reject"`로 강화 | `:421` |
| NotBefore/NotOnOrAfter | 켜짐, 허용 오차 5분. **타임스탬프가 없으면 경고만 하고 통과**(`requireTimestamps` 기본 false) | `:424`, `saml/timestamp.ts`, `constants.ts:57` |
| Audience | 켜짐. AudienceRestriction이 없거나 SP entityID와 다르면 거부 | `:431-484` `validateSAMLResponseBinding`, `saml/response-binding.ts:280-306`; `:541` `validateAudience` |
| Bearer SubjectConfirmation Recipient | 켜짐. 없거나 ACS와 다르면 거부 | `saml/response-binding.ts:320-352` |
| Response Destination | 값이 있으면 ACS와 비교, **없으면 통과** | `saml/response-binding.ts:354-368` |
| InResponseTo | 켜짐(`enableInResponseToValidation` 기본 true). 저장된 AuthnRequest를 원자적으로 소비, TTL 5분, 제공자 일치 확인 | `:486`, `saml/response-validation.ts:46-150` |
| IdP 시작 SSO(InResponseTo 없음) | 거부(`allowIdpInitiated` 기본 false) | `saml/response-validation.ts:134-146` |
| Assertion ID 재사용 | 켜짐. verification 테이블에 `reserveVerificationValue`로 원자적 예약, NotOnOrAfter+오차까지 보관 | `:552-597` |

**실측 (Keycloak 26.4.0 서명 응답, `attack.py` 출력)**
```
[control-valid] HTTP 302 loc=http://localhost:3100/ session=dave@example.com
[strip-signatures+email-change] HTTP 302 loc=.../api/auth/error?error=saml_error&error_description=Invalid+SAML+response  session=None
[tamper-email-keep-idp-signature] HTTP 302 loc=...error=saml_error&error_description=Invalid+SAML+response  session=None
[resign-with-attacker-key] HTTP 302 loc=...error=saml_error&error_description=Invalid+SAML+response  session=None
[replay-same-response-new-browser] HTTP 302 loc=http://localhost:3100/?error=invalid_saml_response&error_description=Unknown+or+expired+request+ID  session=None
[cross-SP: kc-saml response posted to kc-saml2 ACS] HTTP 302 loc=...error=invalid_saml_response&error_description=SAML+assertion+audience+does+not+match+this+Service+Provider  session=None
     log: SAML response binding validation failed { providerId: 'kc-saml2', code: 'SAML_AUDIENCE_MISMATCH' }
```
- Assertion ID 재사용만 따로 보려고 `enableInResponseToValidation: false`로 재기동 후 같은 응답을 다시 보냄:
  `[replay-without-RelayState (IRT off)] ... error=replay_detected&error_description=SAML+assertion+has+already+been+used`
- IdP 시작 SSO(Keycloak `saml_idp_initiated_sso_url_name`): `error=unsolicited_response&error_description=IdP-initiated+SSO+not+allowed`
- 만료된 Assertion은 IdP 키 없이 만들 수 없어 실측하지 못했다 (코드 확인만).

**설계에 주는 영향**
- 4.3의 "서명된 Assertion 요구 (기본 켜짐)"은 Better Auth 기본값과 다르다. 등록 시 `wantAssertionsSigned: true`를 우리 쪽에서 항상 넣고, 8장 6번 추천대로 끌 수 없게 한다. 이 값을 켜면 SP 메타데이터도 `WantAssertionsSigned="true"`로 나간다.
- 플러그인 옵션은 `saml: { requireTimestamps: true, algorithms: { onDeprecated: "reject" } }`로 둔다. InResponseTo·재사용 방지·IdP 시작 차단은 기본값 그대로 두면 된다.
- Keycloak 기본 IdP 메타데이터는 `WantAuthnRequestsSigned="true"`라서 SP가 AuthnRequest에 서명하지 않으면 samlify가 `ERR_METADATA_CONFLICT_REQUEST_SIGNED_FLAG`로 로그인 시작부터 실패한다 (실측). 설정 화면에 SP 서명 키 입력(또는 자동 생성)을 두거나, 연결 테스트에서 이 오류를 알아보기 쉽게 보여줘야 한다.

---

## 9. 매 로그인 역할 재계산 훅 — 실측 + 코드 확인

**결론:** 있다. `provisionUser` + `provisionUserOnEveryLogin: true`로 매 로그인마다 호출되고, 그룹 클레임도 받을 수 있다. 더 강한 수단으로 `resolveUser`(트랜잭션 안에서 원본 클레임 전체를 받고 거부도 가능)가 있지만 D1에서는 못 쓴다.

**근거**
- 타입: `types.ts:430-459`
  ```ts
  provisionUser?: (data: { user: User & Record<string, any>; userInfo: Record<string, any>;
                           token?: OAuth2Tokens; provider: SSOProvider<SSOOptions> }) => Awaitable<void>;
  provisionUserOnEveryLogin?: boolean; // 기본 false
  ```
- 호출 조건: OIDC `routes/sso.ts:1795-1806`, SAML `routes/saml-pipeline.ts:812-822` — `linked.isRegister || options.provisionUserOnEveryLogin`. 세션 생성 뒤, 세션 쿠키 설정 전에 호출된다.
- `userInfo` 내용:
  - OIDC (`routes/sso.ts:1596-1632`): `id`(sub), `email`, `emailVerified`, `name`, `image` + **`mapping.extraFields`로 지정한 클레임만**. 그룹을 받으려면 등록 시 `mapping.extraFields: { groups: "groups" }`가 필요하다. `token`에 `idToken`·`accessToken`·`raw`가 있어 원본 클레임을 직접 디코드할 수도 있다.
  - SAML (`routes/saml-pipeline.ts:621-647`): `id`(NameID), `email`, `name`, `emailVerified` + `mapping.extraFields`로 지정한 속성. `token`은 없다.
- 실측 (`/tmp/ba-phase0/provision.log`):
  - OIDC 1·2회차 모두 호출: `"userInfo":{"groups":["omni-admins"],"id":"112e...","email":"alice@example.com","emailVerified":false,"name":"Alice Kim"}`, `tokenKeys:["tokenType","accessToken","refreshToken","accessTokenExpiresAt","refreshTokenExpiresAt","scopes","idToken","raw"]`
  - Keycloak에서 그룹을 뺀 뒤 3회차: `"userInfo":{"id":"112e...","email":"alice@example.com","emailVerified":false,"name":"Alice Kim"}` — `groups` 키가 사라짐 (값이 undefined).
  - SAML 1·2회차 모두 호출: `"userInfo":{"groups":"omni-admins","id":"carol@example.com",...}` — **값이 하나면 문자열, 여럿이면 배열**이다.
- `resolveUser` (`types.ts:291-352, 393-410`): OIDC는 `providerClaims`(UserInfo 원본)·`verifiedIdTokenClaims`, SAML은 `providerAttributes`(다중 값은 배열)를 받고 `continue`/`link`/`reject`를 돌려준다. 실측 (`RESOLVE=1`, `/tmp/ba-phase0/resolve.log`): OIDC `claimKeys` 전체와 `groups:["omni-admins"]`, SAML `groups:"omni-admins"` 수신. 도메인 밖 이메일을 `reject`하자 `error=EMAIL_DOMAIN_NOT_ALLOWED`로 로그인 거부됨.
  - 전제 조건 (`user-resolution.ts:87-150`): 어댑터에 네이티브 트랜잭션 필요, secondaryStorage를 쓰면 DB 세션 병행 필요. better-sqlite3(Kysely)에서는 동작했다. **D1은 대화형 트랜잭션이 없어 쓸 수 없다** (`kysely-adapter/src/d1-sqlite-dialect.ts:125-137`, `dialect.ts:193`).
- `organizationProvisioning.getRole`(`types.ts:463-489`)도 있지만 organization 플러그인 전용이라 우리 `admin/member`와는 맞지 않는다.

**설계에 주는 영향**
- 4.5 "IdP 역할 매핑은 로그인할 때마다 다시 계산"은 `provisionUserOnEveryLogin: true` + `provisionUser`에서 `sso_provider_settings`의 매핑 규칙을 읽어 `user.role`을 갱신하는 방식으로 구현한다. 최초 관리자 예외도 여기서 처리한다.
- IdP 등록 시 그룹 클레임 이름을 `mapping.extraFields`에 자동으로 넣어야 한다 (4.3 "그룹 클레임·속성 이름" 입력값을 그대로 사용).
- 그룹 값은 `undefined | string | string[]`로 정규화해서 비교한다. 그룹이 빠지면 키 자체가 없어지므로 "없음 = 관리자 아님"으로 처리한다.
- `provisionUser`는 세션이 만들어진 **뒤**에 돈다. 역할 갱신 중 예외가 나면 로그인 응답은 실패하지만 세션 행은 이미 생겼을 수 있다. 역할 강등은 반드시 성공시키는 방향(예외를 삼키지 않고, 실패 시 세션 무효화)으로 짠다.
- 1차(Node + SQLite/Postgres)는 `resolveUser`로 도메인 검사·역할 계산을 트랜잭션 안에서 처리할 수 있다. 2차 Workers+D1을 고려하면 `provisionUser` 중심으로 짜고 도메인 검사는 별도로 둔다 (아래 참고).

---

## 추가: 이메일·도메인 신뢰 모델 — 실측 + 코드 확인

**결론:** Better Auth는 IdP가 등록 도메인 밖의 이메일을 주장해도 **로그인을 막지 않는다** (새 회원이 그대로 생성됨). 기존 계정 자동 연결은 기본값에서는 막히지만, `trustEmailVerified: true`를 켜면 아무 IdP나 남의 계정을 가로챌 수 있다. 또 **로그인한 일반 사용자 누구나 IdP를 등록할 수 있다.**

**근거**
- 도메인 검사는 `isTrustedProvider` 계산에만 쓰인다: OIDC `routes/sso.ts:1666-1669`, SAML `routes/saml-pipeline.ts:682-685` — `domainVerified === true && validateEmailDomain(email, provider.domain)`. 로그인 거부 조건이 아니다.
- `domainVerified` 컬럼은 `domainVerification.enabled`일 때만 생긴다 (실측: 기본 스키마에 컬럼 없음). 즉 기본값에서는 `isTrustedProvider`가 항상 false다.
- 연결 규칙 `better-auth/src/oauth2/link-account.ts:281-305`: 기존 사용자가 있으면 `(!isTrustedProvider && !userInfo.emailVerified) || (requireLocalEmailVerified && !dbUser.user.emailVerified) || accountLinking.enabled === false` 중 하나라도 참이면 `account not linked`. 기존 사용자가 없으면 그냥 생성 (`:510-560`).
- `trustEmailVerified` (`types.ts:590-607`, deprecated): 켜면 IdP의 `email_verified`(OIDC) 또는 매핑된 속성(SAML)을 그대로 믿는다 (`routes/sso.ts:1608,1628,1656`, `routes/saml-pipeline.ts:643-646`). 끄면(기본) 항상 `emailVerified: false`.
- `domainVerification.enabled`: 새 제공자는 DNS TXT(`_better-auth-token-...`)로 도메인 소유를 증명하기 전까지 로그인 자체가 막힌다 (`routes/saml-pipeline.ts:334-341`, `routes/sso.ts:1115,1363`). 증명된 제공자는 자기 도메인 이메일에 한해 `isTrustedProvider = true`가 되어 기존 계정에 자동 연결된다.
- IdP 등록 권한: `routes/sso.ts:213-223` `registerSSOProvider`는 `sessionMiddleware`만 요구하고, 사용자당 기본 10개 (`:414-416` `providersLimit`).

**실측**
- 기본값, Keycloak 사용자 `victim@victim.test`가 `domain: example.com` 제공자로 로그인: `session user: victim@victim.test` — 새 회원 생성됨.
- 기본값, Keycloak 사용자가 기존 로컬 계정 `admin@example.com`을 주장: `error=account+not+linked` — 연결 거부.
- `trustEmailVerified: true` + 로컬 `admin@example.com`의 emailVerified=1 + **`domain: other.test`로 등록한** 제공자로 `admin@example.com` 주장: `session: admin@example.com`, account 테이블에 `{ providerId: 'kc-oidc-other' }` 추가 — **계정 탈취 성공**.
- 일반 사용자 `random@nowhere.test`로 가입 후 `POST /sso/register` (`domain: example.com`): `200` — 등록 성공.

**설계에 주는 영향**
- 4.4 "그 IdP에 연결된 도메인의 이메일일 때만 믿는다"는 Better Auth가 대신 해주지 않는다. 우리가 직접 막는다:
  - 1차(Node): `resolveUser`에서 `providerUser.email`의 도메인이 `provider.domain` 목록에 없으면 `reject` (실측으로 동작 확인).
  - 2차(D1): `resolveUser`를 못 쓰므로 `/sso/callback/*`·`/sso/saml2/sp/acs/*`에 대한 `hooks.before`/`databaseHooks.user.create.before` 등으로 대체 수단을 따로 검증해야 한다 (미확인).
- `trustEmailVerified`는 켜지 않는다. 자동 연결이 필요하면 `domainVerification.enabled: true`를 쓰거나, 운영자가 등록한 IdP라는 사실을 근거로 `resolveUser`의 `link`로 직접 연결한다.
- `/sso/register`, `/sso/update-provider`, `/sso/delete-provider`, 도메인 검증 엔드포인트는 `disabledPaths`로 막거나 `hooks.before`에서 `role === "admin"`만 통과시킨다. 우리 관리 API가 내부에서 `auth.api.registerSSOProvider`를 호출하는 구조가 안전하다. `providersLimit`도 일반 사용자에게는 0으로 둔다.
- 같은 도메인을 여러 제공자에 등록하는 것도 막히지 않으므로(실측: `example.com`을 일반 사용자가 추가 등록) 도메인 중복을 우리 쪽에서 검사한다 (이메일 입력 후 도메인 라우팅이 엉뚱한 IdP로 가는 일을 막기 위해).
