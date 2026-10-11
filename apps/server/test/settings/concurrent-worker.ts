// TC-M1.T1.d 의 D1 시험 Worker. 운영과 같은 설정 쓰기 둘을 로컬 D1 에 붙인다. 진입 모듈이라 default 말고는 내보내지 않는다.
//   POST /__test/write {via: "settings" | "setup", key, value} → { ok: true } 또는 500 { error }
//   GET  /__test/rows?key=<키>                                 → { values } (그 키 행의 값들)
import { eq } from "drizzle-orm";
import { connectWorkers, type WorkersEnv } from "@magnetosphere/runtime/workers";
import { writeSetting, type SettingKey } from "../../src/settings/index.ts";
import { writeSetting as writeSetupSetting } from "../../src/setup/index.ts";

export default {
  async fetch(req: Request, env: WorkersEnv): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    const h = await connectWorkers(env);
    if (url.pathname === "/__test/write" && req.method === "POST") {
      const b = (await req.json()) as { via: "settings" | "setup"; key: string; value: unknown };
      try {
        if (b.via === "settings") await writeSetting(h, b.key as SettingKey, b.value, "admin-1", new Date());
        else await writeSetupSetting(h, b.key, b.value, "admin-1");
        return Response.json({ ok: true });
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
      }
    }
    if (url.pathname === "/__test/rows") {
      const t = h.schema.appSettings;
      const rows = await h.db.select({ value: t.value }).from(t).where(eq(t.key, url.searchParams.get("key") ?? ""));
      return Response.json({ values: rows.map((r: { value: string }) => JSON.parse(r.value)) });
    }
    return new Response("not found", { status: 404 });
  },
};
