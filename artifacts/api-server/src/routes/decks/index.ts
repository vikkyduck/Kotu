import path from "node:path";
import { existsSync } from "node:fs";
import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, or, asc, desc, isNotNull, isNull } from "drizzle-orm";
import {
  db,
  decksTable,
  deckSlidesTable,
  deckImagesTable,
  stylePacksTable,
  lecturesTable,
  documentsTable,
  jobsTable,
  type Deck,
  type DeckSlide,
  type SlideLayout,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import { SLIDE_LAYOUTS, layoutHasImage } from "@workspace/db/slides";
import { enqueue } from "../../lib/jobs";
import { ownFolderId } from "../../lib/folders";
import { deckToLibrary, dropDeckCopies } from "../../lib/work-doc";
import { DECKS_DIR } from "../../lib/paths";
import { buildDeckPptx } from "../../lib/pptx";
import { buildDeckPdf } from "../../lib/pdf";
import { sanitizeSlideContent } from "../../lib/slide-content";
import { deckStylePack } from "../../lib/deck-style";
import { parseId } from "../../lib/parse-id";
import { attachmentHeader } from "../../lib/filename";
import {
  archiveInputSql,
  archiveTreeAndRemove,
  deleteJobsArchivingInput,
  requireArchive,
} from "../../lib/archive";

const router: IRouter = Router();

/**
 * Колода строго своего владельца — проверка в каждой ручке, как везде.
 * Чужая, удалённая или кривой id — одинаковые 404; ответ уже отправлен,
 * ручке остаётся выйти.
 */
async function deckOr404(req: Request, res: Response): Promise<Deck | null> {
  const id = parseId(req.params["id"]);
  const [deck] = id
    ? await db
        .select()
        .from(decksTable)
        .where(and(eq(decksTable.id, id), eq(decksTable.ownerId, req.user!.id)))
        .limit(1)
    : [];
  if (!deck) {
    res.status(404).json({ message: "Презентация не найдена" });
    return null;
  }
  return deck;
}

/** Слайд этой колоды по :sid из адреса; нет такого — 404, как с колодой. */
async function slideOr404(deck: Deck, req: Request, res: Response): Promise<DeckSlide | null> {
  const sid = parseId(req.params["sid"]);
  const [slide] = sid
    ? await db
        .select()
        .from(deckSlidesTable)
        .where(and(eq(deckSlidesTable.id, sid), eq(deckSlidesTable.deckId, deck.id)))
        .limit(1)
    : [];
  if (!slide) {
    res.status(404).json({ message: "Слайд не найден" });
    return null;
  }
  return slide;
}

/** В ошибке колода стоит — не «работает»: сказать, что делать. */
const RETRY_FIRST = "Сначала нажмите «Попробовать ещё раз»";

/** Копия в библиотеке отстала от правки — ответ всё равно ok, но след в журнале. */
function logLibraryLag(req: Request, id: number) {
  return (err: unknown) => req.log.error({ err, id }, "Не смог обновить копию презентации в библиотеке");
}

/**
 * Пакеты, из которых пользователь выбирает стиль серии: общие (без владельца)
 * и его собственные. Только id и имя — палитра и промпты фронту не нужны.
 */
function availablePacksQuery(userId: number) {
  return db
    .select({ id: stylePacksTable.id, name: stylePacksTable.name })
    .from(stylePacksTable)
    .where(or(isNull(stylePacksTable.ownerId), eq(stylePacksTable.ownerId, userId)))
    .orderBy(asc(stylePacksTable.id));
}

router.get("/style-packs", async (req, res): Promise<void> => {
  res.json(await availablePacksQuery(req.user!.id));
});

router.get("/decks", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(decksTable)
    .where(eq(decksTable.ownerId, req.user!.id))
    .orderBy(desc(decksTable.createdAt));
  res.json(rows);
});

