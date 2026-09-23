import path from "node:path";
import { existsSync } from "node:fs";
import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, or, asc, desc, isNotNull, isNull, ne } from "drizzle-orm";
import {
  db,
  decksTable,
  deckSlidesTable,
  deckImagesTable,
  stylePacksTable,
  lecturesTable,
  documentsTable,
  type Deck,
  type DeckSlide,
  type DeckStatus,
  type JobKind,
  type SlideLayout,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import { SLIDE_LAYOUTS, layoutHasImage } from "@workspace/db/slides";
import { ownFolderId } from "../../lib/folders";
import { deckToLibrary, dropDeckCopies } from "../../lib/work-doc";
import { DECKS_DIR } from "../../lib/paths";
import { buildDeckPptx } from "../../lib/pptx";
import { buildDeckPdf } from "../../lib/pdf";
import { sanitizeSlideContent, settleSlides } from "../../lib/slide-content";
import { deckStylePack } from "../../lib/deck-style";
import { MAX_SOURCE_CHARS, SOURCE_GONE } from "../../lib/handlers/storyboard";
import { parseId } from "../../lib/parse-id";
import { QUEUED_MESSAGE, enqueue, lastJob } from "../../lib/jobs";
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

/** Слайды колоды по порядку — для экрана и выгрузки, текст в полях макета. */
async function deckSlides(deckId: number): Promise<DeckSlide[]> {
  const rows = await db
    .select()
    .from(deckSlidesTable)
    .where(eq(deckSlidesTable.deckId, deckId))
    .orderBy(asc(deckSlidesTable.ord));
  return settleSlides(rows);
}

/** В ошибке колода стоит — не «работает»: сказать, что делать. */
const RETRY_FIRST = "Сначала нажмите «Попробовать ещё раз»";

/** Копия в библиотеке отстала от правки — ответ всё равно ok, но след в журнале. */
function logLibraryLag(req: Request, id: number) {
  return (err: unknown) => req.log.error({ err, id }, "Не смог обновить копию презентации в библиотеке");
}

const BUSY = "Подождите, я ещё работаю";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Платная задача колоды (раскадровка, отрисовка, переделка слайда) и смена
 * статуса — одной транзакцией с условием на прежний статус. Второй клик или
 * вторая вкладка уже не найдут колоду в этом статусе и второй задачи не
 * поставят; колода «в работе» без задачи тоже невозможна. false — колоду
 * успели занять, ручке ответить 409 BUSY.
 */
async function queueDeckJob(
  deckId: number,
  from: DeckStatus[],
  set: Partial<typeof decksTable.$inferInsert>,
  kind: JobKind,
  payload: Record<string, unknown>,
  before?: (tx: Tx) => Promise<unknown>,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(decksTable)
      .set({ error: null, ...set })
      .where(and(eq(decksTable.id, deckId), inArray(decksTable.status, from)))
      .returning({ id: decksTable.id });
    if (!row) return false;
    if (before) await before(tx);
    await enqueue(kind, deckId, payload, tx);
    return true;
  });
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

  const slides = await deckSlides(deck.id);

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
    // Длиннее модель не прочтёт — лучше сказать сразу, чем молча потерять хвост.
    if (text.length > MAX_SOURCE_CHARS) {
      res.status(400).json({
        message: `Текст длиннее ${MAX_SOURCE_CHARS.toLocaleString("ru-RU")} знаков — сократите его`,
      });
      return;
    }
    rawText = text;
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
        statusMessage: QUEUED_MESSAGE,
      })
      .returning();
    if (rawText) await tx.execute(archiveInputSql("decks", row.id, { raw_text: rawText }));
    // Задача — в той же транзакции: колода «раскладываю» без задачи висела бы вечно.
    await enqueue("deck.storyboard", row.id, rawText ? { rawText } : {}, tx);
    return row;
  });

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
  const set: { folderId?: number | null; title?: string } = {};
  if ("folderId" in body) {
    const folderId = await ownFolderId(body.folderId, req.user!.id);
    if (folderId === undefined) {
      res.status(404).json({ message: "Папка не найдена" });
      return;
    }
    set.folderId = folderId;
  }
  if (title !== "") set.title = title;
  if (Object.keys(set).length > 0) {
    // Текстовая копия в поиске переезжает и переименовывается вместе с
    // колодой — одной транзакцией: материал не расползается по двум папкам.
    await db.transaction(async (tx) => {
      await tx.update(decksTable).set(set).where(eq(decksTable.id, deck.id));
      await tx.update(documentsTable).set(set).where(eq(documentsTable.deckId, deck.id));
    });
  }
  res.json({ ok: true });
});

