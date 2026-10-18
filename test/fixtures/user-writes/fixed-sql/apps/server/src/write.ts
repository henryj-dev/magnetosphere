import { sql } from "drizzle-orm";
declare const db: any, values: any;
export function reserveSlot() {
  return db.all(sql`
    INSERT INTO api_keys (id, user_id, omniroute_key_id, key_preview, label, state, disabled_reason, sync_state, created_at)
    SELECT ${values.id}, ${values.userId}, ${values.omnirouteKeyId}, ${values.keyPreview}, ${values.label}, ${values.state}, ${values.disabledReason}, ${values.syncState}, ${values.createdAt}
    WHERE (SELECT count(*) FROM api_keys WHERE user_id = ${values.userId}) < ${values.max}
    RETURNING id`);
}
export function fixedUser() {
  return db.run(sql`UPDATE user SET email = ${"never-print-this-secret"} WHERE id = ${values.id}`);
}
