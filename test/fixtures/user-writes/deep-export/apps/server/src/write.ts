import { user } from "./second.ts";
declare const db: any;
export function deeper() { db.delete(user); }