/** Замечание автора к образу; пустое — «просто ещё раз». */
function optionalInstruction(body: unknown): string | undefined {
  const raw = (body as { instruction?: unknown } | null)?.instruction;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim().slice(0, 2000) : undefined;
}

/** Нарисовать образ одного слайда готовой колоды. false — колода уже занята. */
function startDrawing(
  deckId: number,
  slideId: number,
  instruction: string | undefined,
  before?: (tx: Tx) => Promise<unknown>,
): Promise<boolean> {
  return queueDeckJob(
    deckId,
    ["ready"],
    { status: "drawing", statusMessage: QUEUED_MESSAGE },
    "deck.illustrate",
    instruction ? { slideIds: [slideId], instruction } : { slideIds: [slideId] },
    before,
  );
}

/** Правка слайда автором — только пока конвейер не работает над колодой. */
router.patch("/decks/:id/slides/:sid", async (req, res): Promise<void> => {
  const deck = await deckOr404(req, res);
  if (!deck) return;
  if (deck.status === "storyboarding" || deck.status === "drawing") {
    res.status(409).json({ message: BUSY });
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

  // На готовой колоде «в очереди» ставит та же транзакция, что и задачу
  // рисования: занята колода — слайд не повиснет в «queued» без задачи.
  const drawNow = deck.status === "ready" && patch.imageStatus === "queued";
  if (drawNow) delete patch.imageStatus;

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
  if (drawNow) {
    // Колоду успели занять — правка сохранена, образ можно перерисовать потом.
    const queued = await startDrawing(deck.id, slide.id, optionalInstruction(body), (tx) =>
      tx.update(deckSlidesTable).set({ imageStatus: "queued" }).where(eq(deckSlidesTable.id, slide.id)),
    );
    res.status(queued ? 202 : 200).json({ ok: true });
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

  // Бриф на финале или схеме (остался от прежнего макета) не рисуется —
  // то же правило, что у отрисовки: иначе колода ушла бы рисовать пустоту.
  const withBrief = (
    await db
      .select({ layout: deckSlidesTable.layout })
      .from(deckSlidesTable)
      .where(and(eq(deckSlidesTable.deckId, deck.id), isNotNull(deckSlidesTable.imageBrief)))
  ).filter((s) => layoutHasImage(s.layout));

  // Рисовать нечего — колода готова сразу, очередь не нужна.
  if (withBrief.length === 0) {
    const [done] = await db
      .update(decksTable)
      .set({ storyboardApproved: true, status: "ready", statusMessage: "", error: null })
      .where(and(eq(decksTable.id, deck.id), eq(decksTable.status, "storyboard_ready")))
      .returning({ id: decksTable.id });
    if (!done) {
      res.status(409).json({ message: BUSY });
      return;
    }
    await deckToLibrary(deck.id).catch(logLibraryLag(req, deck.id));
    res.status(202).json({ ok: true });
    return;
  }

  const queued = await queueDeckJob(
    deck.id,
    ["storyboard_ready"],
    { storyboardApproved: true, status: "drawing", statusMessage: QUEUED_MESSAGE },
    "deck.illustrate",
    {},
  );
  if (!queued) {
    res.status(409).json({ message: BUSY });
    return;
  }
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
    res.status(409).json({ message: BUSY });
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

  // Сообщение сразу по делу: оно же становится заголовком панели работы,
  // и «раскладываю по слайдам» на правке одного слайда пугало бы зря.
  // Условие — ровно прочитанный статус: в него же задача вернёт колоду (back).
  const queued = await queueDeckJob(
    deck.id,
    [deck.status],
    { status: "storyboarding", statusMessage: "Переделываю слайд…" },
    "deck.reslide",
    { slideId: slide.id, instruction, back: deck.status },
  );
  if (!queued) {
    res.status(409).json({ message: BUSY });
    return;
  }
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
  if (!slide.imageBrief || !layoutHasImage(slide.layout)) {
    res.status(400).json({ message: "У этого слайда нет образа" });
    return;
  }

  const queued = await startDrawing(deck.id, slide.id, optionalInstruction(req.body), (tx) =>
    tx.update(deckSlidesTable).set({ imageStatus: "queued" }).where(eq(deckSlidesTable.id, slide.id)),
  );
  if (!queued) {
    res.status(409).json({ message: BUSY });
    return;
  }
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
    res.status(409).json({ message: BUSY });
    return;
  }

  const slides = await deckSlides(deck.id);

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

/** Источник колоды ещё есть и годится: те же условия, что при создании. */
async function sourceAlive(deck: Deck): Promise<boolean> {
  const id = deck.sourceId;
  if (id === null) return false;
  const [row] =
    deck.sourceKind === "lecture"
      ? await db
          .select({ status: lecturesTable.status })
          .from(lecturesTable)
          .where(and(eq(lecturesTable.id, id), eq(lecturesTable.ownerId, deck.ownerId)))
          .limit(1)
      : await db
          .select({ status: documentsTable.status })
          .from(documentsTable)
          .where(and(eq(documentsTable.id, id), eq(documentsTable.ownerId, deck.ownerId)))
          .limit(1);
  return row?.status === "ready";
}

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
    const prev = await lastJob("deck.storyboard", deck.id);
    const rawText = (prev?.payload as { rawText?: string } | undefined)?.rawText;
    if (deck.sourceKind === "raw" && !rawText) {
      res.status(409).json({ message: "Текст не сохранился — создайте презентацию заново" });
      return;
    }
    // Лекцию или документ удалили — повтор упал бы на том же месте.
    if (deck.sourceKind !== "raw" && !(await sourceAlive(deck))) {
      res.status(409).json({ message: SOURCE_GONE });
      return;
    }
    const queued = await queueDeckJob(
      deck.id,
      ["error"],
      { status: "storyboarding", statusMessage: QUEUED_MESSAGE },
      "deck.storyboard",
      rawText ? { rawText } : {},
    );
    res.status(queued ? 202 : 409).json(queued ? { ok: true } : { message: BUSY });
    return;
  }

  const queued = await queueDeckJob(
    deck.id,
    ["error"],
    { status: "drawing", statusMessage: QUEUED_MESSAGE },
    "deck.illustrate",
    {},
    (tx) =>
      tx
        .update(deckSlidesTable)
        .set({ imageStatus: "queued" })
        .where(
          and(
            eq(deckSlidesTable.deckId, deck.id),
            isNotNull(deckSlidesTable.imageBrief),
            inArray(deckSlidesTable.imageStatus, ["error", "drawing", "queued"]),
          ),
        ),
  );
  res.status(queued ? 202 : 409).json(queued ? { ok: true } : { message: BUSY });
});

