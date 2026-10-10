// K5.T2 여섯 조합 키 시나리오 (TC-K5.T2.a~d, 계획서 v5.7 5.2·5.3, Q1·V18·V19). pnpm e2e --combo <조합> --scenario keys
//
// 설치·관리자(run.mjs) 뒤 회원(DB 직접) → 관리자 API 로 한도 $0.02·최대 키 2 → 넷:
//   a  발급 → 요청 200 → POST /api/me/keys/:id/disable → 다음 요청 403 permission_denied (다시 켜서 b 에 쓴다)
//   b  키 둘로 번갈아 요청해 회원 총 사용액이 한도에 닿으면(T0) 곧바로 두 키로 몰아 쓴다 (키마다 연달아, 거부될 때까지).
//      몰아 쓴 뒤 총 사용액 ≤ 0.02 × 2 + 0.004878 (계획서 5.3 "남은 한도 × 동시에 쓰는 키 수").
//      T0 부터 125,000ms 안에 분배가 두 키를 limit 으로 끈다 (탐침 403 permission_denied, v5.6 Q1)
//   c  두 키 삭제 → 새 발급 409 limit_exhausted. 한도 $0.06 → 발급 → 그 키 예산 == 0.06 − 총 사용액 (1e-6)
//      (몰아 쓴 뒤 총 사용액은 0.04 를 넘을 수 있다 — 상한 0.044878. 그래서 올린 한도는 그보다 큰 $0.06)
//   d  한도 도달 뒤 남은 키 재발급 → 409 limit_exhausted, 옛 원문 403. 한도를 올린 뒤 재발급 → 그 키 예산 == 한도 − 총 사용액
//      (옛 id 사용액 포함, 1e-6), 새 원문 200, 옛 원문 바로 403
//
// 요청 비용: mko/mock-gpt 1건 0.00221 (tests/contract/setup.mjs 가격). 총 사용액은 OmniRoute 분석(어댑터)으로 확인하고
// 시험이 센 성공 요청 수 × 0.00221 과 맞춘다.
// b 의 두 단언이 보는 것:
//   - 초과 폭: 몰아 쓰기는 키 예산(OmniRoute 차단)만으로 멈춘다. 분배가 키 예산을 "그 키 사용액 + 남은 한도"로 걸었으면
//     합은 많아야 한도 + 남은 한도 + 요청 2건(≤ 0.04442)이고, 남은 한도 대신 한도 전체를 걸었으면 그 위로 넘는다 (K5 리뷰 M1).
//   - 반응 시간: 키 예산 차단(429)은 분배 없이도 생긴다. 그래서 거부가 아니라 "분배가 키를 끈 것"(탐침 403)을 125초 안에 본다.
//     탐침(env.mjs infer real=false)은 비용이 없다. 꺼진 키는 403, 켜진 키는 400 이다 (예산 차단은 탐침으로 보이지 않는다).
// 분배를 기다릴 때 Node(Docker)는 앱의 1분 경계 타이머 그대로, Workers 는 apps/server/wrangler.toml [triggers] crons 에 있는
// 식만 그 식이 걸리는 1분 경계마다 /__scheduled 로 부른다 (wrangler dev --test-scheduled 는 Cron 을 스스로 돌리지 않는다).
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../../deploy/stack.mjs";
import { ADMIN, appHttp, check, d1File, dbOps, infer, limitRejected, log, OPENAI_COST, omniClient, permissionDenied, sleep, STACK_OMNI_URL } from "./env.mjs";

export const LIMIT = 0.02;
export const MAX_KEYS = 2;
/** 한도 반영 상한: 지출 기록 60초 + 분배 주기 1분 + 분배 소요 5초 (V15) */
export const REACT_MS = 125_000;
/** 초과 폭 상한: 한도 × 최대 키 2 + 요청 1건 (계획서 5.3) */
export const OVERSPEND_MAX = LIMIT * MAX_KEYS + 0.004878;
/** c 에서 올리는 한도, d 에서 다시 올리는 한도. 몰아 쓴 뒤 총 사용액(≤ OVERSPEND_MAX)보다 커야 한다 */
export const RAISED_C = 0.06;
export const RAISED_D = 0.08;
/** 몰아 쓰기 상한 (키마다). 키 예산이 맞으면 몇 건 안에 거부된다 */
const BURST_MAX = 40;

