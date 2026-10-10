// K5.T2 여섯 조합 키 시나리오 (TC-K5.T2.a~d, 계획서 v5.7 5.2·5.3, Q1·V18·V19). pnpm e2e --combo <조합> --scenario keys
//
// 설치·관리자(run.mjs) 뒤 회원(DB 직접) → 관리자 API 로 한도 $0.02·최대 키 2 → 넷:
//   a  발급 → 요청 200 → POST /api/me/keys/:id/disable → 다음 요청 403 permission_denied (다시 켜서 b 에 쓴다)
//   b  키 둘로 번갈아 요청. 회원 총 사용액이 한도에 닿은 시각(T0)부터 125,000ms 안에 두 키 모두 거부
//      (isBudgetBlocked 또는 limit 끄기의 403). 그때 총 사용액 ≤ 0.02 × 2 + 0.004878
//   c  두 키 삭제 → 새 발급 409 limit_exhausted. 한도 $0.04 → 발급 → 그 키 예산 == 0.04 − 총 사용액 (1e-6)
//   d  한도 도달 뒤 남은 키 재발급 → 409 limit_exhausted, 옛 원문 403. 한도를 올린 뒤 재발급 → 그 키 예산 == 한도 − 총 사용액
//      (옛 id 사용액 포함, 1e-6), 새 원문 200, 옛 원문 바로 403
//
// 요청 비용: mko/mock-gpt 1건 0.00221 (tests/contract/setup.mjs 가격). 총 사용액은 OmniRoute 분석(어댑터)으로 확인하고
// 시험이 센 성공 요청 수 × 0.00221 과 맞춘다.
// b 의 속도: T0 까지는 빨리 쓰고, T0 뒤에는 15초마다 한 건만 쓴다. 키마다 남은 예산이 T0 에 대략 요청 5건이라
// 키 예산만으로 막히려면 150초가 넘게 걸린다 — 125초 안에 막히는 것은 분배(1분 주기)가 남은 한도 0 을 보고 키를 끈 것이다.
// 거부는 매초 비용 없는 탐침(env.mjs infer real=false)으로도 본다. 탐침은 꺼진 키를 403 으로 보지만 예산 차단은 보지 못한다.
// 분배를 기다릴 때 Node(Docker)는 앱의 1분 경계 타이머 그대로, Workers 는 1분 경계마다 /__scheduled 로 Cron 을 부른다.
import { ADMIN, appHttp, check, d1File, dbOps, infer, limitRejected, log, OPENAI_COST, omniClient, permissionDenied, sleep, STACK_OMNI_URL } from "./env.mjs";

export const LIMIT = 0.02;
export const MAX_KEYS = 2;
/** 한도 반영 상한: 지출 기록 60초 + 분배 주기 1분 + 분배 소요 5초 (V15) */
export const REACT_MS = 125_000;
/** 초과 폭 상한: 한도 × 최대 키 2 + 요청 1건 (계획서 5.3) */
export const OVERSPEND_MAX = LIMIT * MAX_KEYS + 0.004878;
const SLOW_MS = 15_000;

