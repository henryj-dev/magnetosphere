import { userAlias as u } from "./barrel.ts";
declare const db: any;
export function reexport() {
  db.delete(u);
}
