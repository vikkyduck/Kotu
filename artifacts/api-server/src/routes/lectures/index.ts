import { Router, type IRouter } from "express";
import { eq, and, asc, desc, ne, inArray } from "drizzle-orm";
import {
  db,
  jobsTable,
  lecturesTable,
  lectureSectionsTable,
  lectureSourcesTable,
  documentsTable,
  LECTURE_FOCI,
  type Lecture,
  type LectureBrief,
  type LectureFocus,
  type PlannedSection,
} from "@workspace/db";
import { parseId } from "../../lib/parse-id";
import { attachmentHeader } from "../../lib/filename";
import { ownFolderId } from "../../lib/folders";
import { lectureToLibrary, dropLectureCopies } from "../../lib/work-doc";
import { buildLectureDocx, buildLectureMarkdown } from "../../lib/lecture-export";
import { titleFromTopic } from "../../lib/lecture-prompt";
import { isResearchAvailable } from "../../lib/perplexity";
import { deleteJobsArchivingInput, requireArchive } from "../../lib/archive";
import { LECTURE_PLANNING, PLAN_BUSY_MESSAGE, planEditBlocked } from "../../lib/busy-edit";

const router: IRouter = Router();

const NOT_FOUND = { message: "Лекция не найдена" };

/**
 * Лекция строго своего владельца — проверка в каждой ручке, как loadDeck.
 * Кривой id — как чужая лекция: null, и ручка отвечает 404.
 */
async function loadLecture(rawId: string, ownerId: number): Promise<Lecture | null> {
  const id = parseId(rawId);
  if (id === null) return null;
  const [lecture] = await db
    .select()
    .from(lecturesTable)
    .where(and(eq(lecturesTable.id, id), eq(lecturesTable.ownerId, ownerId)))
    .limit(1);
  return lecture ?? null;
}

/**
 * Метки скрытых имён ([[PER1]], [[LOC1]]) из копий расшифровок — для модели,
 * а не для глаз: в цитатах источников показываем, что за ними скрыто.
 */
function hideLabels(text: string): string {
  return text.replace(/\[\[PER\d+\]\]/g, "имя скрыто").replace(/\[\[LOC\d+\]\]/g, "место скрыто");
}

/** Лекция вместе с главами и источниками — фронту нужен цельный объект. */
async function loadFull(rawId: string, ownerId: number) {
  const lecture = await loadLecture(rawId, ownerId);
  if (!lecture) return null;

  const sections = await db
    .select()
    .from(lectureSectionsTable)
    .where(eq(lectureSectionsTable.lectureId, lecture.id))
    .orderBy(asc(lectureSectionsTable.ord));

  // Порядок вставки = номера ссылок [n] в тексте главы (handlers/lecture.ts).
  const sources = await db
    .select()
    .from(lectureSourcesTable)
    .where(eq(lectureSourcesTable.lectureId, lecture.id))
    .orderBy(asc(lectureSourcesTable.id));

  return {
    ...lecture,
    sections,
    sources: sources.map((s) => ({ ...s, quote: hideLabels(s.quote) })),
  };
}

router.get("/lectures", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(lecturesTable)
    .where(eq(lecturesTable.ownerId, req.user!.id))
    .orderBy(desc(lecturesTable.createdAt));
  res.json(rows);
});

router.get("/lectures/:id", async (req, res): Promise<void> => {
  const full = await loadFull(req.params.id, req.user!.id);
  if (!full) {
    res.status(404).json(NOT_FOUND);
    return;
  }
  res.json(full);
});

/**
 * Переименовать лекцию (в любом статусе) или переложить её в папку
 * библиотеки — она такой же житель, как книга. Копия текста в поиске
 * меняется вместе с ней, одной транзакцией: иначе они разъедутся.
 */