/** 1분 경계마다 Workers Cron 을 부른다 (wrangler dev --test-scheduled). stop() 으로 멈춘다 */
function cronTicker(baseUrl) {
  let stopped = false;
  let calls = 0;
  const loop = (async () => {
    while (!stopped) {
      const next = Math.ceil((Date.now() + 1) / 60_000) * 60_000;
      while (!stopped && Date.now() < next) await sleep(Math.min(500, next - Date.now()));
      if (stopped) break;
      const minute = new Date(next).getUTCMinutes();
      for (const cron of ["* * * * *", ...(minute % 5 === 0 ? ["*/5 * * * *"] : [])]) {
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
      check(r.status === 200 && r.json?.user?.monthlyLimitUsd === usd, `관리자 한도 $${usd} (${r.status} ${JSON.stringify(r.json)})`);
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
    const budgetOf = (keyId) => db.keys(memberId).find((k) => k.id === keyId)?.budgetUsd ?? null;

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
    const blockedAt = new Map();
    const started = Date.now();
    let t0 = null;
    let turn = 0;
    let lastSpend = 0;
    while (blockedAt.size < keys.length) {
      const now = Date.now();
      if (t0 !== null && now - t0 > REACT_MS + 10_000) break;
      if (now - started > 600_000) throw new Error("TC-K5.T2.b 한도에 닿지 못했다 (10분)");
      const live = keys.filter((k) => !blockedAt.has(k));
      // 쓰기: T0 전에는 매번, 뒤에는 15초마다 한 건 (번갈아)
      if (t0 === null || now - lastSpend >= SLOW_MS) {
        const k = live[turn++ % live.length];
        const r = await spend(k.secret);
        lastSpend = Date.now();
        if (r.status !== 200) {
          if (!limitRejected(r)) throw new Error(`TC-K5.T2.b 예상하지 못한 응답 ${r.status} ${JSON.stringify(r.json)}`);
          blockedAt.set(k, Date.now());
          log(`키 ${keys.indexOf(k) === 0 ? "A" : "B"} 거부 (실제 요청 ${r.status} ${r.json?.error?.code})`);
        } else if (t0 === null && ok * OPENAI_COST >= LIMIT - 1e-12) {
          t0 = Date.now();
          log(`T0: 성공 요청 ${ok}건, 시험이 센 사용액 ${(ok * OPENAI_COST).toFixed(6)} ≥ 한도 ${LIMIT}`);
        }
      }
      // 탐침 (비용 없음): 꺼진 키를 바로 본다
      if (t0 !== null) {
        for (const k of keys.filter((x) => !blockedAt.has(x))) {
          const p = await infer(v1, k.secret, false);
          if (permissionDenied(p)) {
            blockedAt.set(k, Date.now());
            log(`키 ${keys.indexOf(k) === 0 ? "A" : "B"} 거부 (탐침 403 permission_denied)`);
          } else if (p.status !== 400) throw new Error(`탐침 응답이 예상과 다르다 ${p.status} ${JSON.stringify(p.json)}`);
        }
        await sleep(1000);
      }
    }
    check(t0 !== null, "TC-K5.T2.b 회원 총 사용액이 한도에 닿음");
    const reactMs = Math.max(...keys.map((k) => blockedAt.get(k) ?? Infinity)) - t0;
    timings.reactMs = reactMs;
    check(blockedAt.size === 2 && reactMs <= REACT_MS, `TC-K5.T2.b 한도 도달 뒤 ${reactMs}ms 안에 두 키 모두 거부 (≤ ${REACT_MS}ms, 거부된 키 ${blockedAt.size}/2, 성공 요청 ${ok}건)`);
    const total = await settledTotal();
    timings.overspendTotal = total;
    check(total <= OVERSPEND_MAX + 1e-12, `TC-K5.T2.b 그때 총 사용액 ${total.toFixed(6)} ≤ ${OVERSPEND_MAX.toFixed(6)} (성공 요청 ${ok}건)`);
    const rows = db.keys(memberId);
    log(`b 뒤 키 행: ${rows.map((r) => `${r.state}/${r.reason}`).join(", ")}`);

    // ---------- c. 삭제·재발급으로 한도가 초기화되지 않는다 ----------
    for (const k of keys) {
      const d = await keyApi(k.id, "delete");
      check(d.status === 200 && d.json?.key?.state === "deleted", `TC-K5.T2.c 삭제 200 (${d.status} ${JSON.stringify(d.json)})`);
    }
    const again = await issue();
    check(again.status === 409 && again.json?.error === "limit_exhausted", `TC-K5.T2.c 삭제 뒤 새 발급 409 limit_exhausted (${again.status} ${JSON.stringify(again.json)})`);
    await setLimit(0.04);
    const c = await issue();
    check(c.status === 201, `TC-K5.T2.c 한도 $0.04 뒤 발급 201 (${c.status} ${JSON.stringify(c.json?.error ?? null)})`);
    const C = { id: c.json.key.id, secret: c.json.secret };
    const totalC = await settledTotal();
    const budgetC = budgetOf(C.id);
    check(budgetC !== null && Math.abs(budgetC - (0.04 - totalC)) < 1e-6, `TC-K5.T2.c 새 키 예산 ${budgetC} == 0.04 − 총 사용액 ${totalC.toFixed(6)} (1e-6)`);

    // ---------- d. 재발급으로 한도가 초기화되지 않는다 (V19) ----------
    check((await spend(C.secret)).status === 200, "TC-K5.T2.d 키 C 요청 200");
    const totalD = await settledTotal();
    // 한도를 총 사용액 아래로 내려 한도 도달 상태로 둔다 (즉시 분배가 C 를 limit 으로 끈다)
    await setLimit(0.02);
    const regen1 = await keyApi(C.id, "regenerate");
    check(regen1.status === 409 && regen1.json?.error === "limit_exhausted", `TC-K5.T2.d 한도 도달 뒤 재발급 409 limit_exhausted (${regen1.status} ${JSON.stringify(regen1.json)})`);
    const oldAfter = await infer(v1, C.secret);
    check(permissionDenied(oldAfter), `TC-K5.T2.d 옛 원문의 다음 요청 403 (${oldAfter.status} ${JSON.stringify(oldAfter.json)})`);
    await setLimit(0.06);
    const regen2 = await keyApi(C.id, "regenerate");
    check(regen2.status === 201 && typeof regen2.json?.secret === "string", `TC-K5.T2.d 한도를 올린 뒤 재발급 201 (${regen2.status} ${JSON.stringify(regen2.json?.error ?? null)})`);
    const D = { id: regen2.json.key.id, secret: regen2.json.secret };
    const budgetD = budgetOf(D.id);
    check(budgetD !== null && Math.abs(budgetD - (0.06 - totalD)) < 1e-6, `TC-K5.T2.d 재발급 키 예산 ${budgetD} == 0.06 − 총 사용액 ${totalD.toFixed(6)} (옛 id 사용액 포함, 1e-6)`);
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
