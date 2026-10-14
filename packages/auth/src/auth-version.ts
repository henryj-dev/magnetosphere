import { AUTH_VERSION_MAX } from "@magnetosphere/db/src/schema/common.ts";

/** DB에서 읽은 값도 변환하거나 기본값으로 보정하지 않는다. */
export function validAuthVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= AUTH_VERSION_MAX;
}

export function aliveAuthUser(user: any): boolean {
  return !!user && validAuthVersion(user.authVersion) && !user.deletedAt && ["pending", "active"].includes(user.status);
}

export function activeAuthUser(user: any): boolean {
  return aliveAuthUser(user) && user.status === "active" && !!user.emailVerified;
}
