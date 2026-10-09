#!/usr/bin/env node
// V11 (S1.T2): 키를 끄면(PATCH isActive=false) 곧바로 추론 요청이 거부되는지 확인.
//
// 사용:
//   node spikes/v11/run.mjs            # 측정 결과 JSON 출력
//   node spikes/v11/run.mjs --assert   # PATCH 응답 직후 첫 요청이 2xx 가 아니면 종료코드 0
//
// 환경 변수: OMNI_URL (기본 http://127.0.0.1:20140), OMNI_PASSWORD (기본 phase0-pass),
//            V11_MODEL (기본 mko/mock-gpt)
// 실행마다 write 범위 토큰과 키를 새로 만들고 끝나면 지운다 (라벨 접두사 v11-).

const BASE = process.env.OMNI_URL ?? 'http://127.0.0.1:20140';
const PASSWORD = process.env.OMNI_PASSWORD ?? 'phase0-pass';
const MODEL = process.env.V11_MODEL ?? 'mko/mock-gpt';
const RUN = Date.now().toString(36);
const ASSERT = process.argv.includes('--assert');

async function http(method, path, { bearer, cookie, body, origin } = {}) {
  const headers = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = BASE;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function infer(sk) {
  const r = await http('POST', '/v1/chat/completions', {
    bearer: sk,
    body: { model: MODEL, messages: [{ role: 'user', content: 'v11 ping' }], stream: false, max_tokens: 8 },
  });
  const code = r.json?.error?.code ?? r.json?.code ?? null;
  return { status: r.status, code, message: (r.json?.error?.message ?? '').slice(0, 120) || undefined };
}

async function main() {
  const login = await http('POST', '/api/auth/login', { body: { password: PASSWORD }, origin: true });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((s) => s.split(';')[0]).find((s) => s.startsWith('auth_token='));
  if (!cookie) throw new Error(`로그인 실패 ${login.status}`);

  const t = await http('POST', '/api/cli/connect', {
    body: { password: PASSWORD, name: `v11-write-${RUN}`, scope: 'write', expiresInDays: 1 },
  });
  if (!t.json?.token) throw new Error(`토큰 발급 실패 ${t.status} ${t.text.slice(0, 200)}`);
  const token = t.json.token;
  let keyId = null;
  const report = { base: BASE, run: RUN, model: MODEL, steps: [] };
  try {
    const k = await http('POST', '/api/keys', { bearer: token, body: { name: `v11-key-${RUN}` } });
    if (k.status !== 201 && k.status !== 200) throw new Error(`키 생성 실패 ${k.status}`);
    keyId = k.json.id;
    const sk = k.json.key;

    report.before = await infer(sk);

    const t0 = Date.now();
    const p = await http('PATCH', `/api/keys/${keyId}`, { bearer: token, body: { isActive: false } });
    const tPatch = Date.now();
    report.patch = { status: p.status, ms: tPatch - t0 };

    const at = async (label, targetMs) => {
      const wait = tPatch + targetMs - Date.now();
      if (wait > 0) await sleep(wait);
      const sentAt = Date.now() - tPatch;
      const r = await infer(sk);
      report.steps.push({ label, sentAfterPatchMs: sentAt, ...r });
    };
    await at('즉시(0ms)', 0);
    await at('1s', 1000);
    await at('5s', 5000);

    const firstReject = report.steps.find((s) => s.status < 200 || s.status >= 300);
    report.delayMs = firstReject ? firstReject.sentAfterPatchMs : null;
    report.firstAfterPatchRejected = !(report.steps[0].status >= 200 && report.steps[0].status < 300);

    // 참고: 다시 켜면(isActive=true) 곧바로 통과하는지 (5.2 발급 순서 5단계)
    const p2 = await http('PATCH', `/api/keys/${keyId}`, { bearer: token, body: { isActive: true } });
    report.reenable = { patchStatus: p2.status, immediate: await infer(sk) };
  } finally {
    if (keyId) await http('DELETE', `/api/keys/${keyId}`, { cookie, origin: true }).catch(() => {});
    await http('DELETE', `/api/cli/tokens/${t.json.id}`, { cookie, origin: true }).catch(() => {});
    report.cleanup = { key: keyId, token: t.json.id };
  }
  console.log(JSON.stringify(report, null, 2));
  if (ASSERT) process.exit(report.before?.status === 200 && report.firstAfterPatchRejected ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
