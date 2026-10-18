import type { user } from "./table.ts";
import { user as globalUser } from "./table.ts";
declare const db: any, h: any;
const u = h.schema.user;
export function shadow() {
  const u = h.schema.account;
  db.update(u).set({ password: "not-user" });
  { const u = h.schema.session; db.delete(u); }
}
export function otherFunction() {
  const globalUser = h.schema.auditLog;
  db.insert(globalUser).values({ action: "not-user" });
}
export function typeOnly() {
  db.delete(user);
}
export function objectSchema() {
  const schema = { user: h.schema.account };
  db.delete(schema.user);
}
const cache = new Map();
cache.delete("any-key");
