import { sql } from "drizzle-orm";
declare const db: any, h: any;
export function dynamic(table: any, key: string) {
  db.insert(table).values({ email: "never-print-this-secret" });
  db.update(h.schema[key]).set({ name: "not-logged" });
  db.delete(selectTable());
  db.run(sql`DELETE FROM ${table}`);
}
declare function selectTable(): any;
export function reassigned() {
  let u = h.schema.account;
  u = h.schema.user;
  db.delete(u);
}
export function rawLiteral() {
  db.run(sql`UPDATE user SET email = 'never-print-this-secret'`);
}