router.patch("/lectures/:id", async (req, res): Promise<void> => {
  const lecture = await loadLecture(req.params.id, req.user!.id);
  if (!lecture) {
    res.status(404).json(NOT_FOUND);
    return;
  }

  const body = req.body ?? {};
  const set: { title?: string; folderId?: number | null } = {};
  if ("title" in body) {
    // Длинное название обрезаем, а не отклоняем — как у книги и записи.
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
    if (title === "") {
      res.status(400).json({ message: "Дайте лекции название" });
      return;
    }
    set.title = title;
  }
  if ("folderId" in body) {
    const folderId = await ownFolderId(body.folderId, req.user!.id);
    if (folderId === undefined) {
      res.status(404).json({ message: "Папка не найдена" });
      return;
    }
    set.folderId = folderId;
  }
  if (Object.keys(set).length > 0) {
    // Копия текста переезжает и переименовывается вместе с лекцией:
    // материал живёт в одном месте.
    await db.transaction(async (tx) => {
      await tx.update(lecturesTable).set(set).where(eq(lecturesTable.id, lecture.id));
      await tx.update(documentsTable).set(set).where(eq(documentsTable.lectureId, lecture.id));
    });
  }
  res.json({ ok: true });
});

router.post("/lectures", async (req, res): Promise<void> => {
  const body = req.body ?? {};
  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  if (topic === "") {
    res.status(400).json({ message: "Расскажите в двух словах, о чём лекция" });
    return;
  }

  const durationMin = Number(body.durationMin);
  const documentIds = Array.isArray(body.documentIds)
    ? body.documentIds.map(Number).filter(Number.isInteger)
    : [];
  // Источники независимы: можно оба, можно один, можно ни одного (тогда
  // лекция пишется по знаниям модели с честными пометками). Единственное
  // противоречие — включённая библиотека без единого документа.
  const useLibrary = body.useLibrary === true;
  const useResearch = body.useResearch === true;
  if (useLibrary && documentIds.length === 0) {
    res.status(400).json({
      message: "Библиотека включена, но материал не выбран — отметьте документы или выключите её",
    });
    return;
  }
  // Без ключа веб-поиска лекция молча вышла бы без веб-источников.
  if (useResearch && !isResearchAvailable()) {
    res.status(409).json({ message: "Исследование ИИ не подключено — выключите его" });
    return;
  }
  const brief: LectureBrief = {
    topic,
    audience: typeof body.audience === "string" && body.audience ? body.audience : "смешанная",
    durationMin: Number.isFinite(durationMin) ? Math.min(480, Math.max(30, durationMin)) : 90,
    mustInclude: typeof body.mustInclude === "string" ? body.mustInclude : undefined,
    mustAvoid: typeof body.mustAvoid === "string" ? body.mustAvoid : undefined,
    documentIds,
    useLibrary,
    useResearch,
    // Акцентов может быть несколько — или ни одного.
    focus: Array.isArray(body.focus)
      ? body.focus.filter((f: unknown): f is LectureFocus =>
          (LECTURE_FOCI as readonly unknown[]).includes(f),
        )
      : [],
  };

  const title =
    typeof body.title === "string" && body.title.trim() !== ""
      ? body.title.trim()
      : titleFromTopic(topic);

  // Лекция и задача — одной транзакцией: «в работе» без задачи висела бы вечно.
  const lecture = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(lecturesTable)
      .values({
        ownerId: req.user!.id,
        title,
        brief,
        status: "planning",
        statusMessage: "В очереди…",
      })
      .returning();
    await tx.insert(jobsTable).values({ kind: "lecture.plan", entityId: row.id, payload: {} });
    return row;
  });
  res.status(201).json(lecture);
});

