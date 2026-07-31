import { writeFile, rm } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import {
  db,
  documentsTable,
  lecturesTable,
  lectureSectionsTable,
  decksTable,
  deckSlidesTable,
} from "@workspace/db";
import { LIBRARY_DIR } from "./library-dir";
import { enqueue } from "./jobs";
import { logger } from "./logger";

/**
 * Готовая работа автора — тоже материал библиотеки.
 *
 * Лекция и презентация раньше были тупиком: их можно было скачать, но нельзя
 * было опереться на них в следующей работе — поиск про них не знал. Теперь
 * текст готовой лекции и текст готовой колоды ложатся в библиотеку и
 * индексируются, как книга. Отсюда «каждый документ гуляет из элемента в
 * элемент»: расшифровка → лекция → презентация → снова материал.
 *
 * Копия — не второй документ, а поисковый след своей работы: в списке
 * библиотеки её не показывают отдельной карточкой, она живёт на карточке
 * самой лекции или колоды и удаляется вместе с ней.
 */

/** Общая часть: положить текст в файл и завести/обновить документ. */
async function upsertWorkDoc(opts: {
  ownerId: number;
  title: string;
  kind: "lecture" | "deck";
  /** Чья это копия — по этой колонке стоит уникальный индекс. */
  link: { column: typeof documentsTable.lectureId | typeof documentsTable.deckId; id: number };
  values: { lectureId?: number; deckId?: number };
  folderId: number | null;
  fileName: string;
  text: string;
}): Promise<number | null> {
  const filePath = path.join(LIBRARY_DIR, opts.fileName);
  await mkdir(LIBRARY_DIR, { recursive: true });
  await writeFile(filePath, opts.text, "utf8");

  // Уникальный индекс превращает гонку двух синхронизаций в спокойное
  // «второй просто обновит».
  const inserted = await db
    .insert(documentsTable)
    .values({
      ownerId: opts.ownerId,
      title: opts.title,
      kind: opts.kind,
      ...opts.values,
      folderId: opts.folderId,
      sourcePath: filePath,
      mime: "text/plain",
      status: "parsing",
      statusMessage: "В очереди…",
    })
    .onConflictDoNothing()
    .returning({ id: documentsTable.id });

  let docId = inserted[0]?.id;
  if (docId === undefined) {
    const [existing] = await db
      .select({ id: documentsTable.id })
      .from(documentsTable)
      .where(eq(opts.link.column, opts.link.id))
      .limit(1);
    if (!existing) return null;
    docId = existing.id;
    await db
      .update(documentsTable)
      .set({
        title: opts.title,
        sourcePath: filePath,
        status: "parsing",
        statusMessage: "В очереди…",
        error: null,
      })
      .where(eq(documentsTable.id, docId));
  }

  await enqueue("doc.ingest", docId, {
    sourcePath: filePath,
    mime: "text/plain",
    filename: opts.fileName,
  });
  return docId;
}

/** Текст готовой лекции: заголовки глав и сам текст, по порядку. */
export async function lectureToLibrary(lectureId: number): Promise<number | null> {
  const [lecture] = await db
    .select()
    .from(lecturesTable)
    .where(eq(lecturesTable.id, lectureId))
    .limit(1);
  if (!lecture) return null;

  const sections = await db
    .select()
    .from(lectureSectionsTable)
    .where(eq(lectureSectionsTable.lectureId, lectureId))
    .orderBy(asc(lectureSectionsTable.ord));

  const parts = [`# ${lecture.title}`, ""];
  for (const s of sections) {
    if (s.text.trim() === "") continue;
    parts.push(`## ${s.heading}`, "", s.text.trim(), "");
  }
  const text = parts.join("\n").trim();
  // Пустая лекция в поиске только мешает: ни цитат, ни смысла.
  if (text.length < 200) return null;

  const docId = await upsertWorkDoc({
    ownerId: lecture.ownerId,
    title: lecture.title,
    kind: "lecture",
    link: { column: documentsTable.lectureId, id: lecture.id },
    values: { lectureId: lecture.id },
    folderId: lecture.folderId,
    fileName: `lecture-${lecture.id}.txt`,
    text,
  });
  if (docId) logger.info({ lectureId, docId }, "Лекция отправлена в библиотеку");
  return docId;
}

