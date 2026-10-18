import { sql as query } from "drizzle-orm";
declare const db: any, h: any;
export function raw() {
  const { user: u, account } = h.schema;
  db.run(query`UPDATE ${u} SET email = ${"never-print-this-secret"}, status = ${"active"} WHERE id = ${"not-logged"}`);
  db.run(query`INSERT INTO ${u} (email, name) VALUES (${"not-logged"}, ${"not-logged"})`);
  db.run(query`DELETE FROM ${u} WHERE id = ${"not-logged"}`);
  db.run(query`select * from ${u}`);
  db.run(query`UPDATE ${account} SET password = ${"not-logged"}`);
}
export function interpolatedColumn() {
  const u = h.schema.user;
  db.run(query`update ${u} set ${u.emailVerified} = ${true}, ${u.updatedAt} = ${1} where ${u.id} = ${"not-logged"}`);
}