router.get("/decks/:id", async (req, res): Promise<void> => {
  const deck = await deckOr404(req, res);
  if (!deck) return;

  const slides = await db
    .select()
    .from(deckSlidesTable)
    .where(eq(deckSlidesTable.deckId, deck.id))
    .orderBy(asc(deckSlidesTable.ord));

  const images = await db
    .select()
    .from(deckImagesTable)
    .where(eq(deckImagesTable.deckId, deck.id));

  // Палитра нужна фронту, чтобы показать слайд крупно в цветах серии, а не
  // «примерно похоже». Отдаём только цвета: промпты стиля — не дело браузера.
  const pack = await deckStylePack(deck.stylePackId);

  res.json({ ...deck, slides, images, palette: pack?.palette ?? null });
});

router.post("/decks", async (req, res): Promise<void> => {
  const body = req.body ?? {};
  const kind = body.sourceKind;
  let title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
  let sourceId: number | null = null;
  let rawText: string | null = null;

  if (kind === "lecture") {
    sourceId = Number(body.sourceId);
    const [lecture] = Number.isInteger(sourceId)
      ? await db
          .select()
          .from(lecturesTable)
          .where(and(eq(lecturesTable.id, sourceId), eq(lecturesTable.ownerId, req.user!.id)))
          .limit(1)
      : [];
    if (!lecture) {
      res.status(404).json({ message: "Лекция не найдена" });
      return;
    }
    if (lecture.status !== "ready") {
      res.status(400).json({ message: "Лекция ещё не готова" });
      return;
    }
    title = title || lecture.title;
  } else if (kind === "document") {
    sourceId = Number(body.sourceId);
    const [doc] = Number.isInteger(sourceId)
      ? await db
          .select()
          .from(documentsTable)
          .where(and(eq(documentsTable.id, sourceId), eq(documentsTable.ownerId, req.user!.id)))
          .limit(1)
      : [];
    if (!doc) {
      res.status(404).json({ message: "Документ не найден" });
      return;
    }
    if (doc.status !== "ready") {
      res.status(400).json({ message: "Документ ещё не готов" });
      return;
    }
    title = title || doc.title;
  } else if (kind === "raw") {
    const text = typeof body.rawText === "string" ? body.rawText.trim() : "";
    if (text.length < 200) {
      res.status(400).json({ message: "Вставьте текст лекции — хотя бы пару абзацев" });
      return;
    }
    // Потолок: больше и лекция инструмента 2 не выдаёт, а payload не резиновый.
    rawText = text.slice(0, 200_000);
    title = title || text.slice(0, 70);
  } else {
    res.status(400).json({ message: "Неизвестный источник презентации" });
    return;
  }

  // Стиль серии: явный выбор проверяем по списку доступных пакетов — чужой id
  // это 400, а не тихая подмена. Без выбора — первый доступный, как раньше.
  const available = await availablePacksQuery(req.user!.id);
  let stylePackId: number | null = available[0]?.id ?? null;
  if (body.stylePackId !== undefined && body.stylePackId !== null) {
    const requested = Number(body.stylePackId);
    if (!Number.isInteger(requested) || !available.some((p) => p.id === requested)) {
      res.status(400).json({ message: "Такой стиль серии недоступен" });
      return;
    }
    stylePackId = requested;
  }

  // Вставленный текст в рабочих таблицах не хранится — он едет прямо в
  // задачу. Задачи удаляются вместе с колодой, поэтому сам текст — в архив,
  // в той же транзакции, что и колода: без архива колоду не заводим.
  const deck = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(decksTable)
      .values({
        ownerId: req.user!.id,
        title,
        sourceKind: kind,
        sourceId,
        stylePackId,
        status: "storyboarding",
        statusMessage: "В очереди…",
      })
      .returning();
    if (rawText) await tx.execute(archiveInputSql("decks", row.id, { raw_text: rawText }));
    return row;
  });

  await enqueue("deck.storyboard", deck.id, rawText ? { rawText } : {});
  res.status(201).json(deck);
});

