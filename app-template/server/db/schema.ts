import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// An example table, to replace with the app's own.
export const notes = pgTable("notes", {
  id: serial("id").primaryKey(),
  ownerSub: text("owner_sub").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
