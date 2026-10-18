declare const db: any, h: any;
export function bounded() {
  const u = h.schema.user;
  const base = { name: "never-print-this-secret" };
  const set = { ...base };
  set.email = "not-logged";
  db.update(u).set(set);
  db.insert(u).values({ name: "not-logged" }).onConflictDoUpdate({ target: u.id, set: { role: "admin" } });
}