/** Переименовать презентацию или переложить её в папку библиотеки. */
router.patch("/decks/:id", async (req, res): Promise<void> => {
  const deck = await deckOr404(req, res);
  if (!deck) return;

  const body = req.body ?? {};
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if ("title" in body && (title === "" || title.length > 200)) {
    res.status(400).json({ message: "Название — от 1 до 200 знаков" });
    return;
  }
  if ("folderId" in body) {
    const folderId = await ownFolderId(body.folderId, req.user!.id);
    if (folderId === undefined) {
      res.status(404).json({ message: "Папка не найдена" });
      return;
    }
    // Текстовая копия в поиске переезжает вместе с колодой: материал живёт
    // в одном месте, а не расползается по двум папкам.
    await db.update(decksTable).set({ folderId }).where(eq(decksTable.id, deck.id));
    await db
      .update(documentsTable)
      .set({ folderId })
      .where(eq(documentsTable.deckId, deck.id));
  }
  if (title !== "") {
    // Копия в поиске называется так же, как колода.
    await db.update(decksTable).set({ title }).where(eq(decksTable.id, deck.id));
    await db.update(documentsTable).set({ title }).where(eq(documentsTable.deckId, deck.id));
  }
  res.json({ ok: true });
});

/** Замечание автора к образу; пустое — «просто ещё раз». */
function optionalInstruction(body: unknown): string | undefined {
  const raw = (body as { instruction?: unknown } | null)?.instruction;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim().slice(0, 2000) : undefined;
}

/** Нарисовать образ одного слайда готовой колоды. Сначала задача, потом статус. */
async function startDrawing(deckId: number, slideId: number, instruction: string | undefined): Promise<void> {
  await enqueue(
    "deck.illustrate",
    deckId,
    instruction ? { slideIds: [slideId], instruction } : { slideIds: [slideId] },
  );
  await db
    .update(decksTable)
    .set({ status: "drawing", statusMessage: "В очереди…", error: null })
    .where(eq(decksTable.id, deckId));
}

/** Правка слайда автором — только пока конвейер не работает над колодой. */
router.patch("/decks/:id/slides/:sid", async (req, res): Promise<void> => {
  const deck = await deckOr404(req, res);
  if (!deck) return;
  if (deck.status === "storyboarding" || deck.status === "drawing") {
    res.status(409).json({ message: "Подождите, я ещё работаю" });
    return;
  }

  const slide = await slideOr404(deck, req, res);
  if (!slide) return;

  const body = req.body ?? {};
  const patch: Partial<typeof deckSlidesTable.$inferInsert> = {};

  if (body.content && typeof body.content === "object" && !Array.isArray(body.content)) {
    // Форму content не гарантирует никто — ни модель, ни фронт; кривое поле
    // валит экспорт PPTX, поэтому приводим к строгому виду.
    patch.content = sanitizeSlideContent(body.content);
  }
  if (typeof body.notes === "string") patch.notes = body.notes.slice(0, 20_000);
  if (SLIDE_LAYOUTS.includes(body.layout)) patch.layout = body.layout as SlideLayout;
  if (body.imageSide === "left" || body.imageSide === "right") patch.imageSide = body.imageSide;

  if ("imageBrief" in body) {
    if (body.imageBrief === null) {
      // Автор отказался от образа: чистим и бриф, и уже выбранную картинку.
      patch.imageBrief = null;
      patch.imageStatus = "none";
      patch.imageId = null;
    } else if (typeof body.imageBrief === "string" && body.imageBrief.trim() !== "") {
      // На схеме и финале образа не бывает: схему рисуют кодом, финал —
      // только текст. Картинку оплатили бы, а показать её негде.
      const layout = patch.layout ?? slide.layout;
      if (!layoutHasImage(layout)) {
        res.status(400).json({ message: "На этом макете образа не бывает" });
        return;
      }
      patch.imageBrief = body.imageBrief.trim().slice(0, 2000);
      // Если картинка уже есть, новый бриф её не сбрасывает —
      // перерисовка запускается отдельной ручкой redraw.
      if (!slide.imageId) patch.imageStatus = "queued";
    }
  }

  if (Object.keys(patch).length > 0) {
    await db.update(deckSlidesTable).set(patch).where(eq(deckSlidesTable.id, slide.id));
    // Автор поправил слайд сам — прошлая неудачная переделка уже не новость.
    // В статусе error строка — причина у кнопки повтора, её не трогаем.
    if (deck.status !== "error" && deck.error) {
      await db.update(decksTable).set({ error: null }).where(eq(decksTable.id, deck.id));
    }
    // Текст изменился — библиотечная копия не должна отставать. Переиндексация
    // локальная и дешёвая, поэтому делаем сразу, а не «когда-нибудь потом».
    if (patch.content || patch.notes !== undefined) {
      await deckToLibrary(deck.id).catch(logLibraryLag(req, deck.id));
    }
  }

  // Образ задан слайду готовой колоды, где картинки ещё нет (не было брифа,
  // первая попытка упала или слайд завис в «queued»), — рисуем сразу, как
  // перерисовку: иначе «queued» на готовой колоде никто бы не подобрал.
  // Готовую картинку это не трогает: при imageId статус не меняется выше.
  // До утверждения слайд подберёт approve, в ошибке — повтор.
  // Замечание к образу едет тем же запросом: отдельный redraw после такого
  // сохранения получил бы 409 — колода уже рисует.
  if (deck.status === "ready" && patch.imageStatus === "queued") {
    await startDrawing(deck.id, slide.id, optionalInstruction(body));
    res.status(202).json({ ok: true });
    return;
  }
  res.json({ ok: true });
});

