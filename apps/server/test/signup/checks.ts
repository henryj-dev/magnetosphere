// 가입 정책 시험(M2)의 서버 단언. Node 네 DB(policy.db.test.ts)와 D1(signup.workers.test.ts)이 같은 함수를 부른다.
// 가입 거부는 응답 코드가 아니라 생긴 행 수(user·account·verification)와 메일 수로 본다 (실행판 0절).
import { expect } from "vitest";
import { attempt, body, mail, type Rig } from "../../../../packages/auth/test/signup-policy/rig.ts";

const MODES = ["open", "invite_only", "domain_allowlist", "closed", "sso_only"] as const;
/** 공개 가입을 받는 정책 (Q1·Q19) */
const PUBLIC_OPEN = new Set(["open", "domain_allowlist"]);

/** 설치 뒤·메일 있음·허용 도메인 example.test·승인 끔·상한 없음 */
async function installed(rig: Rig) {
  await rig.op("addAdmin");
  await rig.op("setMail", true);
  await rig.op("setSetting", "allowed_domains", ["example.test"]);
  await rig.op("setSetting", "signup_requires_approval", false);
  await rig.op("setSetting", "daily_signup_cap", null);
}

/** TC-M2.T1.a 정책 다섯 × 공개 가입: 행 수로 판정 */
export async function tcM2T1a(rig: Rig) {
  await installed(rig);
  for (const mode of MODES) {
    await rig.op("setSetting", "signup_mode", mode);
    const pub = await attempt(rig, () => rig.signUp(body(mail(`t1a-${mode}`))));
    if (PUBLIC_OPEN.has(mode)) {
      expect({ mode, status: pub.status, user: pub.user, account: pub.account, mail: pub.mail }, pub.body).toEqual({ mode, status: 200, user: 1, account: 1, mail: 1 });
    } else {
      expect({ mode, status: pub.status, code: pub.code, user: pub.user, account: pub.account, verification: pub.verification, mail: pub.mail }).toEqual({
        mode,
        status: 403,
        code: "signup_closed",
        user: 0,
        account: 0,
        verification: 0,
        mail: 0,
      });
    }
    // 초대 문맥(runAsInvite, 가짜 초대) 안의 서버 호출. invite_only·open·domain_allowlist → +1, closed·sso_only → 0 (Q3)
    const inv = await attempt(rig, () => rig.apiSignUp(body(mail(`t1a-inv-${mode}`, "invited.example")), FAKE_INVITE));
    const want = INVITE_OPEN.has(mode) ? { status: 200, user: 1, account: 1 } : { status: 403, user: 0, account: 0 };
    expect({ mode, status: inv.status, user: inv.user, account: inv.account }, inv.body).toEqual({ mode, ...want });
  }
}

/** 시험용 가짜 초대. 이메일 없는 링크라 수락이 인증을 대신하지 않는다 */
export const FAKE_INVITE = { inviteId: "inv-test", role: "member", email: null, verified: false } as const;
/** 초대를 받는 정책 (Q3) */
const INVITE_OPEN = new Set(["invite_only", "open", "domain_allowlist"]);
