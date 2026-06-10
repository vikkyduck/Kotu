import { pgTable, serial, text, boolean, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type TranscriptSegment = {
  who: string;
  text: string;
};

export const transcriptionsTable = pgTable("transcriptions", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  filename: text("filename").notNull(),
  hideNames: boolean("hide_names").notNull().default(false),
  markSpeakers: boolean("mark_speakers").notNull().default(false),
  segments: jsonb("segments").$type<TranscriptSegment[]>().notNull().default([]),
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
