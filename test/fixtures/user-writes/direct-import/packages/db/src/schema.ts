import { sqliteTable, text } from "drizzle-orm/sqlite-core";
export const user = sqliteTable("user", { email: text("email") });
export const account = sqliteTable("account", { email: text("email") });