/** Текст готовой презентации: то, что на слайдах, плюс заметки докладчику. */
export async function deckToLibrary(deckId: number): Promise<number | null> {
  const [deck] = await db.select().from(decksTable).where(eq(decksTable.id, deckId)).limit(1);
  if (!deck) return null;

  const slides = await db
    .select()
    .from(deckSlidesTable)
    .where(eq(deckSlidesTable.deckId, deck.id))
    .orderBy(asc(deckSlidesTable.ord));
  if (slides.length === 0) return null;

  // Текст собираем читаемым: заголовки, тезисы и заметки докладчику — это и
  // есть содержание выступления, картинки в библиотеке не нужны.
  const parts: string[] = [`# ${deck.title}`, ""];
  for (const s of slides) {
    const c = s.content;
    if (c.title) parts.push(`## ${c.title}`);
    if (c.subtitle) parts.push(c.subtitle);
    if (c.quote) parts.push(`«${c.quote}»${c.attribution ? ` — ${c.attribution}` : ""}`);
    for (const b of c.bullets ?? []) parts.push(`— ${b}`);
    for (const card of c.cards ?? []) parts.push(`— ${card.title}: ${card.body}`);
    if (c.question) parts.push(`Вопрос: ${c.question}`);
    if (s.notes) parts.push(s.notes);
    parts.push("");
  }
  const text = parts.join("\n").trim();

  const docId = await upsertWorkDoc({
    ownerId: deck.ownerId,
    title: deck.title,
    kind: "deck",
    link: { column: documentsTable.deckId, id: deck.id },
    values: { deckId: deck.id },
    folderId: deck.folderId,
    fileName: `deck-${deck.id}.txt`,
    text,
  });
  if (docId) logger.info({ deckId, docId }, "Презентация отправлена в библиотеку");
  return docId;
}

/** Убрать копию работы из библиотеки — вместе с файлом и фрагментами. */
async function dropCopies(
  column: typeof documentsTable.lectureId | typeof documentsTable.deckId,
  id: number,
): Promise<void> {
  const docs = await db.select().from(documentsTable).where(eq(column, id));
  for (const doc of docs) {
    await db.delete(documentsTable).where(eq(documentsTable.id, doc.id));
    await rm(doc.sourcePath, { force: true }).catch(() => undefined);
  }
}

export const dropLectureCopies = (id: number) => dropCopies(documentsTable.lectureId, id);
export const dropDeckCopies = (id: number) => dropCopies(documentsTable.deckId, id);

/**
 * Стартовая сверка для работ, в обе стороны: готовое без копии — завести
 * (бэкфилл и самолечение после сбоев), копия без оригинала — удалить.
 */
export async function sweepWorkToLibrary(): Promise<number> {
  let synced = 0;

  const copies = await db
    .select({
      id: documentsTable.id,
      sourcePath: documentsTable.sourcePath,
      lectureId: documentsTable.lectureId,
      deckId: documentsTable.deckId,
    })
    .from(documentsTable);
  for (const copy of copies) {
    if (copy.lectureId === null && copy.deckId === null) continue;
    const alive =
      copy.lectureId !== null
        ? await db
            .select({ id: lecturesTable.id })
            .from(lecturesTable)
            .where(eq(lecturesTable.id, copy.lectureId))
            .limit(1)
        : await db
            .select({ id: decksTable.id })
            .from(decksTable)
            .where(eq(decksTable.id, copy.deckId!))
            .limit(1);
    if (alive.length > 0) continue;
    logger.warn({ docId: copy.id }, "Копия работы без оригинала — удаляю");
    await db.delete(documentsTable).where(eq(documentsTable.id, copy.id));
    await rm(copy.sourcePath, { force: true }).catch(() => undefined);
  }

  const readyLectures = await db
    .select({ id: lecturesTable.id })
    .from(lecturesTable)
    .where(eq(lecturesTable.status, "ready"));
  for (const l of readyLectures) {
    const [doc] = await db
      .select({ id: documentsTable.id })
      .from(documentsTable)
      .where(eq(documentsTable.lectureId, l.id))
      .limit(1);
    if (doc) continue;
    try {
      if (await lectureToLibrary(l.id)) synced += 1;
    } catch (err) {
      logger.error({ err, lectureId: l.id }, "Не смог отправить лекцию в библиотеку");
    }
  }

  const readyDecks = await db
    .select({ id: decksTable.id })
    .from(decksTable)
    .where(eq(decksTable.status, "ready"));
  for (const k of readyDecks) {
    const [doc] = await db
      .select({ id: documentsTable.id })
      .from(documentsTable)
      .where(eq(documentsTable.deckId, k.id))
      .limit(1);
    if (doc) continue;
    try {
      if (await deckToLibrary(k.id)) synced += 1;
    } catch (err) {
      logger.error({ err, deckId: k.id }, "Не смог отправить презентацию в библиотеку");
    }
  }

  return synced;
}
