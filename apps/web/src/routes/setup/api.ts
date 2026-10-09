// 최초 설치 API 호출 (apps/server src/setup/routes.ts). 결과는 모두 { ok } 판별 유니온으로 돌려준다.

export interface SetupForm {
  token: string;
  email: string;
  password: string;
  name: string;
  publicBaseUrl: string;
}

export type SetupStatus = { ok: true; needed: boolean } | { ok: false; reason: string };
export type SetupSubmit = { ok: true } | { ok: false; reason: string };

const REASONS: Record<string, string> = {
  invalid_token: "설치 토큰이 맞지 않습니다. 서버 콘솔에 출력된 토큰을 그대로 넣어 주세요.",
  already_set_up: "이미 설치가 끝났습니다.",
  invalid_email: "이메일 형식을 확인해 주세요.",
  invalid_password: "비밀번호는 8자 이상 128자 이하로 정해 주세요.",
  invalid_publicBaseUrl: "공개 주소는 http:// 또는 https:// 로 시작해야 합니다.",
};

export async function fetchSetupStatus(): Promise<SetupStatus> {
  const res = await fetch("/api/setup");
  if (!res.ok) return { ok: false, reason: `설치 상태를 읽지 못했습니다 (HTTP ${res.status}).` };
  const body = (await res.json()) as { needed: boolean };
  return { ok: true, needed: body.needed };
}

export async function submitSetup(form: SetupForm): Promise<SetupSubmit> {
  const res = await fetch("/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(form),
  });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, reason: REASONS[body.error ?? ""] ?? `설치하지 못했습니다 (HTTP ${res.status}).` };
}
