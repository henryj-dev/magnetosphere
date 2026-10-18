import { user as canonical, account } from "../../../packages/db/src/schema.ts";
import * as tables from "../../../packages/db/src/schema.ts";
declare const db: any;
export function direct() {
  db.insert(canonical).values({ email: "not-logged" });
  db.delete(tables.user);
  db.update(account).set({ email: "not-a-user-write" });
}
