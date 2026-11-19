import { Router, type IRouter } from "express";
import { eq, and, asc, desc, ne } from "drizzle-orm";
import {
  db,
  lecturesTable,
  lectureSectionsTable,
  lectureSourcesTable,
  documentsTable,
  LECTURE_FOCI,
  type LectureBrief,
  type LectureFocus,
} from "@workspace/db";
import { parseId } from "../../lib/parse-id";
import { ownedOr404, ownedRow } from "../../lib/owned";
import { hideLabels } from "../../lib/name-labels";
import { NOTHING_TO_RETRY, QUEUED_MESSAGE, enqueue, hasActiveJob, transitionAndEnqueue } from "../../lib/jobs";
import { attachmentHeader } from "../../lib/filename";
import { parseRenameMove } from "../../lib/folders";
import { lectureToLibrary, dropLectureCopies, syncQuietly } from "../../lib/work-doc";
import { buildLectureDocx, buildLectureMarkdown } from "../../lib/lecture-export";
import { planSections, titleFromTopic } from "../../lib/lecture-prompt";
import { titleFrom } from "../../lib/title";
import { madeFrom, materialsByIds } from "../../lib/relations";
import { deleteJobsArchivingInput, requireArchive } from "../../lib/archive";
import { LECTURE_PLANNING, PLAN_BUSY_MESSAGE, planEditBlocked } from "../../lib/busy-edit";

const router: IRouter = Router();

const NOT_FOUND = "Лекция не найдена";

/** Лекция вместе с главами и источниками — фронту нужен цельный объект. */
async function loadFull(rawId: string, ownerId: number) {
  const lecture = await ownedRow(lecturesTable, rawId, ownerId);
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

  // Связи для экрана: на чём лекция стоит и какие презентации из неё уже собраны.
  const materials = await materialsByIds(ownerId, lecture.brief.documentIds ?? []);
  const { decks } = await madeFrom(ownerId, { lectureId: lecture.id });

  return {
    ...lecture,
    sections,
    sources: sources.map((s) => ({ ...s, quote: hideLabels(s.quote) })),
    materials,
    decks,
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
    res.status(404).json({ message: NOT_FOUND });
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
  const lecture = await ownedOr404(lecturesTable, req, res, NOT_FOUND);
  if (!lecture) return;

  const parsed = await parseRenameMove(req.body ?? {}, req.user!.id, "Дайте лекции название");
  if ("status" in parsed) {
    res.status(parsed.status).json({ message: parsed.message });
    return;
  }
  const { set } = parsed;
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
  const brief: LectureBrief = {
    topic,
    // Аудитория необязательна: пусто - модель сама выбирает уровень изложения.
    audience: typeof body.audience === "string" ? body.audience.trim().slice(0, 200) : "",
    // От получаса до четырёх часов (до 16 глав, handlers/lecture.ts); не задано - полтора часа.
    durationMin: Number.isFinite(durationMin) && durationMin > 0 ? Math.min(240, Math.max(30, Math.round(durationMin))) : 90,
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

  const title = titleFrom(body.title) || titleFromTopic(topic);

  // Лекция и задача — одной транзакцией: «в работе» без задачи висела бы вечно.
  const lecture = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(lecturesTable)
      .values({
        ownerId: req.user!.id,
        title,
        brief,
        status: "planning",
        statusMessage: QUEUED_MESSAGE,
      })
      .returning();
    await enqueue("lecture.plan", row.id, {}, tx);
    return row;
  });
  res.status(201).json(lecture);
});

/** Правка плана до утверждения: автор может переписать, переставить, удалить. */
router.patch("/lectures/:id/plan", async (req, res): Promise<void> => {
  const lecture = await ownedOr404(lecturesTable, req, res, NOT_FOUND);
  if (!lecture) return;
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
  const plan = planSections(incoming);

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
  const lecture = await ownedOr404(lecturesTable, req, res, NOT_FOUND);
  if (!lecture) return;
  const id = lecture.id;
  if ((lecture.plan ?? []).length === 0) {
    res.status(409).json({ message: "План пуст" });
    return;
  }

  // Смена статуса, главы и задача — одной транзакцией, с условием на
  // plan_ready в самом UPDATE: две вкладки или повтор запроса иначе
  // вставили бы главы дважды и поставили два платных письма.
  const queued = await transitionAndEnqueue({
    table: lecturesTable,
    id,
    from: ["plan_ready"],
    set: { planApproved: true, status: "writing", statusMessage: QUEUED_MESSAGE },
    kind: "lecture.write",
    // Главы создаём один раз: при повторном утверждении не плодим дубли.
    before: async (tx, updated) => {
      const existing = await tx
        .select({ id: lectureSectionsTable.id })
        .from(lectureSectionsTable)
        .where(eq(lectureSectionsTable.lectureId, id));
      if (existing.length > 0) return;
      await tx.insert(lectureSectionsTable).values(
        (updated.plan ?? []).map((s, i) => ({ lectureId: id, ord: i, heading: s.heading, abstract: s.abstract })),
      );
    },
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
  const lecture = await ownedOr404(lecturesTable, req, res, NOT_FOUND);
  if (!lecture) return;
  if (lecture.status !== "error") {
    res.status(409).json({ message: NOTHING_TO_RETRY });
    return;
  }

  // Лекция в ошибке, а задача ещё в очереди или в работе (сбой между концом
  // задачи и onGiveUp) — вторая задача писала бы те же главы параллельно.
  if (await hasActiveJob(["lecture.plan", "lecture.write"], lecture.id)) {
    res.status(409).json({ message: "Лекция уже в работе" });
    return;
  }

  const queued = await transitionAndEnqueue({
    table: lecturesTable,
    id: lecture.id,
    from: ["error"],
    set: { status: lecture.planApproved ? "writing" : "planning", statusMessage: QUEUED_MESSAGE },
    kind: lecture.planApproved ? "lecture.write" : "lecture.plan",
  });
  if (!queued) {
    res.status(409).json({ message: NOTHING_TO_RETRY });
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

  const lecture = await ownedOr404(lecturesTable, req, res, NOT_FOUND);
  if (!lecture) return;
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
    await syncQuietly(lectureToLibrary(lecture.id), "lecture", lecture.id, req.log);
  }

  res.json({ ok: true });
});

router.delete("/lectures/:id", async (req, res): Promise<void> => {
  const lecture = await ownedOr404(lecturesTable, req, res, NOT_FOUND);
  if (!lecture) return;
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
    res.status(404).json({ message: NOT_FOUND });
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