/** Правка плана до утверждения: автор может переписать, переставить, удалить. */
router.patch("/lectures/:id/plan", async (req, res): Promise<void> => {
  const lecture = await loadLecture(req.params.id, req.user!.id);
  if (!lecture) {
    res.status(404).json(NOT_FOUND);
    return;
  }
  if (lecture.planApproved) {
    res.status(409).json({ message: "План уже утверждён — правьте сами главы" });
    return;
  }
  // План, который сейчас пишет машина, не правим (lib/busy-edit.ts).
  if (planEditBlocked(lecture.status)) {
    res.status(409).json({ message: PLAN_BUSY_MESSAGE });
    return;
  }

  const incoming = Array.isArray(req.body?.plan) ? req.body.plan : null;
  if (!incoming) {
    res.status(400).json({ message: "Нужен план" });
    return;
  }

  // Опорные концепции и «крючок» переживают правку плана: автор убирает и
  // переставляет блоки, а замысел каждого блока остаётся при нём.
  const plan: PlannedSection[] = incoming
    .map((s: Record<string, unknown>) => ({
      heading: typeof s.heading === "string" ? s.heading.trim() : "",
      abstract: typeof s.abstract === "string" ? s.abstract : "",
      concepts: Array.isArray(s.concepts)
        ? s.concepts.filter((c: unknown): c is string => typeof c === "string")
        : [],
      hook: typeof s.hook === "string" ? s.hook : "",
    }))
    .filter((s: PlannedSection) => s.heading !== "");

  if (plan.length === 0) {
    res.status(400).json({ message: "В плане не осталось ни одной главы" });
    return;
  }

  // Условие статуса — и в самом UPDATE: машина могла взяться за план между
  // проверкой выше и этой записью (повтор задачи lecture.plan снова ставит planning).
  const saved = await db
    .update(lecturesTable)
    .set({ plan })
    .where(and(eq(lecturesTable.id, lecture.id), ne(lecturesTable.status, LECTURE_PLANNING)))
    .returning({ id: lecturesTable.id });
  if (saved.length === 0) {
    res.status(409).json({ message: PLAN_BUSY_MESSAGE });
    return;
  }
  res.json({ ok: true, plan });
});

/** Точка, где автор остаётся автором: после утверждения начинается письмо. */
router.post("/lectures/:id/plan/approve", async (req, res): Promise<void> => {
  const lecture = await loadLecture(req.params.id, req.user!.id);
  if (!lecture) {
    res.status(404).json(NOT_FOUND);
    return;
  }
  const id = lecture.id;
  if ((lecture.plan ?? []).length === 0) {
    res.status(409).json({ message: "План пуст" });
    return;
  }

  // Смена статуса, главы и задача — одной транзакцией, с условием на
  // plan_ready в самом UPDATE: две вкладки или повтор запроса иначе
  // вставили бы главы дважды и поставили два платных письма.
  const queued = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(lecturesTable)
      .set({ planApproved: true, status: "writing", statusMessage: "В очереди…", error: null })
      .where(and(eq(lecturesTable.id, id), eq(lecturesTable.status, "plan_ready")))
      .returning({ plan: lecturesTable.plan });
    if (!updated) return false;

    // Главы создаём один раз: при повторном утверждении не плодим дубли.
    const existing = await tx
      .select({ id: lectureSectionsTable.id })
      .from(lectureSectionsTable)
      .where(eq(lectureSectionsTable.lectureId, id));
    if (existing.length === 0) {
      await tx.insert(lectureSectionsTable).values(
        (updated.plan ?? []).map((s, i) => ({
          lectureId: id,
          ord: i,
          heading: s.heading,
          abstract: s.abstract,
        })),
      );
    }
    await tx.insert(jobsTable).values({ kind: "lecture.write", entityId: id, payload: {} });
    return true;
  });
  if (!queued) {
    res.status(409).json({ message: "Главы уже пишутся" });
    return;
  }
  res.status(202).json({ ok: true });
});

/**
 * Повтор после ошибки. План не утверждён — составляем его заново, утверждён —
 * дописываем главы: готовые и правленные автором письмо пропускает само.
 * Бриф хранится в лекции, поэтому задаче ничего передавать не нужно.
 */
