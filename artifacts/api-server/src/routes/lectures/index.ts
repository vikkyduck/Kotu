import { Router, type IRouter } from "express";
import { eq, and, asc, desc, sql } from "drizzle-orm";
import {
  db,
  lecturesTable,
  lectureSectionsTable,
  lectureSourcesTable,
  documentsTable,
  jobsTable,
  type LectureBrief,
  type PlannedSection,
} from "@workspace/db";
import { enqueue } from "../../lib/jobs";
import { ownFolderId } from "../../lib/folders";
import { lectureToLibrary, dropLectureCopies } from "../../lib/work-doc";

const router: IRouter = Router();

/** Лекция вместе с главами и источниками — фронту нужен цельный объект. */
async function loadFull(id: number, ownerId: number) {
  const [lecture] = await db
    .select()
    .from(lecturesTable)
    .where(and(eq(lecturesTable.id, id), eq(lecturesTable.ownerId, ownerId)))
    .limit(1);
  if (!lecture) return null;

  const sections = await db
    .select()
    .from(lectureSectionsTable)
    .where(eq(lectureSectionsTable.lectureId, id))
    .orderBy(asc(lectureSectionsTable.ord));

  const sources = await db
    .select()
    .from(lectureSourcesTable)
    .where(eq(lectureSourcesTable.lectureId, id));

  return { ...lecture, sections, sources };
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
  const full = await loadFull(Number(req.params.id), req.user!.id);
  if (!full) {
    res.status(404).json({ message: "Лекция не найдена" });
    return;
  }
  res.json(full);
});

/** Переложить лекцию в папку библиотеки — она такой же житель, как книга. */
router.patch("/lectures/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [lecture] = Number.isInteger(id)
    ? await db
        .select({ id: lecturesTable.id })
        .from(lecturesTable)
        .where(and(eq(lecturesTable.id, id), eq(lecturesTable.ownerId, req.user!.id)))
        .limit(1)
    : [];
  if (!lecture) {
    res.status(404).json({ message: "Лекция не найдена" });
    return;
  }

  const body = req.body ?? {};
  if ("folderId" in body) {
    const folderId = await ownFolderId(body.folderId, req.user!.id);
    if (folderId === undefined) {
      res.status(404).json({ message: "Папка не найдена" });
      return;
    }
    // Копия текста переезжает вместе с лекцией: материал живёт в одном месте.
    await db.update(lecturesTable).set({ folderId }).where(eq(lecturesTable.id, lecture.id));
    await db
      .update(documentsTable)
      .set({ folderId })
      .where(eq(documentsTable.lectureId, lecture.id));
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
  // Исследование — единственный режим, где пустая опора допустима: материал
  // собирает модель. Обычной лекции без документов не бывает.
  const mode: LectureBrief["mode"] = body.mode === "research" ? "research" : "library";
  if (mode === "library" && documentIds.length === 0) {
    res.status(400).json({
      message: "Выберите материал из библиотеки — или включите «Исследование ИИ»",
    });
    return;
  }
  const brief: LectureBrief = {
    topic,
    audience: typeof body.audience === "string" && body.audience ? body.audience : "смешанная",
    durationMin: Number.isFinite(durationMin) ? Math.min(480, Math.max(30, durationMin)) : 90,
    mustInclude: typeof body.mustInclude === "string" ? body.mustInclude : undefined,
    mustAvoid: typeof body.mustAvoid === "string" ? body.mustAvoid : undefined,
    documentIds,
    mode,
    focus:
      body.focus === "clinical" || body.focus === "historical" || body.focus === "theoretical"
        ? body.focus
        : "theoretical",
  };

  const title =
    typeof body.title === "string" && body.title.trim() !== ""
      ? body.title.trim()
      : topic.slice(0, 70);

  const [lecture] = await db
    .insert(lecturesTable)
    .values({
      ownerId: req.user!.id,
      title,
      brief,
      status: "planning",
      statusMessage: "В очереди…",
    })
    .returning();

  await enqueue("lecture.plan", lecture.id, {});
  res.status(201).json(lecture);
});

/** Правка плана до утверждения: автор может переписать, переставить, удалить. */
router.patch("/lectures/:id/plan", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [lecture] = await db
    .select()
    .from(lecturesTable)
    .where(and(eq(lecturesTable.id, id), eq(lecturesTable.ownerId, req.user!.id)))
    .limit(1);

  if (!lecture) {
    res.status(404).json({ message: "Лекция не найдена" });
    return;
  }
  if (lecture.planApproved) {
    res.status(409).json({ message: "План уже утверждён — правьте сами главы" });
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

  await db.update(lecturesTable).set({ plan }).where(eq(lecturesTable.id, id));
  res.json({ ok: true, plan });
});

