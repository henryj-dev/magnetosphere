// TC-K6.T4.a·c 의 D1 시험 Worker. 운영과 같은 pruneDone 을 로컬 D1 에 붙인다. 진입 모듈이라 default 말고는 내보내지 않는다.
//   POST /__test/insert {rows: [{ id, doneAt, failedAt }]}  → { inserted }   시각은 ms (null 이면 비움). D1 바인드 변수 상한 때문에 10행씩 넣는다
//   POST /__test/lease  {holder, now}                       → { lease }      job_leases "omniroute_jobs" 임대 (못 잡으면 null)
//   POST /__test/prune  {now, lease?}                       → { deleted }
//   GET  /__test/ids                                        → { ids }
import { acquireLease, type Lease } from "@magnetosphere/runtime/lease";
import { connectWorkers, type WorkersEnv } from "@magnetosphere/runtime/workers";
import { pruneDone } from "../../src/queue/index.ts";

type Row = { id: string; doneAt: number | null; failedAt: number | null };
const at = (ms: number | null) => (ms === null ? null : new Date(ms));

export default {
  async fetch(req: Request, env: WorkersEnv): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    const h = await connectWorkers(env);
    const j = h.schema.omnirouteJobs;
    if (url.pathname === "/__test/insert" && req.method === "POST") {
      const { rows } = (await req.json()) as { rows: Row[] };
      const values = rows.map((r) => ({ id: r.id, action: "budget.set", payload: "{}", attempts: 1, nextRunAt: new Date(0), doneAt: at(r.doneAt), failedAt: at(r.failedAt) }));
      for (let i = 0; i < values.length; i += 10) await h.db.insert(j).values(values.slice(i, i + 10));
      return Response.json({ inserted: values.length });
    }
    if (url.pathname === "/__test/lease" && req.method === "POST") {
      const b = (await req.json()) as { holder: string; now: number };
      return Response.json({ lease: await acquireLease(h, "omniroute_jobs", b.holder, 55_000, new Date(b.now)) });
    }
    if (url.pathname === "/__test/prune" && req.method === "POST") {
      const b = (await req.json()) as { now: number; lease?: Lease };
      return Response.json({ deleted: await pruneDone(h, new Date(b.now), b.lease ? { lease: b.lease } : {}) });
    }
    if (url.pathname === "/__test/ids") return Response.json({ ids: (await h.db.select({ id: j.id }).from(j)).map((r: { id: string }) => r.id) });
    return new Response("not found", { status: 404 });
  },
};