/** Человек в цикле: ни одна картинка не рисуется до утверждения раскадровки. */
router.post("/decks/:id/approve", async (req, res): Promise<void> => {
  const deck = await deckOr404(req, res);
  if (!deck) return;
  if (deck.status !== "storyboard_ready") {
    res.status(409).json({ message: "Раскадровка ещё не готова" });
    return;
  }

  const withBrief = await db
    .select({ id: deckSlidesTable.id })
    .from(deckSlidesTable)
    .where(and(eq(deckSlidesTable.deckId, deck.id), isNotNull(deckSlidesTable.imageBrief)));

  // Рисовать нечего — колода готова сразу, очередь не нужна.
  if (withBrief.length === 0) {
    await db
      .update(decksTable)
      .set({ storyboardApproved: true, status: "ready", statusMessage: "", error: null })
      .where(eq(decksTable.id, deck.id));
    await deckToLibrary(deck.id).catch(logLibraryLag(req, deck.id));
    res.status(202).json({ ok: true });
    return;
  }

  // Сначала задача, потом статус: упади enqueue после смены статуса —
  // колода зависла бы в «рисую» без задачи в очереди.
  await db
    .update(decksTable)
    .set({ storyboardApproved: true })
    .where(eq(decksTable.id, deck.id));
  await enqueue("deck.illustrate", deck.id, {});
  await db
    .update(decksTable)
    .set({ status: "drawing", statusMessage: "В очереди…", error: null })
    .where(eq(decksTable.id, deck.id));
  res.status(202).json({ ok: true });
});

/**
 * Переделать текст слайда словами автора. Правка руками — это PATCH выше;
 * здесь автор объясняет, что не так, а формулирует модель.
 */
router.post("/decks/:id/slides/:sid/rewrite", async (req, res): Promise<void> => {
  const deck = await deckOr404(req, res);
  if (!deck) return;
  if (deck.status === "error") {
    res.status(409).json({ message: RETRY_FIRST });
    return;
  }
  if (deck.status !== "ready" && deck.status !== "storyboard_ready") {
    res.status(409).json({ message: "Подождите, я ещё работаю" });
    return;
  }

  const slide = await slideOr404(deck, req, res);
  if (!slide) return;

  const instruction =
    typeof req.body?.instruction === "string" ? req.body.instruction.trim().slice(0, 2000) : "";
  if (instruction === "") {
    res.status(400).json({ message: "Скажите, что изменить" });
    return;
  }

  // Сначала задача, потом статус: упади enqueue после смены статуса —
  // колода зависла бы в «работаю» без задачи в очереди.
  await enqueue("deck.reslide", deck.id, { slideId: slide.id, instruction, back: deck.status });
  // Сообщение сразу по делу: оно же становится заголовком панели работы,
  // и «раскладываю по слайдам» на правке одного слайда пугало бы зря.
  await db
    .update(decksTable)
    .set({ status: "storyboarding", statusMessage: "Переделываю слайд…", error: null })
    .where(eq(decksTable.id, deck.id));
  res.status(202).json({ ok: true });
});

