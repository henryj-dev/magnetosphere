// M4 Red 뼈대: 형태만 둔다. 구현은 다음 커밋이다.
import { APIError } from "better-auth/api";
import type { AuthConfig } from "./index.ts";

export const invalidReset = () => new APIError("BAD_REQUEST", { code: "INVALID_TOKEN", message: "Invalid token" });

export function observedAuthVersion(_id: string): number | undefined {
  throw new Error("M4 미구현");
}

export interface CredentialWrite {
  userId: string;
  version: number;
  password: string;
  mode: "reset-create" | "reset-update" | "change";
  account?: any;
  session?: any;
  fingerprint?: string;
  rotate?: boolean;
  data?: Record<string, any>;
}

export function credentialWriter(_cfg: AuthConfig): any {
  throw new Error("M4 미구현");
}

export function safeResetAdapter(_cfg: AuthConfig): any {
  throw new Error("M4 미구현");
}

export async function confirmResetEmail(_cfg: AuthConfig, _userId: string): Promise<void> {
  throw new Error("M4 미구현");
}
