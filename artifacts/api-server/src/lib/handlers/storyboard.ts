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
} from "@workspace/db";
import { askJson } from "../claude";
import { registerHandler } from "../jobs";
import { logger } from "../logger";

const LAYOUTS: SlideLayout[] = [
  "cover",
  "divider",
  "theory",
  "quote",
  "clinical",
  "comparison",
  "final",
  "diagram",
];

interface StoryboardSlide {
  layout: string;
  content: SlideContent;
  notes?: string;
  imageBrief?: string | null;
  imageSide?: string;
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
    `— Сначала определи ФУНКЦИЮ слайда. Только из списка: ${LAYOUTS.join(", ")}.`,
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
  ].join("\n");

  const result = await askJson<{ slides?: StoryboardSlide[] }>({
    system,
    user: `Название: ${source.title}\n\nТекст лекции:\n\n${source.text.slice(0, 120_000)}`,
    maxTokens: 16000,
  });

  const slides = (result.slides ?? []).filter((s) => s && typeof s === "object");
  if (slides.length === 0) throw new Error("Не удалось разложить материал по слайдам");

  await db.delete(deckSlidesTable).where(eq(deckSlidesTable.deckId, id));
  await db.insert(deckSlidesTable).values(
    slides.map((s, i) => {
      const layout: SlideLayout = LAYOUTS.includes(s.layout as SlideLayout)
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
        content: (s.content ?? {}) as SlideContent,
        notes: typeof s.notes === "string" ? s.notes : "",
        imageBrief: wanted,
        imageSide: (s.imageSide === "left" ? "left" : "right") as ImageSide,
        imageStatus,
      };
    }),
  );

  const withImages = slides.filter((s) => s.imageBrief).length;
  await db
    .update(decksTable)
    .set({ status: "storyboard_ready", statusMessage: "" })
    .where(eq(decksTable.id, id));

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
