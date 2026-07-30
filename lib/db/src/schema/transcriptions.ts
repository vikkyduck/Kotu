import { pgTable, serial, text, boolean, jsonb, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type TranscriptSegment = {
  who: string;
  text: string;
};

export type TranscriptionStatus = "processing" | "done" | "error";

export const transcriptionsTable = pgTable("transcriptions", {
  id: serial("id").primaryKey(),
  /**
   * Владелец записи. Расшифровка сеанса — данные о здоровье: каждый запрос
   * обязан ограничиваться своими записями, иначе любой вошедший видит чужие.
   */
  ownerId: integer("owner_id").notNull(),
  title: text("title").notNull(),
  filename: text("filename").notNull(),
  hideNames: boolean("hide_names").notNull().default(false),
  markSpeakers: boolean("mark_speakers").notNull().default(false),
  segments: jsonb("segments").$type<TranscriptSegment[]>().notNull().default([]),
  status: text("status").$type<TranscriptionStatus>().notNull().default("done"),
  progress: integer("progress").notNull().default(100),
  statusMessage: text("status_message").notNull().default(""),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertTranscriptionSchema = createInsertSchema(transcriptionsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertTranscription = z.infer<typeof insertTranscriptionSchema>;
export type Transcription = typeof transcriptionsTable.$inferSelect;