/** Точка, где автор остаётся автором: после утверждения начинается письмо. */
router.post("/lectures/:id/plan/approve", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [lecture] = await db
    .select()
    .from(lecturesTable)
    .where(and(eq(lecturesTable.id, id), eq(lecturesTable.ownerId, req.user!.id)))
    .limit(1);

  if (!lecture) {
    res.status(404).json({ message: "Лекция не найдена" });
    return;
  }
  const plan = lecture.plan ?? [];
  if (plan.length === 0) {
    res.status(409).json({ message: "План пуст" });
    return;
  }
  if (lecture.status === "writing") {
    res.status(409).json({ message: "Главы уже пишутся" });
    return;
  }

  // Главы создаём один раз: при повторном утверждении не плодим дубли.
  const existing = await db
    .select({ id: lectureSectionsTable.id })
    .from(lectureSectionsTable)
    .where(eq(lectureSectionsTable.lectureId, id));

  if (existing.length === 0) {
    await db.insert(lectureSectionsTable).values(
      plan.map((s, i) => ({
        lectureId: id,
        ord: i,
        heading: s.heading,
        abstract: s.abstract,
      })),
    );
  }

  await db
    .update(lecturesTable)
    .set({ planApproved: true, status: "writing", statusMessage: "В очереди…" })
    .where(eq(lecturesTable.id, id));

  await enqueue("lecture.write", id, {});
  res.status(202).json({ ok: true });
});

/** Правка главы автором. С этого момента глава считается его, а не машины. */
router.patch("/lectures/:id/sections/:sectionId", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const sectionId = Number(req.params.sectionId);
  const text = typeof req.body?.text === "string" ? req.body.text : null;

  if (text === null) {
    res.status(400).json({ message: "Нужен текст" });
    return;
  }

  const [lecture] = await db
    .select()
    .from(lecturesTable)
    .where(and(eq(lecturesTable.id, id), eq(lecturesTable.ownerId, req.user!.id)))
    .limit(1);
  if (!lecture) {
    res.status(404).json({ message: "Лекция не найдена" });
    return;
  }

  await db
    .update(lectureSectionsTable)
    .set({ text, editedByHuman: true, status: "ready" })
    .where(
      and(eq(lectureSectionsTable.id, sectionId), eq(lectureSectionsTable.lectureId, id)),
    );

  // Правка главы должна доехать до поиска: иначе следующая лекция будет
  // опираться на текст, которого автор уже не признаёт.
  if (lecture.status === "ready") await lectureToLibrary(lecture.id).catch(() => undefined);

  res.json({ ok: true });
});

router.delete("/lectures/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [lecture] = await db
    .select()
    .from(lecturesTable)
    .where(and(eq(lecturesTable.id, id), eq(lecturesTable.ownerId, req.user!.id)))
    .limit(1);
  if (!lecture) {
    res.status(404).json({ message: "Лекция не найдена" });
    return;
  }
  // Задачи снимаем первыми: иначе они остаются в очереди, падают на
  // «лекция не найдена», уходят в повтор и держат единственный воркер —
  // соседние работы ждут на пустом месте.
  await db
    .delete(jobsTable)
    .where(and(sql`${jobsTable.kind} LIKE 'lecture.%'`, eq(jobsTable.entityId, lecture.id)));

  // Текст лекции в поиске — часть самой лекции, а не отдельный документ:
  // уходит вместе с ней, иначе в библиотеке остался бы призрак.
  await dropLectureCopies(lecture.id);
  await db.delete(lecturesTable).where(eq(lecturesTable.id, id));
  res.sendStatus(204);
});

/** Выгрузка в Markdown: текст глав со списком источников под каждой. */
router.get("/lectures/:id/export", async (req, res): Promise<void> => {
  const full = await loadFull(Number(req.params.id), req.user!.id);
  if (!full) {
    res.status(404).json({ message: "Лекция не найдена" });
    return;
  }

  const parts: string[] = [`# ${full.title}`, ""];
  for (const section of full.sections) {
    parts.push(`## ${section.heading}`, "", section.text || "_глава ещё не написана_", "");
    const used = full.sources.filter((s) => s.sectionId === section.id);
    if (used.length > 0) {
      parts.push("**Источники:**", "");
      used.forEach((s, i) => parts.push(`${i + 1}. ${s.title}`));
      parts.push("");
    }
  }

  const bib = full.bibliography;
  if (bib && (bib.primary.length > 0 || bib.modern.length > 0)) {
    parts.push("## Литература", "");
    if (bib.primary.length > 0) {
      parts.push("**Первоисточники**", "");
      bib.primary.forEach((b, i) => parts.push(`${i + 1}. ${b}`));
      parts.push("");
    }
    if (bib.modern.length > 0) {
      parts.push("**Современные работы для углубления**", "");
      bib.modern.forEach((b, i) => parts.push(`${i + 1}. ${b}`));
      parts.push("");
    }
  }

  const filename = `${full.title.replace(/[^\p{L}\p{N} .-]/gu, "").slice(0, 60) || "лекция"}.md`;
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  res.send(parts.join("\n"));
});

export default router;
