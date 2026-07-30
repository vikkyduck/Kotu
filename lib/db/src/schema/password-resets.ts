import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Одноразовые ссылки для сброса забытого пароля.
 *
 * В базе лежит только sha256 от токена: даже с дампом базы на руках ссылку
 * не подделать. Живёт час — забытый пароль восстанавливают сразу, а не через
 * неделю, зато украденное письмо быстро становится бесполезным.
 */
export const passwordResetsTable = pgTable(
  "password_resets",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Проставляется при использовании: одна ссылка — один сброс. */
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUser: index("password_resets_user_idx").on(t.userId),
  }),
);

export type PasswordReset = typeof passwordResetsTable.$inferSelect;