/** apps/server/wrangler.toml [triggers] crons. Workers 는 이 식으로만 깨어난다 */
export function wranglerCrons() {
  const toml = fs.readFileSync(path.join(ROOT, "apps/server/wrangler.toml"), "utf8");
  const m = /^\[triggers\][^[]*?^crons\s*=\s*\[([^\]]*)\]/ms.exec(toml);
  if (!m) throw new Error("wrangler.toml 에 [triggers] crons 가 없다");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** 분(minute) 필드만 보는 cron 판정. 나머지 필드는 * 여야 한다 (이 저장소의 식: "* * * * *", "*\/N * * * *") */
function cronDue(cron, minute) {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5 || f.slice(1).some((x) => x !== "*")) throw new Error(`시험 Cron 이 모르는 식: ${cron}`);
  if (f[0] === "*") return true;
  const step = /^\*\/(\d+)$/.exec(f[0]);
  if (step) return minute % Number(step[1]) === 0;
  throw new Error(`시험 Cron 이 모르는 식: ${cron}`);
}

/** 1분 경계마다 wrangler.toml crons 중 그 분에 걸리는 식을 부른다 (wrangler dev --test-scheduled). stop() 으로 멈춘다 */
function cronTicker(baseUrl) {
  const crons = wranglerCrons();
  log(`Workers Cron (wrangler.toml): ${crons.join(", ")}`);
  let stopped = false;
  let calls = 0;
  const loop = (async () => {
    while (!stopped) {
      const next = Math.ceil((Date.now() + 1) / 60_000) * 60_000;
      while (!stopped && Date.now() < next) await sleep(Math.min(500, next - Date.now()));
      if (stopped) break;
      const minute = new Date(next).getUTCMinutes();
      for (const cron of crons.filter((c) => cronDue(c, minute))) {
        const r = await fetch(`${baseUrl}/__scheduled?cron=${encodeURIComponent(cron).replace(/%20/g, "+")}`).catch((e) => ({ status: String(e) }));
        calls++;
        if (r.status !== 200) log(`Cron ${cron} 호출 ${r.status}`);
        await r.arrayBuffer?.();
      }
    }
  })();
  return {
    get calls() {
      return calls;
    },
    async stop() {
      stopped = true;
      await loop;
    },
  };
}

