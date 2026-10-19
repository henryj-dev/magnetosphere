// E2E 관리자 MFA 도우미 (A1). 설치 흐름(run.mjs installFlow)이 bootstrap grant 로 등록한 seed 를 이메일별로 기억하고,
// 시나리오의 관리자 로그인(keys/env.mjs·members/env.mjs signIn)이 그 seed 로 challenge 해 MFA 를 마친 세션을 돌려준다.
// seed·코드·grant·proof 는 로그·실패 문구에 넣지 않는다 (고정 문구와 상태만).
import { base32Decode, timeStep, totpAt } from "../../packages/auth/src/mfa/totp.ts";

const seeds = new Map();
/** 운영 공통안 값과 같은 시험 정책: 30초·6자리·SHA-1 */
const PERIOD_S = 30;

export const totp = (seed, offsetSteps = 0) => totpAt(base32Decode(seed), timeStep(Date.now(), PERIOD_S) + offsetSteps, 6, "SHA-1");
export const rememberSeed = (email, seed) => void seeds.set(email.toLowerCase(), seed);
export const seedOf = (email) => seeds.get(email.toLowerCase()) ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** call(method, path, cookie, body, headers) → { status, json } */
export async function enroll(call, cookie, grant) {
  const start = await call("POST", "/api/auth/admin-mfa/enroll/start", cookie, { grant });
  if (start.status !== 200) throw new Error(`E_MFA_ENROLL_START (${start.status})`);
  const seed = start.json.secret;
  const confirm = await call("POST", "/api/auth/admin-mfa/enroll/confirm", cookie, { factorId: start.json.factorId, code: await totp(seed), grant });
  if (confirm.status !== 200) throw new Error(`E_MFA_ENROLL_CONFIRM (${confirm.status})`);
  return seed;
}

/** 부분 세션을 MFA 충족으로 올린다. 같은 30초 안의 두 번째면 다음 step, 그것도 썼으면 다음 step 경계까지 기다린다 */
export async function challenge(call, cookie, seed) {
  // 실패하면 응답의 고정 코드만 E_ 코드로 남긴다 (값·코드 원문은 남기지 않는다)
  const seen = new Set();
  const fail = () => new Error(["E_MFA_CHALLENGE", ...[...seen].map((c) => `E_MFA_${c}`)].join(" "));
  for (let round = 0; round < 3; round++) {
    for (const offset of [0, 1]) {
      const r = await call("POST", "/api/auth/admin-mfa/challenge", cookie, { code: await totp(seed, offset) });
      if (r.status === 200) return;
      const code = typeof r.json?.code === "string" && /^[A-Z_]{1,40}$/.test(r.json.code) ? r.json.code : `HTTP_${r.status}`;
      seen.add(code);
      if (code !== "INVALID_MFA_CODE") throw fail();
    }
    await sleep(PERIOD_S * 1000 - (Date.now() % (PERIOD_S * 1000)) + 500);
  }
  throw fail();
}

/** 기억한 seed 가 있는 관리자면 로그인 직후 challenge 한다 */
export async function afterSignIn(call, email, cookie) {
  const seed = seedOf(email);
  if (seed && cookie) await challenge(call, cookie, seed);
}

/** 로그인 MFA 최근성으로 작업 proof → X-MFA-Proof 머리글 */
export async function proofHeader(call, cookie, purpose, target) {
  const r = await call("POST", "/api/auth/admin-mfa/step-up", cookie, { purpose, target });
  if (r.status !== 200) throw new Error(`E_MFA_STEP_UP (${r.status})`);
  return { "x-mfa-proof": r.json.proof };
}