/** Перерисовка одного образа — по желанию автора, с его замечанием. */
router.post("/decks/:id/slides/:sid/redraw", async (req, res): Promise<void> => {
  const deck = await deckOr404(req, res);
  if (!deck) return;
  if (deck.status !== "ready") {
    res.status(409).json({ message: "Перерисовать можно, когда колода готова" });
    return;
  }

  const slide = await slideOr404(deck, req, res);
  if (!slide) return;
  if (!slide.imageBrief) {
    res.status(400).json({ message: "У этого слайда нет образа" });
    return;
  }

  await db
    .update(deckSlidesTable)
    .set({ imageStatus: "queued" })
    .where(eq(deckSlidesTable.id, slide.id));
  await startDrawing(deck.id, slide.id, optionalInstruction(req.body));
  res.status(202).json({ ok: true });
});

router.get("/decks/:id/images/:imageId/file", async (req, res): Promise<void> => {
  const deck = await deckOr404(req, res);
  if (!deck) return;

  const imageId = parseId(req.params.imageId);
  const [image] = imageId
    ? await db
        .select()
        .from(deckImagesTable)
        .where(and(eq(deckImagesTable.id, imageId), eq(deckImagesTable.deckId, deck.id)))
        .limit(1)
    : [];

  // Файл мог не дожить до запроса (чистка tmp, перенос) — тогда честные 404.
  if (!image?.path || !existsSync(path.resolve(image.path))) {
    res.status(404).json({ message: "Картинка не найдена" });
    return;
  }

  const mime =
    image.path.endsWith(".jpg") ? "image/jpeg"
    : image.path.endsWith(".webp") ? "image/webp"
    : "image/png";
  res.sendFile(path.resolve(image.path), { headers: { "Content-Type": mime } });
});

/** Выгрузка колоды: PPTX по умолчанию, PDF-раздатка по ?format=pdf.
 * Разрешена и до отрисовки: текстовая колода тоже колода. И после неудачной
 * отрисовки утверждённой колоды: текст слайдов цел, недорисованные образы
 * уходят текстовой пластиной. */
router.get("/decks/:id/export", async (req, res): Promise<void> => {
  const deck = await deckOr404(req, res);
  if (!deck) return;
  const format = req.query.format ?? "pptx";
  if (format !== "pptx" && format !== "pdf") {
    res.status(400).json({ message: "Такой формат не умею — только pptx и pdf" });
    return;
  }
  if (deck.status === "error" && !deck.storyboardApproved) {
    res.status(409).json({ message: RETRY_FIRST });
    return;
  }
  if (deck.status === "storyboarding" || deck.status === "drawing") {
    res.status(409).json({ message: "Подождите, я ещё работаю" });
    return;
  }

  const slides = await db
    .select()
    .from(deckSlidesTable)
    .where(eq(deckSlidesTable.deckId, deck.id))
    .orderBy(asc(deckSlidesTable.ord));

  const images = await db
    .select()
    .from(deckImagesTable)
    .where(eq(deckImagesTable.deckId, deck.id));

  const pack = await deckStylePack(deck.stylePackId);
  if (!pack) {
    res.status(500).json({ message: "Стилевой пакет не найден" });
    return;
  }

  const imagesById = new Map(images.map((img) => [img.id, img]));

  if (format === "pdf") {
    // Раздатка для зала: те же макеты, но без заметок докладчика.
    const buffer = await buildDeckPdf(deck, slides, imagesById, pack);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", attachmentHeader(deck.title, "pdf", "презентация"));
    res.send(buffer);
    return;
  }

  const buffer = await buildDeckPptx(deck, slides, imagesById, pack);

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
  res.setHeader("Content-Disposition", attachmentHeader(deck.title, "pptx", "презентация"));
  res.send(buffer);
});