router.post("/lectures/:id/retry", async (req, res): Promise<void> => {
  const lecture = await loadLecture(req.params.id, req.user!.id);
  if (!lecture) {
    res.status(404).json(NOT_FOUND);
    return;
  }
  if (lecture.status !== "error") {
    res.status(409).json({ message: "Повторять нечего — ошибки нет" });
    return;
  }

  // Лекция в ошибке, а задача ещё в очереди или в работе (сбой между концом
  // задачи и onGiveUp) — вторая задача писала бы те же главы параллельно.
  const [running] = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(
      and(
        inArray(jobsTable.kind, ["lecture.plan", "lecture.write"]),
        eq(jobsTable.entityId, lecture.id),
        inArray(jobsTable.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  if (running) {
    res.status(409).json({ message: "Лекция уже в работе" });
    return;
  }

  // Смена статуса и задача — в одной транзакции: лекция «в работе» без задачи
  // висела бы вечно. Условие status = 'error' в UPDATE закрывает двойной клик.
  const kind = lecture.planApproved ? "lecture.write" : "lecture.plan";
  const queued = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(lecturesTable)
      .set({
        status: lecture.planApproved ? "writing" : "planning",
        statusMessage: "В очереди…",
        error: null,
      })
      .where(and(eq(lecturesTable.id, lecture.id), eq(lecturesTable.status, "error")))
      .returning({ id: lecturesTable.id });
    if (!updated) return false;
    await tx.insert(jobsTable).values({ kind, entityId: lecture.id, payload: {} });
    return true;
  });
  if (!queued) {
    res.status(409).json({ message: "Повторять нечего — ошибки нет" });
    return;
  }
  res.status(202).json({ ok: true });
});

/** Правка главы автором. С этого момента глава считается его, а не машины. */
router.patch("/lectures/:id/sections/:sectionId", async (req, res): Promise<void> => {
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  // Пустая глава пропала бы с экрана вместе с кнопкой «Править», а машина
  // правленную главу не переписывает — вернуть её было бы нечем.
  if (text.trim() === "") {
    res.status(400).json({ message: "Нужен текст" });
    return;
  }

  const lecture = await loadLecture(req.params.id, req.user!.id);
  if (!lecture) {
    res.status(404).json(NOT_FOUND);
    return;
  }
  const sectionId = parseId(req.params.sectionId);
  const saved =
    sectionId === null
      ? []
      : await db
          .update(lectureSectionsTable)
          .set({ text, editedByHuman: true, status: "ready" })
          .where(
            and(
              eq(lectureSectionsTable.id, sectionId),
              eq(lectureSectionsTable.lectureId, lecture.id),
            ),
          )
          .returning({ id: lectureSectionsTable.id });
  if (saved.length === 0) {
    res.status(404).json({ message: "Глава не найдена" });
    return;
  }

  // Правка главы должна доехать до поиска: иначе следующая лекция будет
  // опираться на текст, которого автор уже не признаёт.
  if (lecture.status === "ready") {
    await lectureToLibrary(lecture.id).catch((err) =>
      req.log.error({ err, id: lecture.id }, "Не смог обновить копию лекции в библиотеке"),
    );
  }

  res.json({ ok: true });
});

router.delete("/lectures/:id", async (req, res): Promise<void> => {
  const lecture = await loadLecture(req.params.id, req.user!.id);
  if (!lecture) {
    res.status(404).json(NOT_FOUND);
    return;
  }
  // Лекция, главы и источники уходят в архив триггерами (каскад по FK тоже),
  // файл копии — archiveAndRemove. Без архива не удаляем ничего.
  await requireArchive();
  // Задачи снимаем первыми: иначе они остаются в очереди, падают на
  // «лекция не найдена», уходят в повтор и держат единственный воркер —
  // соседние работы ждут на пустом месте. Их payload — в архив тем же
  // оператором: там может быть то, что владелица вводила руками.
  await db.execute(deleteJobsArchivingInput("lecture.%", "lectures", lecture.id));

  // Текст лекции в поиске — часть самой лекции, а не отдельный документ:
  // уходит вместе с ней, иначе в библиотеке остался бы призрак.
  await dropLectureCopies(lecture.id);
  await db.delete(lecturesTable).where(eq(lecturesTable.id, lecture.id));
  res.sendStatus(204);
});

/** Выгрузка в Markdown: текст глав со списком источников под каждой. */
router.get("/lectures/:id/export", async (req, res): Promise<void> => {
  const full = await loadFull(req.params.id, req.user!.id);
  if (!full) {
    res.status(404).json(NOT_FOUND);
    return;
  }

  // Word — для кафедр и оргкомитетов; он же открывается Google Документами
  // после загрузки на Диск. Markdown — для всех остальных случаев.
  if (req.query.format === "docx") {
    const buffer = await buildLectureDocx(full);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    res.setHeader("Content-Disposition", attachmentHeader(full.title, "docx", "лекция"));
    res.send(buffer);
    return;
  }

  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.setHeader("Content-Disposition", attachmentHeader(full.title, "md", "лекция"));
  res.send(buildLectureMarkdown(full));
});

export default router;
