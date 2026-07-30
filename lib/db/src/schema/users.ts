import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";

export type UserRole = "owner" | "assistant" | "reader";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  // scrypt: "salt:hash" в hex. Встроен в node:crypto — не тянем нативных зависимостей,
  // которые пришлось бы собирать на сервере.
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  role: text("role").$type<UserRole>().notNull().default("owner"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Сессии в базе, а не подписанный JWT: выход должен мгновенно обрывать доступ
 * (в системе лежат данные о здоровье — отзыв сессии важнее экономии запроса).
 * Хранится sha256 от токена: утечка дампа базы не даёт войти.
 */
export const sessionsTable = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    userIdx: index("sessions_user_idx").on(t.userId),
  }),
);

export type User = typeof usersTable.$inferSelect;
export type Session = typeof sessionsTable.$inferSelect;
