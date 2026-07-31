import { eq, asc } from "drizzle-orm";
import {
  db,
  decksTable,
  deckSlidesTable,
  lecturesTable,
  lectureSectionsTable,
  documentsTable,
  docChunksTable,
  type Job,
  type SlideContent,
  type SlideLayout,
  type ImageStatus,
  type ImageSide,
  type DiagramSpec,
} from "@workspace/db";
import { SLIDE_LAYOUTS } from "@workspace/db/slides";
import { askJson } from "../claude";
import { sanitizeSlideContent } from "../slide-content";
import { registerHandler } from "../jobs";
import { logger } from "../logger";

interface StoryboardSlide {
  layout: string;
  content: SlideContent;
  notes?: string;
  imageBrief?: string | null;
  imageSide?: string;
  diagramSpec?: unknown;
}

/**
 * Модель отвечает JSON'ом без гарантий формы, а схема потом рисуется кодом —
 * и в PPTX, и на фронте. Поэтому приводим к контракту DiagramSpec руками:
 * только известные поля, обрезка длин (label 60, sub 120), максимум 6 шагов.
 * Всё, что не дотягивает до осмысленной схемы (меньше двух шагов), — null:
 * лучше слайд текстом, чем кривая схема.
 */
function sanitizeDiagramSpec(raw: unknown): DiagramSpec | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { kind, items } = raw as { kind?: unknown; items?: unknown };
  if (kind !== "flow" && kind !== "pillars") return null;
  if (!Array.isArray(items)) return null;

  const clean: DiagramSpec["items"] = [];
  for (const it of items) {
    if (!it || typeof it !== "object" || Array.isArray(it)) continue;
    const { label, sub } = it as { label?: unknown; sub?: unknown };
    if (typeof label !== "string" || label.trim() === "") continue;
    const item: DiagramSpec["items"][number] = { label: label.trim().slice(0, 60) };
    if (typeof sub === "string" && sub.trim() !== "") item.sub = sub.trim().slice(0, 120);
    clean.push(item);
    if (clean.length === 6) break;
  }

  if (clean.length < 2) return null;
  return { kind, items: clean };
}

/** Собирает исходный текст, из которого делается презентация. */
async function loadSourceText(
  kind: string,
  sourceId: number | null,
  ownerId: number,
): Promise<{ title: string; text: string }> {
  if (kind === "lecture" && sourceId) {
    const [lecture] = await db
      .select()
      .from(lecturesTable)
      .where(eq(lecturesTable.id, sourceId))
      .limit(1);
    if (!lecture || lecture.ownerId !== ownerId) throw new Error("Лекция не найдена");

    const sections = await db
      .select()
      .from(lectureSectionsTable)
      .where(eq(lectureSectionsTable.lectureId, sourceId))
      .orderBy(asc(lectureSectionsTable.ord));

    const text = sections.map((s) => `## ${s.heading}\n\n${s.text}`).join("\n\n");
    return { title: lecture.title, text };
  }

  if (kind === "document" && sourceId) {
    const [doc] = await db
      .select()
      .from(documentsTable)
      .where(eq(documentsTable.id, sourceId))
      .limit(1);
    if (!doc || doc.ownerId !== ownerId) throw new Error("Документ не найден");

    const chunks = await db
      .select()
      .from(docChunksTable)
      .where(eq(docChunksTable.documentId, sourceId))
      .orderBy(asc(docChunksTable.ord));

    return { title: doc.title, text: chunks.map((c) => c.text).join("\n\n") };
  }

  throw new Error("Неизвестный источник презентации");
}

