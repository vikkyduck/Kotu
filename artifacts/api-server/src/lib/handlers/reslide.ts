import { eq } from "drizzle-orm";
import {
  db,
  decksTable,
  deckSlidesTable,
  type Job,
  type DeckStatus,
  type SlideContent,
} from "@workspace/db";
import { askJson } from "../claude";
import { sanitizeSlideContent } from "../slide-content";
import { registerHandler } from "../jobs";
import { deckToLibrary } from "../work-doc";
import { logger } from "../logger";

/**
 * Переделка ОДНОГО слайда словами автора. Отдельная задача, а не синхронный
 * вызов в ручке: модель думает десятки секунд, а nginx рвёт запрос раньше.
 * Заодно правка переживает перезагрузку страницы, как и вся остальная работа.
 */
interface ReslidePayload {
  slideId: number;
  instruction: string;
  /** Куда вернуть колоду, когда слайд переписан: правка статуса не меняет. */
  back: DeckStatus;
}

interface ReslideReply {
  content?: SlideContent;
  notes?: string;
}

/** Задача пришла из очереди — форму payload проверяем, а не верим на слово. */
function readPayload(raw: unknown): ReslidePayload {
  const p = (raw ?? {}) as Record<string, unknown>;
  const slideId = Number(p["slideId"]);
  if (!Number.isInteger(slideId)) throw new Error("В задаче правки нет слайда");
  const instruction = typeof p["instruction"] === "string" ? p["instruction"] : "";
  if (instruction.trim() === "") throw new Error("В задаче правки нет указания автора");
  // Куда вернуть колоду. Неизвестное значение — «готова»: тупика быть не должно.
  const back = p["back"] === "storyboard_ready" ? "storyboard_ready" : "ready";
  return { slideId, instruction, back };
}

/** Какие поля осмысленны на этом макете — чтобы модель не выдумывала лишних. */
const FIELDS: Record<string, string> = {
  cover: "eyebrow, title, subtitle",
  divider: "eyebrow, title",
  theory: "title, bullets[] (3–5 коротких), question, plate",
  quote: "quote (до 35 слов), attribution",
  clinical: "title, bullets[] (абзацы фрагмента), question",
  comparison: "title, cards[] — ровно две карточки {title, body}",
  final: "title, subtitle",
  diagram: "title",
};

async function run(job: Job): Promise<void> {
  const deckId = job.entityId;
  const payload = readPayload(job.payload);

  const [deck] = await db.select().from(decksTable).where(eq(decksTable.id, deckId)).limit(1);
  if (!deck) throw new Error("Презентация не найдена");

  const [slide] = await db
    .select()
    .from(deckSlidesTable)
    .where(eq(deckSlidesTable.id, payload.slideId))
    .limit(1);
  // Слайд мог исчезнуть вместе с новой раскадровкой — это не ошибка автора.
  if (!slide || slide.deckId !== deckId) {
    logger.warn({ deckId, slideId: payload.slideId }, "Слайд для правки не найден — пропускаю");
    return;
  }

  await db
    .update(decksTable)
    .set({ status: "storyboarding", statusMessage: "Переделываю слайд…", error: null })
    .where(eq(decksTable.id, deckId));

  const system = [
    "Ты правишь ОДИН слайд презентации по психоанализу на русском языке.",
    "Автор говорит, что изменить. Сделай ровно это и ничего сверх.",
    "",
    "Правила слайда:",
    "— Слайд держит одну мысль. Тезисы короткие: это опора для речи, а не текст для чтения вслух.",
    "— Основного текста не больше 6–8 строк.",
    "— notes — заметки докладчику: то, что автор скажет голосом.",
    `— Функция слайда: ${slide.layout}. Осмысленные поля: ${FIELDS[slide.layout] ?? "title, bullets[]"}.`,
    "— Функцию слайда не меняй: её меняет автор руками.",
    "— Поле, которого автор не касался, оставь прежним, слово в слово.",
    "",
    'Ответ СТРОГО JSON: {"content": {…}, "notes": "…"} — целиком новый слайд, а не список изменений.',
    "content: eyebrow, title, subtitle, bullets[], cards[{title,body}], quote, attribution, question, plate.",
    "Ненужные этому макету поля просто не включай.",
  ].join("\n");

  const user = [
    `Сейчас на слайде:\n${JSON.stringify(slide.content, null, 2)}`,
    `Заметки докладчику:\n${slide.notes || "(пусто)"}`,
    `Что просит автор:\n${payload.instruction}`,
  ].join("\n\n");

  const reply = await askJson<ReslideReply>({ system, user, maxTokens: 4000 });

  const content = sanitizeSlideContent(reply.content);
  // Пустой ответ — это потеря слайда, а не правка: лучше честная ошибка.
  if (Object.keys(content).length === 0) {
    throw new Error("Не удалось переделать слайд — попробуйте сказать иначе");
  }

  await db
    .update(deckSlidesTable)
    .set({
      content,
      notes: typeof reply.notes === "string" ? reply.notes.slice(0, 20_000) : slide.notes,
    })
    .where(eq(deckSlidesTable.id, slide.id));

  await db
    .update(decksTable)
    .set({ status: payload.back, statusMessage: "", error: null })
    .where(eq(decksTable.id, deckId));

  // Текст изменился — копия в поиске не должна отставать.
  await deckToLibrary(deckId).catch(() => undefined);

  logger.info({ deckId, slideId: slide.id }, "Слайд переделан по указанию автора");
}

async function onGiveUp(job: Job, message: string): Promise<void> {
  // Колоду не роняем в error: слайды целы, не получилась только правка.
  // Возвращаем туда, откуда пришли, и говорим, что не вышло. Payload здесь
  // читаем сами, а не через readPayload: задача могла упасть как раз на нём,
  // и тогда колода осталась бы навсегда в состоянии «работаю».
  const back =
    (job.payload as Record<string, unknown> | null)?.["back"] === "storyboard_ready"
      ? "storyboard_ready"
      : "ready";
  await db
    .update(decksTable)
    .set({ status: back, statusMessage: "", error: message })
    .where(eq(decksTable.id, job.entityId))
    .catch((err) => logger.error({ err, id: job.entityId }, "Не смог записать ошибку правки"));
}

export function registerReslideHandler(): void {
  registerHandler("deck.reslide", { run, onGiveUp });
}
