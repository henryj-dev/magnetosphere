// 초대 링크의 앞부분 (M3.T1). 설치 때 app_settings.public_base_url 에 JSON 문자열로 저장한 공개 주소를 읽는다
// (setup/index.ts writeSetting → settings writeAppSetting, JSON.stringify). 행이 없거나 http(s) 주소가 아니면 null (설치 전).
import { eq } from "drizzle-orm";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { PUBLIC_BASE_URL_KEY } from "../setup/index.ts";

/** 끝 슬래시를 뗀 공개 주소. 없으면 null */
export async function readPublicBaseUrl(h: DbHandle): Promise<string | null> {
  const t = h.schema.appSettings;
  const [row] = await h.db.select({ value: t.value }).from(t).where(eq(t.key, PUBLIC_BASE_URL_KEY));
  if (!row) return null;
  let v: unknown;
  try {
    v = JSON.parse(row.value);
  } catch {
    return null;
  }
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\/+$/, "");
  try {
    if (!["http:", "https:"].includes(new URL(s).protocol)) return null;
  } catch {
    return null;
  }
  return s;
}
