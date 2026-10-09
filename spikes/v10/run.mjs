#!/usr/bin/env node
// V10 (S1.T1): 관리 접근 토큰(oma_live_…)의 최소 범위와 비밀번호 → 토큰 자동 발급 흐름 확인.
//
// 사용:
//   node spikes/v10/run.mjs                    # read/write/admin 전체 표를 JSON 으로 출력
//   node spikes/v10/run.mjs --assert min       # minScope 토큰으로 7개 호출이 모두 2xx 면 종료코드 0
//   node spikes/v10/run.mjs --assert lower-fails  # 한 단계 낮은 범위가 7개 중 1개 이상 403 이면 종료코드 0
//
// 환경 변수: OMNI_URL (기본 http://127.0.0.1:20140), OMNI_PASSWORD (기본 phase0-pass),
//            V10_MIN_SCOPE (기본 docs/verify/V10.json 의 answer.minScope, 없으면 write)
// 실행마다 새 토큰·키를 만들고 끝나면 지운다 (라벨 접두사 v10-).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.env.OMNI_URL ?? 'http://127.0.0.1:20140';
const PASSWORD = process.env.OMNI_PASSWORD ?? 'phase0-pass';
const SCOPES = ['read', 'write', 'admin'];
const RUN = `${Date.now().toString(36)}`;

const args = process.argv.slice(2);
const assertIdx = args.indexOf('--assert');
const assertMode = assertIdx >= 0 ? args[assertIdx + 1] : null;
if (assertIdx >= 0 && !['min', 'lower-fails'].includes(assertMode)) {
  console.error('사용법: --assert min | --assert lower-fails');
  process.exit(2);
}

function readMinScope() {
  if (process.env.V10_MIN_SCOPE) return process.env.V10_MIN_SCOPE;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const v = JSON.parse(readFileSync(join(here, '../../docs/verify/V10.json'), 'utf8'));
    if (v?.answer?.minScope) return v.answer.minScope;
  } catch {}
  return 'write';
}

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

// 비밀번호 → 토큰 (omniroute connect 와 같은 공개 경로, 비밀번호로만 보호)
async function mintToken(scope) {
  const r = await http('POST', '/api/cli/connect', {
    body: { password: PASSWORD, name: `v10-${scope}-${RUN}`, scope, expiresInDays: 1 },
  });
  if (r.status !== 200 || !r.json?.token?.startsWith('oma_live_')) {
    throw new Error(`토큰 발급 실패 scope=${scope} status=${r.status} ${r.text.slice(0, 200)}`);
  }
  return { id: r.json.id, token: r.json.token, scope: r.json.scope };
}

async function adminCookie() {
  const r = await http('POST', '/api/auth/login', { body: { password: PASSWORD }, origin: true });
  const set = r.headers.getSetCookie?.() ?? [];
  const c = set.map((s) => s.split(';')[0]).find((s) => s.startsWith('auth_token='));
  if (r.status !== 200 || !c) throw new Error(`로그인 실패 status=${r.status}`);
  return c;
}

// 1·2단계에 쓰는 관리 호출 7개. 키 생성이 실패하면 쿠키로 만든 예비 키에 나머지를 시험한다.
async function runSeven(cred, spareKeyId) {
  const out = {};
  const created = [];
  const c1 = await http('POST', '/api/keys', { bearer: cred, body: { name: `v10-key-${RUN}`, label: `v10-key-${RUN}` } });
  out.createKey = c1.status;
  const newId = c1.json?.id ?? c1.json?.key?.id ?? null;
  if (newId) created.push(newId);
  const target = newId ?? spareKeyId;
  out.listKeys = (await http('GET', '/api/keys', { bearer: cred })).status;
  out.patchKey = (await http('PATCH', `/api/keys/${target}`, { bearer: cred, body: { isActive: false } })).status;
  out.setBudget = (await http('POST', '/api/usage/budget', {
    bearer: cred, body: { apiKeyId: target, dailyLimitUsd: 1, weeklyLimitUsd: 5, monthlyLimitUsd: 20 },
  })).status;
  out.analytics = (await http('GET', `/api/usage/analytics?range=7d&apiKeyIds=${target}`, { bearer: cred })).status;
  out.callLogs = (await http('GET', '/api/usage/call-logs?limit=5', { bearer: cred })).status;
  const d = await http('DELETE', `/api/keys/${target}`, { bearer: cred });
  out.deleteKey = d.status;
  if (d.status >= 200 && d.status < 300) created.length = 0;
  return { statuses: out, leftovers: created };
}