/**
 * Повтор после ошибки. До утверждения — раскадровка заново (текст берём из
 * payload проваленной задачи: у неуспешных он не затирается), после — только
 * недорисованные образы.
 */
router.post("/decks/:id/retry", async (req, res): Promise<void> => {
  const deck = await deckOr404(req, res);
  if (!deck) return;
  if (deck.status !== "error") {
    res.status(409).json({ message: "Повторять нечего — ошибки нет" });
    return;
  }

  if (!deck.storyboardApproved) {
    const [lastJob] = await db
      .select()
      .from(jobsTable)
      .where(and(eq(jobsTable.kind, "deck.storyboard"), eq(jobsTable.entityId, deck.id)))
      .orderBy(desc(jobsTable.id))
      .limit(1);
    const rawText = (lastJob?.payload as { rawText?: string } | undefined)?.rawText;
    if (deck.sourceKind === "raw" && !rawText) {
      res.status(409).json({ message: "Текст не сохранился — создайте презентацию заново" });
      return;
    }
    await enqueue("deck.storyboard", deck.id, rawText ? { rawText } : {});
    await db
      .update(decksTable)
      .set({ status: "storyboarding", statusMessage: "В очереди…", error: null })
      .where(eq(decksTable.id, deck.id));
    res.status(202).json({ ok: true });
    return;
  }

  await db
    .update(deckSlidesTable)
    .set({ imageStatus: "queued" })
    .where(
      and(
        eq(deckSlidesTable.deckId, deck.id),
        isNotNull(deckSlidesTable.imageBrief),
        inArray(deckSlidesTable.imageStatus, ["error", "drawing", "queued"]),
      ),
    );
  await enqueue("deck.illustrate", deck.id, {});
  await db
    .update(decksTable)
    .set({ status: "drawing", statusMessage: "В очереди…", error: null })
    .where(eq(decksTable.id, deck.id));
  res.status(202).json({ ok: true });
});

router.delete("/decks/:id", async (req, res): Promise<void> => {
  const deck = await deckOr404(req, res);
  if (!deck) return;

  // Удаление убирает колоду из рабочего пространства, но не стирает: колода,
  // слайды и картинки (каскад по FK) уходят в архив триггерами, файлы
  // картинок — в архив файлов до rm. Без архива не удаляем ничего.
  await requireArchive();

  // Удалять можно на любом этапе — ждать окончания работы человек не обязан.
  // Задачи снимаем первыми: воркер, начав слайд, проверит колоду перед
  // записью файла и остановится сам (см. handlers/illustrate.ts).
  // payload КАЖДОЙ снимаемой задачи — в архив (op='INPUT') тем же
  // оператором, что и снятие: вставленный текст, указания к переделке
  // слайда и образа владелица вводила руками, и больше их нигде нет.
  await db.execute(deleteJobsArchivingInput("deck.%", "decks", deck.id));
  // Текстовая копия в поиске — часть той же презентации, а не отдельный
  // документ: убираем вместе, иначе в библиотеке остался бы призрак колоды,
  // которую уже не открыть.
  await dropDeckCopies(deck.id);

  // Сначала файлы, потом запись: осиротевшая папка хуже осиротевшей строки.
  // Каталог уходит, только если ВСЕ картинки легли в архив.
  await archiveTreeAndRemove(path.join(DECKS_DIR, String(deck.id)), {
    entityType: "deck",
    entityId: deck.id,
  });
  await db.delete(decksTable).where(eq(decksTable.id, deck.id));
  res.sendStatus(204);
});

export default router;
