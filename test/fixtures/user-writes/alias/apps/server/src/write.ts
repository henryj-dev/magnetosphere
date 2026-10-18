declare const db: any, h: any, s: any, schema: any;
export function alias() {
  const u = h.schema.user;
  const next = (u as any);
  db.insert(next).values({ email: "never-print-this-secret" });
  db.update(s.db.schema.user).set({ status: "pending" });
  db.delete(schema["user"]);
}
