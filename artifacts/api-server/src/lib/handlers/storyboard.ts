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
import { SLIDE_LAYOUTS, SLIDE_SPEC, layoutHasImage } from "@workspace/db/slides";
import { askJson } from "../claude";
import { fieldsLine, sanitizeSlideContent, settleContent } from "../slide-content";
import { joinChunks } from "../documents";
import { registerHandler } from "../jobs";
import { logger } from "../logger";

/** Больше модель не прочтёт с запасом на ответ; длиннее вставку ручка не примет. */
export const MAX_SOURCE_CHARS = 120_000;
/** Потолок слайдов в колоде — и в промпте, и при записи ответа. */
const MAX_SLIDES = 50;

/** Лекцию или документ удалили после того, как из них начали собирать колоду. */
export const SOURCE_GONE = "Источника больше нет — соберите презентацию заново";
/** Всё, что не наша фраза для экрана (английский SDK, код ответа, сбой базы). */
const MODEL_SILENT = "Модель не ответила";
const NOT_LAID_OUT = "Не удалось разложить материал по слайдам";
export const NO_PACK = "Стилевой пакет не найден";

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
 * только известные поля, обрезка длин (label 60, sub 120), не больше
 * SLIDE_SPEC.diagram.maxItems шагов — столько встаёт на лист во всех движках.
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
    if (clean.length === SLIDE_SPEC.diagram.maxItems) break;
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
    if (!lecture || lecture.ownerId !== ownerId) throw new Error(SOURCE_GONE);

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
    if (!doc || doc.ownerId !== ownerId) throw new Error(SOURCE_GONE);

    const chunks = await db
      .select()
      .from(docChunksTable)
      .where(eq(docChunksTable.documentId, sourceId))
      .orderBy(asc(docChunksTable.ord));

    return { title: doc.title, text: joinChunks(chunks) };
  }

  throw new Error(SOURCE_GONE);
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
    `— Сколько слайдов нужно, решаешь ты по материалу — но НЕ БОЛЬШЕ ${MAX_SLIDES}.`,
    "  Дроби мысль мелко: один слайд — одна концентрированная мысль, а не пересказ раздела.",
    "  Полной лекции обычно нужны 35–50 слайдов; короткому тексту хватит и дюжины. Хвост не отбрасывай.",
    "",
    // Порядок из брендбука: сперва функция слайда, из неё — композиция.
    // Поэтому в layout идёт задача, а не вёрстка.
    `— Сначала определи ФУНКЦИЮ слайда. Только из списка: ${SLIDE_LAYOUTS.join(", ")}.`,
    "  cover — обложка, divider — разделитель части, theory — теория,",
    "  quote — цитата, clinical — клинический фрагмент (случай, сцена, материал),",
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
    "— На слайдах с макетом diagram и final картинок не бывает: на diagram структуру рисуют схемой, final — только текст.",
    "— На clinical образ — интерьер, объект или сцена, но НЕ портрет человека.",
    "— Не повторяй один и тот же образ: чередуй человека, интерьер, предмет, анатомический фрагмент, пустое поле.",
    "",
    "Метки вида [[PER1]], [[LOC1]] — скрытые имена и места: не раскрывай их и не выдумывай имён, говори обезличенно, сами метки на слайды не переноси.",
    "",
    'Формат ответа: {"slides":[{"layout":"...","content":{...},"notes":"...","imageBrief":null,"imageSide":"right"}]}',
    "В content — только поля своей функции:",
    ...SLIDE_LAYOUTS.map((l) => `  ${l}: ${fieldsLine(l)}`),
    'На diagram-слайде заполни ещё "diagramSpec": {"kind":"flow"|"pillars","items":[{"label":"...","sub":"..."}]} —',
    `2–${SLIDE_SPEC.diagram.maxItems} шага, label до 60 знаков, sub — необязательная расшифровка до 120. flow — последовательность`,
    "(этапы, стрелки сверху вниз), pillars — рядоположные опоры колонками. Другим слайдам diagramSpec не нужен.",
  ].join("\n");

  // Вставку длиннее ручка не принимает; книга из библиотеки бывает длиннее —
  // тогда хвост модель не увидит, и об этом должен остаться след.
  if (source.text.length > MAX_SOURCE_CHARS) {
    logger.warn({ id, chars: source.text.length, cap: MAX_SOURCE_CHARS }, "Материал длиннее потолка — хвост не попадёт в слайды");
  }

  // Полсотни слайдов с заметками по-русски — это до ~40 тысяч токенов,
  // и модель думает в счёт того же лимита. Потолок с запасом; ask() идёт
  // потоком, так что длинная генерация не упирается в таймауты.
  const result = await askJson<{ slides?: StoryboardSlide[] }>({
    system,
    user: `Название: ${source.title}\n\nТекст лекции:\n\n${source.text.slice(0, MAX_SOURCE_CHARS)}`,
    maxTokens: 64000,
  });

  const parsed = (result.slides ?? []).filter((s) => s && typeof s === "object");
  if (parsed.length === 0) throw new Error(NOT_LAID_OUT);
  if (parsed.length > MAX_SLIDES) {
    logger.warn({ id, got: parsed.length, cap: MAX_SLIDES }, "Слайдов больше потолка — обрезаю");
  }
  const slides = parsed.slice(0, MAX_SLIDES);

  // Пересборка заменяет слайды целиком. Прежние слайды (и их картинки по
  // каскаду) не пропадают: строки уходят в архив триггером, файлы картинок
  // остаются на диске и в архиве файлов.
  await db.delete(deckSlidesTable).where(eq(deckSlidesTable.deckId, id));
  await db.insert(deckSlidesTable).values(
    slides.map((s, i) => {
      const asked: SlideLayout = SLIDE_LAYOUTS.includes(s.layout as SlideLayout)
        ? (s.layout as SlideLayout)
        : "theory";
      // Зеркально образу: схема живёт только на diagram-слайде, на остальных
      // spec — мусор модели. А схема без годного spec рисуется теорией —
      // тогда и храним её теорией: автор правит ровно то, что видно.
      const diagramSpec = asked === "diagram" ? sanitizeDiagramSpec(s.diagramSpec) : null;
      const layout: SlideLayout = asked === "diagram" && !diagramSpec ? "theory" : asked;
      const brief = typeof s.imageBrief === "string" && s.imageBrief.trim() !== ""
        ? s.imageBrief.trim()
        : null;
      // Образ только там, где макет его показывает: на схеме он помешает
      // структуре, финал выводит один текст — картинку оплатили бы зря.
      const wanted = layoutHasImage(layout) ? brief : null;
      const imageStatus: ImageStatus = wanted ? "queued" : "none";
      return {
        deckId: id,
        ord: i,
        layout,
        content: settleContent(layout, sanitizeSlideContent(s.content)),
        notes: typeof s.notes === "string" ? s.notes : "",
        imageBrief: wanted,
        imageSide: (s.imageSide === "left" ? "left" : "right") as ImageSide,
        imageStatus,
        diagramSpec,
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
  // Не длиннее, чем принимает переименование, — иначе то же имя не сохранить.
  if (deck.sourceKind === "raw" && coverTitle) patch.title = coverTitle.slice(0, 200);

  await db.update(decksTable).set(patch).where(eq(decksTable.id, id));

  logger.info({ id, slides: slides.length, withImages }, "Раскадровка готова");
}

/** Свои фразы раскадровки и отрисовки — их автор видит как есть. */
const SHOWN: readonly string[] = [SOURCE_GONE, NOT_LAID_OUT, NO_PACK];

/**
 * Текст ошибки для экрана. Своя фраза — как есть, всё прочее — одной
 * человеческой фразой: подробности уже в журнале очереди.
 */
export const shownError = (message: string, own: readonly string[]): string =>
  own.includes(message) ? message : MODEL_SILENT;

/** Задача колоды сдалась — колода в ошибке; так же падает и отрисовка образов. */
export async function onGiveUp(job: Job, message: string): Promise<void> {
  await db
    .update(decksTable)
    .set({ status: "error", statusMessage: "", error: shownError(message, SHOWN) })
    .where(eq(decksTable.id, job.entityId))
    .catch((err) => logger.error({ err, id: job.entityId }, "Не смог записать ошибку презентации"));
}

export function registerStoryboardHandler(): void {
  registerHandler("deck.storyboard", { run, onGiveUp });
}
