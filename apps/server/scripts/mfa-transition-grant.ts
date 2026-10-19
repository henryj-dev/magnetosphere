// 기존 관리자 MFA 전환용 grant 발급 (운영자 전용 CLI, A1 설계 4절 "기존 관리자 전환").
//
//   node apps/server/scripts/mfa-transition-grant.ts --email admin@example.com
//
// 서버와 같은 환경 변수를 읽는다: DATABASE_URL, BETTER_AUTH_SECRET, MFA_* 정책 값 (apps/server/.env.example, deploy 문서).
// DB 와 서버 비밀값에 접근할 수 있는 운영자만 쓴다. HTTP 경로는 없다.
//   - 대상: 활성 관리자이고 active factor 가 없는 회원 (마이그레이션 전부터 있던 관리자). factor 가 있으면 거부한다 — 분실은 다른 관리자의 MFA 초기화로 한다.
//   - 대상의 열린 grant 를 모두 취소하고 transition grant 하나를 만든다. 감사 기록 mfa.grant_issue {purpose: "transition", via: "cli"}.
//   - grant 토큰은 표준 출력에 한 줄로 한 번만 낸다. 안내·오류는 표준 오류로 내고 토큰·해시·비밀값은 넣지 않는다.
// Workers + D1 은 이 CLI 가 붙을 수 없다 (wrangler 원격 D1). Hyperdrive(MySQL·Postgres)는 그 DB 주소로 이 CLI 를 쓴다.
import { and, eq, sql } from "drizzle-orm";
import { grantInsert, grantRevokeOpen, loadMfaPolicy, MFA_POLICY_ENV, mfaHmacKey, runUnit, UnitAborted } from "@magnetosphere/auth/mfa";
import { normalizeEmail } from "@magnetosphere/db/src/users.ts";
import { connectNode } from "@magnetosphere/runtime/node";
import { auditStatement } from "../src/audit/index.ts";

const fail = (line: string, code = 1): never => {
  process.stderr.write(`[mfa-transition] ${line}\n`);
  process.exit(code);
};

const args = process.argv.slice(2);
const at = args.indexOf("--email");
const email = at >= 0 ? args[at + 1] : undefined;
if (!email || args.length !== 2) fail("사용법: node apps/server/scripts/mfa-transition-grant.ts --email <관리자 이메일>", 2);

const url = process.env.DATABASE_URL;
const secret = process.env.BETTER_AUTH_SECRET;
if (!url) fail("DATABASE_URL 이 없다");
if (!secret || secret.length < 32) fail("BETTER_AUTH_SECRET 이 없거나 32자보다 짧다");
const policy = await loadMfaPolicy(Object.fromEntries(Object.values(MFA_POLICY_ENV).map((name) => [name, process.env[name]])));
if (policy.state !== "ready") fail(`관리자 MFA 정책을 쓸 수 없다 (${policy.field}: ${policy.reason})`);

const h = await connectNode(url!);
try {
  const u = h.schema.user;
  const f = h.schema.mfaFactor;
  const [target] = await h.db.select({ id: u.id, role: u.role, status: u.status, authVersion: u.authVersion }).from(u).where(eq(u.email, normalizeEmail(email!))).limit(1);
  if (!target || target.role !== "admin" || target.status !== "active") fail("활성 관리자가 아니다");
  const now = new Date();
  const ready = policy as Extract<typeof policy, { state: "ready" }>;
  const g = await grantInsert(h, await mfaHmacKey(secret!), ready.policy, { userId: target.id, purpose: "transition", issuedBy: null, authVersion: Number(target.authVersion), now });
  try {
    await runUnit(h, [
      // 그사이 상태가 바뀌었거나 factor 가 생겼으면 내지 않는다 (한 행이어야 한다)
      {
        build: (db) => db.update(u).set({ updatedAt: now }).where(and(eq(u.id, target.id), eq(u.authVersion, target.authVersion), eq(u.role, "admin"), eq(u.status, "active"), sql`not exists (select 1 from ${f} where ${f.activeSlot} = ${target.id})`)),
        one: (x) => x.user.id,
      },
      { build: (db) => grantRevokeOpen(h, db, { userId: target.id, now }) },
      { build: g.build },
      { build: (db) => auditStatement(h, { actorId: null, action: "mfa.grant_issue", target: target.id, detail: { purpose: "transition", via: "cli" }, ip: null, now }, db) },
    ], { lockUserId: target.id });
  } catch (e) {
    if (e instanceof UnitAborted) fail("이미 MFA 를 등록했거나 상태가 바뀌었다. 등록한 관리자의 분실은 다른 관리자의 MFA 초기화로 한다");
    throw e;
  }
  process.stderr.write(`[mfa-transition] transition grant 를 발급했다 (만료 ${g.expiresAt.toISOString()}). 토큰은 표준 출력에 한 번만 나간다.\n`);
  process.stdout.write(`${g.token}\n`);
} finally {
  await h.close();
}