async function main() {
  const cookie = await adminCookie();
  const tokens = [];
  const keysToClean = [];
  const report = { base: BASE, run: RUN, mintVia: 'POST /api/cli/connect {password,name,scope,expiresInDays}', matrix: {} };
  const ok = (s) => s >= 200 && s < 300;
  try {
    const minScope = readMinScope();
    let targets;
    if (assertMode === 'min') targets = [minScope];
    else if (assertMode === 'lower-fails') {
      const i = SCOPES.indexOf(minScope);
      targets = [i > 0 ? SCOPES[i - 1] : 'sk-no-manage'];
    } else targets = [...SCOPES, 'sk-no-manage'];

    for (const t of targets) {
      // 키 생성이 막히는 범위를 위해, 쿠키로 예비 키를 하나 만들어 둔다.
      const spare = await http('POST', '/api/keys', { cookie, origin: true, body: { name: `v10-spare-${t}-${RUN}` } });
      const spareId = spare.json?.id;
      if (!spareId) throw new Error(`예비 키 생성 실패 ${spare.status} ${spare.text.slice(0, 200)}`);
      keysToClean.push(spareId);
      let cred;
      if (t === 'sk-no-manage') {
        // 추론 전용 키(관리 범위 없음): 예비 키와 다른 키를 하나 더 만든다.
        const k = await http('POST', '/api/keys', { cookie, origin: true, body: { name: `v10-sk-${RUN}` } });
        keysToClean.push(k.json?.id);
        cred = k.json?.key;
      } else {
        const tok = await mintToken(t);
        tokens.push(tok);
        cred = tok.token;
      }
      const r = await runSeven(cred, spareId);
      keysToClean.push(...r.leftovers);
      const vals = Object.values(r.statuses);
      report.matrix[t] = { ...r.statuses, allOk: vals.every(ok), any403: vals.some((s) => s === 403) };
    }

    // 토큰 목록이 범위를 드러내는지 (TC-S5.T3.b 용)
    const list = await http('GET', '/api/cli/tokens', { cookie });
    const mine = (list.json?.tokens ?? []).filter((x) => tokens.some((t) => t.id === x.id));
    report.tokenListExposesScope = mine.length > 0 && mine.every((x) => SCOPES.includes(x.scope) && x.scope === tokens.find((t) => t.id === x.id).scope);
    report.tokenListSample = mine.map(({ id, name, scope, tokenPrefix }) => ({ id, name, scope, tokenPrefix }));
    report.minScopeUsed = minScope;
  } finally {
    for (const id of keysToClean.filter(Boolean)) {
      await http('DELETE', `/api/keys/${id}`, { cookie, origin: true }).catch(() => {});
    }
    for (const t of tokens) {
      await http('DELETE', `/api/cli/tokens/${t.id}`, { cookie, origin: true }).catch(() => {});
    }
    report.cleanup = { keys: keysToClean.filter(Boolean).length, tokens: tokens.length };
  }

  console.log(JSON.stringify(report, null, 2));
  if (assertMode === 'min') {
    const row = report.matrix[report.minScopeUsed];
    process.exit(row?.allOk ? 0 : 1);
  }
  if (assertMode === 'lower-fails') {
    const row = Object.values(report.matrix)[0];
    process.exit(row?.any403 ? 0 : 1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