async function run(job: Job): Promise<void> {
  const id = job.entityId;
  const [deck] = await db.select().from(decksTable).where(eq(decksTable.id, id)).limit(1);
  if (!deck) throw new Error("Презентация не найдена");

  await db
    .update(decksTable)
    .set({ status: "storyboarding", statusMessage: "Читаю материал…", error: null })
    .where(eq(decksTable.id, id));

  const raw = (job.payload as { rawText?: string }).rawText;
  const source =
    deck.sourceKind === "raw" && raw
      ? { title: deck.title, text: raw }
      : await loadSourceText(deck.sourceKind, deck.sourceId, deck.ownerId);

  await db
    .update(decksTable)
    .set({ statusMessage: "Раскладываю по слайдам…" })
    .where(eq(decksTable.id, id));

  const system = [
    "Ты собираешь презентацию к устному выступлению по психоанализу на русском языке.",
    "Тебе дан текст лекции. Разложи его по слайдам.",
    "",
    "Правила:",
    "— Слайд не пересказывает абзац, а держит ОДНУ мысль. Тезисы короткие: это опора для речи, а не текст для чтения вслух.",
    "— Заметки докладчику (notes) — то, что автор скажет голосом: там развёрнутая мысль, примеры, переходы.",
    "— Основного текста на слайде не больше 6–8 строк.",
    "",
    // Порядок из брендбука: сперва функция слайда, из неё — композиция.
    // Поэтому в layout идёт задача, а не вёрстка.
    `— Сначала определи ФУНКЦИЮ слайда. Только из списка: ${SLIDE_LAYOUTS.join(", ")}.`,
    "  cover — обложка, divider — разделитель части, theory — теория (тезис и 3–5 пунктов),",
    "  quote — цитата до 35 слов, clinical — клинический фрагмент (случай, сцена, материал),",
    "  comparison — сопоставление двух понятий, final — финальный, diagram — структура/схема.",
    "— Начни с cover, закончи final. Разделители ставь там, где меняется часть.",
    "— На final не пиши «Спасибо за внимание»: заверши выводом, вопросом или направлением чтения.",
    "— На theory и clinical хорош «рабочий вопрос» (поле question) — вопрос к слушателю, а не вывод.",
    "",
    "Про иллюстрации — самое важное:",
    "— imageBrief заполняй ТОЛЬКО там, где образ несёт мысль. Если картинка будет украшением — оставь null.",
    "— Иллюстраций должно быть НЕ БОЛЬШЕ ТРЕТИ слайдов. Презентация, где картинка на каждом слайде, читается как альбом, а не как выступление.",
    "— imageBrief — это МЫСЛЬ, которую должна передать картинка, на русском, одним-двумя предложениями.",
    "  Не описывай сцену и не придумывай сюжет — этим займётся художник. Пиши, ЧТО должно быть понятно зрителю.",
    "— imageSide — на какой стороне слайда стоит образ: left или right. Чередуй, чтобы серия не была однообразной.",
    "— На слайдах с макетом diagram картинок не бывает: там структура, её рисуют схемой.",
    "— На clinical образ — интерьер, объект или сцена, но НЕ портрет человека.",
    "— Не повторяй один и тот же образ: чередуй человека, интерьер, предмет, анатомический фрагмент, пустое поле.",
    "",
    'Формат ответа: {"slides":[{"layout":"...","content":{...},"notes":"...","imageBrief":null,"imageSide":"right"}]}',
    "content зависит от функции: eyebrow, title, subtitle, bullets[], cards[{title,body}], quote, attribution, question, plate.",
    'На diagram-слайде заполни ещё "diagramSpec": {"kind":"flow"|"pillars","items":[{"label":"...","sub":"..."}]} —',
    "2–6 шагов, label до 60 знаков, sub — необязательная расшифровка до 120. flow — последовательность",
    "(этапы, стрелки сверху вниз), pillars — рядоположные опоры колонками. Другим слайдам diagramSpec не нужен.",
  ].join("\n");

  const result = await askJson<{ slides?: StoryboardSlide[] }>({
    system,
    user: `Название: ${source.title}\n\nТекст лекции:\n\n${source.text.slice(0, 120_000)}`,
    maxTokens: 16000,
  });

  const MAX_SLIDES = 24;
  const parsed = (result.slides ?? []).filter((s) => s && typeof s === "object");
  if (parsed.length === 0) throw new Error("Не удалось разложить материал по слайдам");
  if (parsed.length > MAX_SLIDES) {
    logger.warn({ id, got: parsed.length, cap: MAX_SLIDES }, "Слайдов больше потолка — обрезаю");
  }
  const slides = parsed.slice(0, MAX_SLIDES);

  await db.delete(deckSlidesTable).where(eq(deckSlidesTable.deckId, id));
  await db.insert(deckSlidesTable).values(
    slides.map((s, i) => {
      const layout: SlideLayout = SLIDE_LAYOUTS.includes(s.layout as SlideLayout)
        ? (s.layout as SlideLayout)
        : "theory";
      const brief = typeof s.imageBrief === "string" && s.imageBrief.trim() !== ""
        ? s.imageBrief.trim()
        : null;
      // Схема и метафора взаимоисключают друг друга: на слайде-схеме
      // картинка только помешает.
      const wanted = layout === "diagram" ? null : brief;
      const imageStatus: ImageStatus = wanted ? "queued" : "none";
      return {
        deckId: id,
        ord: i,
        layout,
        content: sanitizeSlideContent(s.content),
        notes: typeof s.notes === "string" ? s.notes : "",
        imageBrief: wanted,
        imageSide: (s.imageSide === "left" ? "left" : "right") as ImageSide,
        imageStatus,
        // Зеркально образу: схема живёт только на diagram-слайде,
        // на остальных spec — мусор модели, его не храним.
        diagramSpec: layout === "diagram" ? sanitizeDiagramSpec(s.diagramSpec) : null,
      };
    }),
  );

  const withImages = slides.filter((s) => s.imageBrief).length;

  // У вставленного текста названия нет, и до раскадровки его брали обрезком
  // первых знаков — в списке это выглядело как случайная фраза. Теперь, когда
  // обложка придумана, берём её заголовок: он и есть имя выступления.
  const coverTitle = sanitizeSlideContent(
    slides.find((sl) => sl.layout === "cover")?.content,
  ).title;
  const patch: { status: "storyboard_ready"; statusMessage: string; title?: string } = {
    status: "storyboard_ready",
    statusMessage: "",
  };
  if (deck.sourceKind === "raw" && coverTitle) patch.title = coverTitle;

  await db.update(decksTable).set(patch).where(eq(decksTable.id, id));

  logger.info({ id, slides: slides.length, withImages }, "Раскадровка готова");
}

async function onGiveUp(job: Job, message: string): Promise<void> {
  await db
    .update(decksTable)
    .set({ status: "error", statusMessage: "", error: message })
    .where(eq(decksTable.id, job.entityId))
    .catch((err) => logger.error({ err, id: job.entityId }, "Не смог записать ошибку презентации"));
}

export function registerStoryboardHandler(): void {
  registerHandler("deck.storyboard", { run, onGiveUp });
}
