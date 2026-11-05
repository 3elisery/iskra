import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const cards = pgTable("cards", {
  id: text().primaryKey(),
  text: text().notNull(),
  author: text().notNull().default(""),
  tag: text().notNull().default("своё"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
