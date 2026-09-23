import path from "node:path";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import {
  db,
  documentsTable,
  lecturesTable,
  lectureSectionsTable,
  decksTable,
  deckSlidesTable,
  deckImagesTable,
  jobsTable,
} from "@workspace/db";
import { LIBRARY_DIR } from "./paths";
import { archiveAndRemove, writeDataFile } from "./archive";
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
 * самой лекции или колоды и удаляется вместе с ней. Замена и удаление копии
 * допустимы только потому, что прежняя строка уходит в архив триггером, а
 * прежний файл — в архив файлов до rm (lib/archive.ts).
 */

/** Меньше этого в поиске только мешает: ни цитат, ни смысла. */
export const MIN_LIBRARY_TEXT = 200;

/** Колонка-ссылка копии на свою работу — по ней стоит уникальный индекс. */
type LinkColumn =
  | typeof documentsTable.lectureId
  | typeof documentsTable.deckId
  | typeof documentsTable.transcriptionId;

/**
 * Общая часть для лекции, колоды и расшифровки: положить текст в файл и
 * завести/обновить документ. Текста мало — прежняя копия уходит в архив.
 */
export async function upsertWorkDoc(opts: {
  ownerId: number;
  title: string;
  kind: "lecture" | "deck" | "transcript";
  link: { column: LinkColumn; id: number };
  values: { lectureId?: number; deckId?: number; transcriptionId?: number };
  folderId: number | null;
  fileName: string;
  text: string;
}): Promise<number | null> {
  if (opts.text.length < MIN_LIBRARY_TEXT) {
    await dropCopies(opts.link.column, opts.link.id);
    return null;
  }

  const filePath = path.join(LIBRARY_DIR, opts.fileName);
  // Прежний текст копии — в архив, новый пишется атомарно.
  await writeDataFile(filePath, opts.text, {
    entityType: opts.kind === "transcript" ? "transcription" : opts.kind,
    entityId: opts.link.id,
    mime: "text/plain",
  });

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

  // Правки идут сериями (каждое исправленное слово — сохранение). Разбор,
  // который уже ждёт в очереди, и так прочтёт свежий файл — второй не нужен.
  const [waiting] = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.kind, "doc.ingest"),
        eq(jobsTable.entityId, docId),
        eq(jobsTable.status, "queued"),
      ),
    )
    .limit(1);
  if (!waiting) {
    await enqueue("doc.ingest", docId, {
      sourcePath: filePath,
      mime: "text/plain",
      filename: opts.fileName,
    });
  }
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

/**
 * Убрать копию работы из библиотеки — вместе с файлом и фрагментами. Файл
 * сначала в архив: не заархивировался — исключение, ничего не удалено.
 * Строка документа уходит в архив триггером, фрагменты — каскадом по FK.
 */
export async function dropCopies(column: LinkColumn, id: number, ownerId?: number): Promise<void> {
  const docs = await db
    .select()
    .from(documentsTable)
    .where(
      and(eq(column, id), ownerId === undefined ? undefined : eq(documentsTable.ownerId, ownerId)),
    );
  for (const doc of docs) {
    await archiveAndRemove(doc.sourcePath, {
      entityType: "document",
      entityId: doc.id,
      mime: doc.mime,
    });
    await db.delete(documentsTable).where(eq(documentsTable.id, doc.id));
  }
}

export const dropLectureCopies = (id: number) => dropCopies(documentsTable.lectureId, id);
export const dropDeckCopies = (id: number) => dropCopies(documentsTable.deckId, id);

/**
 * Попытки образа, брошенные посреди рисования: перезапуск (деплой) убивает
 * процесс до того, как illustrateSlide успевает поймать ошибку — запись
 * остаётся в status="drawing" навсегда, а следующий прогон нумерует попытки
 * заново с 1, потому что счётчик локален для функции. Сверка на старте
 * закрывает и то и другое: старая запись помечается ошибкой, а не висит
 * незакрытым делом.
 */
export async function sweepStuckDeckImages(): Promise<number> {
  const stuck = await db
    .update(deckImagesTable)
    .set({ status: "error", error: "Прервано перезапуском сервера" })
    .where(eq(deckImagesTable.status, "drawing"))
    .returning({ id: deckImagesTable.id });

  if (stuck.length > 0) logger.info({ count: stuck.length }, "Закрыл образы, брошенные посреди рисования");
  return stuck.length;
}

/**
 * Стартовая сверка для работ, в обе стороны: готовое без копии — завести
 * (бэкфилл и самолечение после сбоев), копия без оригинала — убрать (строка
 * и файл остаются в архиве).
 */
export async function sweepWorkToLibrary(): Promise<number> {
  let synced = 0;

  const copies = await db
    .select({
      id: documentsTable.id,
      sourcePath: documentsTable.sourcePath,
      mime: documentsTable.mime,
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
    logger.warn({ docId: copy.id }, "Копия работы без оригинала — убираю в архив");
    try {
      await archiveAndRemove(copy.sourcePath, {
        entityType: "document",
        entityId: copy.id,
        mime: copy.mime,
      });
    } catch (err) {
      logger.error({ err, docId: copy.id }, "Копия не заархивировалась — оставил как есть");
      continue;
    }
    await db.delete(documentsTable).where(eq(documentsTable.id, copy.id));
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
