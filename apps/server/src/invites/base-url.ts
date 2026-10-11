// 초대 링크의 앞부분 (M3.T1). 설치 때 app_settings.public_base_url 에 JSON 문자열로 저장한 공개 주소를 읽는다
// (setup/index.ts writeSetting → settings writeAppSetting, JSON.stringify).
// http(s) 이고 사용자 정보·쿼리·조각이 없는 주소만 받는다. 돌려주는 값은 origin + pathname 에서 끝 슬래시를 뗀 것이다.
// 행이 없거나 그 밖의 값이면 null (설치 전으로 본다).
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
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || u.search || u.hash) return null;
  return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
}
