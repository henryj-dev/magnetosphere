import { sql } from "drizzle-orm";
declare const db: any;
export function quoted() {
  db.run(sql`UPDATE "User" SET email = ${"not-logged"}`);
  db.run(sql`INSERT INTO "public" . "user" (id) VALUES (${1})`);
  db.run(sql`DELETE FROM \`tenant\`.\`user\` WHERE id = ${1}`);
}
export function qualified() {
  db.run(sql`INSERT INTO public.api_keys (id) VALUES (${1})`);
  db.run(sql`UPDATE tenant.USER SET name = ${"not-logged"}`);
}
export function unsupported() {
  db.run(sql`INSERT INTO [user] (id) VALUES (${1})`);
}