export async function runKeys(ctx) {
  const docker = !!ctx.stack;
  const http = appHttp(ctx.baseUrl);
  // 회원 도구 요청: Docker 는 Caddy(공개 주소), Workers 는 계약 환경 OmniRoute 에 바로
  const v1 = docker ? ctx.baseUrl : ctx.contract.url;
  const omni = docker ? await omniClient(STACK_OMNI_URL, ctx.stack.env.INITIAL_PASSWORD) : await omniClient(ctx.contract.url, ctx.contract.password);
  const db = docker ? dbOps({ stack: ctx.stack }) : dbOps({ url: ctx.dbUrl ?? `file:${d1File(ctx.persistTo)}` });
  const ticker = docker ? null : cronTicker(ctx.baseUrl);
  const timings = {};
  let memberId;
  try {
    const admin = await http.signIn(ADMIN.email, ADMIN.password);
    const email = `e2e-keys-${Date.now()}@example.com`;
    const password = "e2e keys member password";
    memberId = db.addMember(email, password);
    const member = await http.signIn(email, password);
    const setLimit = async (usd, extra = {}) => {
      const r = await http.api("PATCH", `/api/admin/users/${memberId}`, admin, { monthlyLimitUsd: usd, ...extra });
      // rebalanced: 저장 직후 즉시 분배가 OmniRoute 까지 성공했다 (실패면 1분 분배가 나중에 건다 — 뒤 단언의 전제가 깨진다, K5 리뷰 M2)
      check(r.status === 200 && r.json?.user?.monthlyLimitUsd === usd && r.json?.rebalanced === true, `관리자 한도 $${usd}, 즉시 분배 성공 (${r.status} ${JSON.stringify(r.json)})`);
      return r.json;
    };
    await setLimit(LIMIT, { maxKeys: MAX_KEYS });
    const issue = () => http.api("POST", "/api/me/keys", member, {});
    const keyApi = (id, action) => http.api(action === "delete" ? "DELETE" : "POST", `/api/me/keys/${id}${action === "delete" ? "" : `/${action}`}`, member);
    let ok = 0; // 성공(200)한 실제 요청 수
    const spend = async (secret) => {
      const r = await infer(v1, secret);
      if (r.status === 200) ok++;
      return r;
    };
    const orks = () => db.keys(memberId).filter((k) => !k.ork.startsWith("pending-")).map((k) => k.ork);
    /** OmniRoute 분석의 회원 총 사용액. 센 요청 수와 같아질 때까지 기다린다 */
    const settledTotal = async () => {
      const want = ok * OPENAI_COST;
      const end = Date.now() + 90_000;
      for (;;) {
        const a = await omni.getAnalytics({ apiKeyIds: orks(), startDate: new Date(Date.now() - 86_400_000 * 31), endDate: new Date(Date.now() + 60_000) });
        if (Math.abs(a.totalCost - want) < 1e-9) return a.totalCost;
        if (Date.now() > end) throw new Error(`분석 총 사용액 ${a.totalCost} ≠ 센 요청 ${ok} × ${OPENAI_COST}`);
        await sleep(500);
      }
    };
    /** 그 키의 예산: 우리 DB budget_usd 와 OmniRoute 에 실제로 걸린 월 예산(어댑터 getBudget)이 같아야 한다 (K5 리뷰 L2) */
    const budgetOf = async (keyId) => {
      const row = db.keys(memberId).find((k) => k.id === keyId);
      if (!row || row.budgetUsd === null) return null;
      const live = await omni.getBudget(row.ork);
      check(live.resetInterval === "monthly" && Math.abs(live.monthlyUsd - row.budgetUsd) < 1e-9, `OmniRoute 월 예산 ${live.monthlyUsd} == DB budget_usd ${row.budgetUsd}`);
      return row.budgetUsd;
    };

    // ---------- a. 끈 키는 거부된다 ----------
    const a = await issue();
    check(a.status === 201, `TC-K5.T2.a 발급 201 (${a.status} ${JSON.stringify(a.json?.error ?? null)})`);
    const A = { id: a.json.key.id, secret: a.json.secret };
    check((await spend(A.secret)).status === 200, "TC-K5.T2.a 발급 직후 요청 200");
    const off = await keyApi(A.id, "disable");
    check(off.status === 200 && off.json?.key?.state === "disabled", `TC-K5.T2.a disable 200 (${off.status} ${JSON.stringify(off.json)})`);
    const offReq = await infer(v1, A.secret);
    check(permissionDenied(offReq), `TC-K5.T2.a 끈 뒤 첫 요청 403 permission_denied (${offReq.status} ${JSON.stringify(offReq.json)})`);
    const on = await keyApi(A.id, "enable");
    check(on.status === 200 && on.json?.key?.state === "active", `다시 켜기 200 (${on.status} ${JSON.stringify(on.json)})`);

    // ---------- b. 여러 키로 나눠 써도 회원 한도에서 막힌다 ----------
    const b = await issue();
    check(b.status === 201, `TC-K5.T2.b 두 번째 키 발급 201 (${b.status} ${JSON.stringify(b.json?.error ?? null)})`);
    const B = { id: b.json.key.id, secret: b.json.secret };
    const keys = [A, B];
    const name = (k) => (k === A ? "A" : "B");
    const started = Date.now();
    // 한도까지: 번갈아 빨리 쓴다
    for (let turn = 0; ok * OPENAI_COST < LIMIT - 1e-12; turn++) {
      if (Date.now() - started > 120_000) throw new Error("TC-K5.T2.b 한도에 닿지 못했다 (2분)");
      const r = await spend(keys[turn % 2].secret);
      if (r.status !== 200) throw new Error(`TC-K5.T2.b 한도 전에 거부됐다 ${r.status} ${JSON.stringify(r.json)} (성공 ${ok}건)`);
    }
    const t0 = Date.now();
    log(`T0: 성공 요청 ${ok}건, 시험이 센 사용액 ${(ok * OPENAI_COST).toFixed(6)} ≥ 한도 ${LIMIT}`);
    // 몰아 쓰기: 두 키가 동시에, 키마다 거부될 때까지 연달아
    const burst = await Promise.all(
      keys.map(async (k) => {
        for (let n = 0; n < BURST_MAX; n++) {
          const r = await spend(k.secret);
          if (r.status === 200) continue;
          if (!limitRejected(r)) throw new Error(`TC-K5.T2.b 몰아 쓰기 중 예상하지 못한 응답 ${r.status} ${JSON.stringify(r.json)}`);
          return { k, n, rejected: `${r.status} ${r.json?.error?.code}` };
        }
        return { k, n: BURST_MAX, rejected: null };
      }),
    );
    for (const x of burst) log(`몰아 쓰기 키 ${name(x.k)}: 성공 ${x.n}건 뒤 ${x.rejected ?? `거부 없음 (${BURST_MAX}건)`}`);
    const total = await settledTotal();
    timings.overspendTotal = total;
    check(burst.every((x) => x.rejected) && total <= OVERSPEND_MAX + 1e-12, `TC-K5.T2.b 몰아 쓴 뒤 총 사용액 ${total.toFixed(6)} ≤ ${OVERSPEND_MAX.toFixed(6)} (성공 요청 ${ok}건, 두 키 모두 거부)`);
    // 반응 시간: 분배가 두 키를 끄는 것을 탐침으로 본다
    const offAt = new Map();
    while (offAt.size < keys.length && Date.now() - t0 <= REACT_MS + 10_000) {
      for (const k of keys.filter((x) => !offAt.has(x))) {
        const p = await infer(v1, k.secret, false);
        if (permissionDenied(p)) {
          offAt.set(k, Date.now());
          log(`키 ${name(k)} 꺼짐 (탐침 403 permission_denied, T0 + ${Date.now() - t0}ms)`);
        } else if (p.status !== 400) throw new Error(`탐침 응답이 예상과 다르다 ${p.status} ${JSON.stringify(p.json)}`);
      }
      await sleep(1000);
    }
    const reactMs = Math.max(...keys.map((k) => offAt.get(k) ?? Infinity)) - t0;
    timings.reactMs = reactMs;
    check(offAt.size === 2 && reactMs <= REACT_MS, `TC-K5.T2.b 한도 도달 뒤 ${reactMs}ms 안에 분배가 두 키를 끔 (≤ ${REACT_MS}ms, 꺼진 키 ${offAt.size}/2)`);
    const rows = db.keys(memberId);
    log(`b 뒤 키 행: ${rows.map((r) => `${r.state}/${r.reason}`).join(", ")}`);

    // ---------- c. 삭제·재발급으로 한도가 초기화되지 않는다 ----------
    for (const k of keys) {
      const d = await keyApi(k.id, "delete");
      check(d.status === 200 && d.json?.key?.state === "deleted", `TC-K5.T2.c 삭제 200 (${d.status} ${JSON.stringify(d.json)})`);
    }
    const again = await issue();
    check(again.status === 409 && again.json?.error === "limit_exhausted", `TC-K5.T2.c 삭제 뒤 새 발급 409 limit_exhausted (${again.status} ${JSON.stringify(again.json)})`);
    await setLimit(RAISED_C);
    const c = await issue();
    check(c.status === 201, `TC-K5.T2.c 한도 $${RAISED_C} 뒤 발급 201 (${c.status} ${JSON.stringify(c.json?.error ?? null)})`);
    const C = { id: c.json.key.id, secret: c.json.secret };
    const totalC = await settledTotal();
    const budgetC = await budgetOf(C.id);
    check(budgetC !== null && Math.abs(budgetC - (RAISED_C - totalC)) < 1e-6, `TC-K5.T2.c 새 키 예산 ${budgetC} == ${RAISED_C} − 총 사용액 ${totalC.toFixed(6)} (1e-6)`);

    // ---------- d. 재발급으로 한도가 초기화되지 않는다 (V19) ----------
    check((await spend(C.secret)).status === 200, "TC-K5.T2.d 키 C 요청 200");
    const totalD = await settledTotal();
    // 한도를 총 사용액 아래로 내려 한도 도달 상태로 둔다 (즉시 분배가 C 를 limit 으로 끈다)
    await setLimit(0.02);
    const regen1 = await keyApi(C.id, "regenerate");
    check(regen1.status === 409 && regen1.json?.error === "limit_exhausted", `TC-K5.T2.d 한도 도달 뒤 재발급 409 limit_exhausted (${regen1.status} ${JSON.stringify(regen1.json)})`);
    const oldAfter = await infer(v1, C.secret);
    check(permissionDenied(oldAfter), `TC-K5.T2.d 옛 원문의 다음 요청 403 (${oldAfter.status} ${JSON.stringify(oldAfter.json)})`);
    await setLimit(RAISED_D);
    // 한도를 올린 즉시 분배가 limit 으로 꺼진 C 를 다시 켰다 (탐침 400). 그래야 아래 "옛 원문 403" 이 재발급 덕분이다 (K5 리뷰 M2)
    const reopened = await infer(v1, C.secret, false);
    check(reopened.status === 400, `TC-K5.T2.d 재발급 전 C 는 켜져 있다 (탐침 ${reopened.status} ${JSON.stringify(reopened.json?.error ?? null)})`);
    const regen2 = await keyApi(C.id, "regenerate");
    check(regen2.status === 201 && typeof regen2.json?.secret === "string", `TC-K5.T2.d 한도를 올린 뒤 재발급 201 (${regen2.status} ${JSON.stringify(regen2.json?.error ?? null)})`);
    const D = { id: regen2.json.key.id, secret: regen2.json.secret };
    const budgetD = await budgetOf(D.id);
    check(budgetD !== null && Math.abs(budgetD - (RAISED_D - totalD)) < 1e-6, `TC-K5.T2.d 재발급 키 예산 ${budgetD} == ${RAISED_D} − 총 사용액 ${totalD.toFixed(6)} (옛 id 사용액 포함, 1e-6)`);
    const newReq = await spend(D.secret);
    check(newReq.status === 200, `TC-K5.T2.d 새 원문 200 (${newReq.status})`);
    const oldReq = await infer(v1, C.secret);
    check(permissionDenied(oldReq), `TC-K5.T2.d 옛 원문 바로 403 (${oldReq.status} ${JSON.stringify(oldReq.json)})`);
    log(`키 시나리오 측정: 한도 반영 ${timings.reactMs}ms, 그때 총 사용액 ${timings.overspendTotal.toFixed(6)} (상한 ${OVERSPEND_MAX.toFixed(6)})${ticker ? `, Cron 호출 ${ticker.calls}번` : ""}`);
  } finally {
    await ticker?.stop();
    // 계약 환경은 여러 시험이 같이 쓴다. 이 회원의 OmniRoute 키를 지운다 (Docker 묶음은 down 이 통째로 지운다)
    if (!docker && memberId) {
      for (const k of db.keys(memberId)) if (!k.ork.startsWith("pending-")) await omni.deleteKey(k.ork).catch(() => undefined);
    }
  }
}