/**
 * Убрать слайд — только руками автора (модель слайды не удаляет) и только
 * пока колода не в работе. Строка слайда и его образы уходят в архив
 * триггером, файлы картинок остаются на диске. Последний слайд не убираем:
 * пустая колода — это удаление презентации, для него своя кнопка.
 */
router.delete("/decks/:id/slides/:sid", async (req, res): Promise<void> => {
  await requireArchive();
  const deck = await deckOr404(req, res);
  if (!deck) return;
  if (deck.status === "error") {
    res.status(409).json({ message: RETRY_FIRST });
    return;
  }
  const slide = await slideOr404(deck, req, res);
  if (!slide) return;

  // Проверка статуса, «не последний ли» и удаление — одной транзакцией под
  // блокировкой строки колоды: иначе параллельная переделка или утверждение
  // (queueDeckJob берёт ту же блокировку) работали бы над исчезнувшим слайдом,
  // а две вкладки могли бы убрать последние два. updated_at — служебная
  // колонка: лишней версии колоды в архиве не будет.
  const outcome = await db.transaction(async (tx) => {
    const [locked] = await tx
      .update(decksTable)
      .set({ updatedAt: new Date() })
      .where(and(eq(decksTable.id, deck.id), inArray(decksTable.status, ["storyboard_ready", "ready"])))
      .returning({ status: decksTable.status });
    if (!locked) return "busy" as const;
    const others = await tx
      .select({ id: deckSlidesTable.id })
      .from(deckSlidesTable)
      .where(and(eq(deckSlidesTable.deckId, deck.id), ne(deckSlidesTable.id, slide.id)))
      .limit(1);
    if (others.length === 0) return "last" as const;
    await tx.delete(deckSlidesTable).where(eq(deckSlidesTable.id, slide.id));
    return locked.status;
  });
  if (outcome === "busy") {
    res.status(409).json({ message: BUSY });
    return;
  }
  if (outcome === "last") {
    res.status(409).json({ message: "Это единственный слайд — удалите презентацию целиком" });
    return;
  }
  if (outcome === "ready") await deckToLibrary(deck.id).catch(logLibraryLag(req, deck.id));
  res.json({ ok: true });
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
