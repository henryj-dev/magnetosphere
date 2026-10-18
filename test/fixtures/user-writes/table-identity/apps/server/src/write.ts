import { sql } from "drizzle-orm";
declare const db: any;
export function same() {
  db.run(sql`INSERT INTO api_keys (id) VALUES (${1})`);
  db.run(sql`INSERT INTO user (id) VALUES (${2})`);
  db.run(sql`INSERT INTO audit_log (id) VALUES (${3})`);
}
