import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  db,
  decksTable,
  deckSlidesTable,
  deckImagesTable,
  stylePacksTable,
  type Job,
  type DeckSlide,
  type StylePack,
  type ImageSide,
} from "@workspace/db";
import { ask, type ImageAttachment } from "../claude";
import { geminiJson } from "../gemini";
import { renderIllustration } from "../images";
import { registerHandler, enqueue } from "../jobs";
import { DECKS_DIR } from "../paths";
import { deckToLibrary } from "../work-doc";
import { logger } from "../logger";

/** Потолок перерисовок: после второй попытки слайд идёт с тем, что есть. */
const MAX_ATTEMPTS = 2;
/** Потолок образов за один прогон — верхняя граница счёта за колоду. */
const MAX_IMAGES = 12;

/**
 * Картинки лежат на диске, а не в базе: их десятки мегабайт на колоду.
 * В проде — постоянный каталог, в разработке — tmp, чтобы не мусорить.
 */
interface IllustratePayload {
  slideIds?: number[];
  instruction?: string;
}

interface DirectorReply {
  scene: string;
  secondMetaphor: string;
}

interface ReviewReply {
  accept: boolean;
  verdict: string;
}

/**
 * Тот же разбор, что в askJson из ../claude: модель любит обернуть ответ
 * в ```json или добавить фразу вокруг — срезаем и вынимаем сам объект.
 */
function parseJsonReply<T>(raw: string): T {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        // Наружу — только человеческая формулировка, не сырой SyntaxError.
      }
    }
    throw new Error("Приёмка вернула ответ, который не удалось разобрать как JSON");
  }
}

/**
 * Шаг режиссуры. Двухшаговая генерация обязательна — проверено: если просить
 * картинку сразу по мысли слайда, модель рисует штампы. Сначала отдельная
 * модель придумывает конкретный сюжет, и только он уходит художнику.
 */
async function direct(
  slide: DeckSlide,
  pack: StylePack,
  instruction: string | undefined,
  rejectedVerdict: string | null,
): Promise<DirectorReply> {
  const families = pack.rules?.metaphorFamilies ?? ["anatomy", "archive", "dream"];
  const maxMetaphors = pack.rules?.maxMetaphorsPerImage ?? 2;

  const system = [
    "Ты — визуальный режиссёр серии иллюстраций «Архивный сон» к лекциям по психоанализу.",
    `Метафорические системы серии: ${families.join(", ")}. В одном образе соединяй не больше ${maxMetaphors}.`,
    "Странность рождается из точности, а не из спецэффекта. Сновидчески, но не страшно.",
    `Запрещённые клише: ${pack.negative}`,
    "Сюжет пиши по-английски: конкретный и предметный — объекты, свет, композиция, без абстракций.",
    'Ответ СТРОГО JSON: {"scene": "...", "secondMetaphor": "..."} — обе строки по-английски.',
    "scene — сюжет образа одним-двумя предложениями. secondMetaphor — вторая метафорическая деталь, она уйдёт в стилевой промпт.",
  ].join("\n");

  const user = [`Мысль слайда: ${slide.imageBrief}`, `Функция слайда: ${slide.layout}`];
  if (instruction) user.push(`Пожелание автора: ${instruction}`);
  if (rejectedVerdict) user.push(`Прошлая попытка отклонена приёмкой: ${rejectedVerdict}`);

  const reply = await geminiJson<DirectorReply>({ system, user: user.join("\n") });
  if (typeof reply.scene !== "string" || reply.scene.trim() === "") {
    throw new Error("Режиссура не придумала сюжет");
  }
  return {
    scene: reply.scene.trim(),
    secondMetaphor: typeof reply.secondMetaphor === "string" ? reply.secondMetaphor.trim() : "",
  };
}

/** Финальный промпт: сюжет + мастер-промпт стиля с подстановками. */
function buildPrompt(reply: DirectorReply, side: ImageSide, pack: StylePack): string {
  const suffix = pack.promptSuffix
    .replaceAll("{{SECOND_METAPHOR}}", reply.secondMetaphor)
    .replaceAll("{{IMAGE_SIDE}}", side === "left" ? "on the LEFT" : "on the RIGHT")
    // Спокойное поле под типографику — на стороне, противоположной образу.
    .replaceAll("{{SAFE_SIDE}}", side === "left" ? "RIGHT" : "LEFT");
  return `${reply.scene}, ${suffix}\n\nDo NOT include: ${pack.negative}`;
}

/**
 * Приёмка готовой картинки. Смотрит Claude: проверяет мысль и композицию,
 * а не красоту — красоту уже задал стилевой пакет.
 */
async function reviewImage(
  slide: DeckSlide,
  filePath: string,
  mime: ImageAttachment["mediaType"],
): Promise<ReviewReply> {
  const safeSide = slide.imageSide === "left" ? "СПРАВА" : "СЛЕВА";
  const system = [
    "Ты — приёмщик иллюстраций серии «Архивный сон». Оцени картинку строго.",
    "Проверь:",
    "— передаёт ли образ МЫСЛЬ слайда;",
    "— винтажная гравюра/офорт, музейная сдержанность;",
    `— спокойное поле около 40% ${safeSide} — оно нужно под типографику;`,
    "— нет текста, букв, рамок, хоррора, шестерёнок, неона.",
    'Ответ СТРОГО JSON: {"accept": true|false, "verdict": "одно-два предложения по-русски: что так или не так"}.',
  ].join("\n");

  const raw = await ask({
    system,
    user: `Мысль слайда: ${slide.imageBrief}`,
    images: [{ path: filePath, mediaType: mime }],
  });

  const reply = parseJsonReply<ReviewReply>(raw);
  return {
    accept: reply.accept === true,
    verdict: typeof reply.verdict === "string" ? reply.verdict : "",
  };
}

/** Один слайд: режиссура → рендер → приёмка, до двух попыток. */
async function illustrateSlide(
  deckId: number,
  slide: DeckSlide,
  pack: StylePack,
  instruction: string | undefined,
): Promise<void> {
  if (!slide.imageBrief) throw new Error("У слайда нет мысли для образа");

  let rejectedVerdict: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const reply = await direct(slide, pack, instruction, rejectedVerdict);
    const prompt = buildPrompt(reply, slide.imageSide, pack);

    const [row] = await db
      .insert(deckImagesTable)
      .values({ deckId, slideId: slide.id, attempt, scene: reply.scene, prompt, status: "drawing" })
      .returning();

    try {
      const art = await renderIllustration(prompt);
      // Колоду могли удалить, пока рисовалась картинка (это минуты). Тогда
      // не воссоздаём каталог — иначе на диске оставался бы файл-сирота,
      // которого уже никто не удалит.
      const [alive] = await db
        .select({ id: decksTable.id })
        .from(decksTable)
        .where(eq(decksTable.id, deckId))
        .limit(1);
      if (!alive) throw new Error("Презентация удалена");
      const dir = path.join(DECKS_DIR, String(deckId));
      await mkdir(dir, { recursive: true });
      // Расширение — по настоящему формату: Anthropic сверяет заявленный
      // тип с байтами, а PowerPoint выбирает кодек по имени файла.
      const filePath = path.join(dir, `${row.id}.${art.ext}`);
      await writeFile(filePath, art.buffer);
      await db
        .update(deckImagesTable)
        .set({ path: filePath, provider: art.provider, model: art.model })
        .where(eq(deckImagesTable.id, row.id));

      // Приёмка упала (модель молчит) — картинка уже оплачена и на диске;
      // ставим её без проверки, а не сжигаем вторую попытку впустую.
      const review = await reviewImage(slide, filePath, art.mime).catch((err) => {
        logger.warn({ err, slideId: slide.id }, "Приёмка недоступна — образ пойдёт без проверки");
        return { accept: true, verdict: "Приёмка была недоступна — образ поставлен без проверки" };
      });
      await db
        .update(deckImagesTable)
        .set({ status: review.accept ? "ready" : "rejected", verdict: review.verdict })
        .where(eq(deckImagesTable.id, row.id));

      if (review.accept || attempt === MAX_ATTEMPTS) {
        // Принято — хорошо; не принято на последней попытке — слайд всё равно
        // идёт с тем, что есть, а вердикт остаётся на виду как «стоит посмотреть».
        await db
          .update(deckSlidesTable)
          .set({ imageId: row.id, imageStatus: "ready" })
          .where(eq(deckSlidesTable.id, slide.id));
        return;
      }
      rejectedVerdict = review.verdict;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(deckImagesTable)
        .set({ status: "error", error: message })
        .where(eq(deckImagesTable.id, row.id))
        .catch((rowErr) =>
          logger.error({ rowErr, imageId: row.id }, "Не смог пометить попытку ошибкой"),
        );
      throw err;
    }
  }
}

async function run(job: Job): Promise<void> {
  const id = job.entityId;
  const [deck] = await db.select().from(decksTable).where(eq(decksTable.id, id)).limit(1);
  if (!deck) throw new Error("Презентация не найдена");
  if (!deck.storyboardApproved) throw new Error("Раскадровка ещё не утверждена");

  const payload = job.payload as IllustratePayload;

  // Перерисовка приходит с конкретными слайдами; первый прогон берёт все,
  // где автор оставил образ, — включая упавшие в прошлый раз.
  // Статус 'drawing' в выборке — след прошлого рестарта посреди слайда:
  // без него такой слайд навсегда выпадал бы из перерисовок.
  const pending = ["queued", "error", "drawing"] as const;
  const allTargets = payload.slideIds?.length
    ? await db
        .select()
        .from(deckSlidesTable)
        .where(
          and(
            eq(deckSlidesTable.deckId, id),
            inArray(deckSlidesTable.id, payload.slideIds),
            isNotNull(deckSlidesTable.imageBrief),
            // Ретрай упавшей задачи не должен перерисовывать то, что успело
            // дорисоваться до падения.
            inArray(deckSlidesTable.imageStatus, [...pending]),
          ),
        )
        .orderBy(asc(deckSlidesTable.ord))
    : await db
        .select()
        .from(deckSlidesTable)
        .where(
          and(
            eq(deckSlidesTable.deckId, id),
            isNotNull(deckSlidesTable.imageBrief),
            inArray(deckSlidesTable.imageStatus, [...pending]),
          ),
        )
        .orderBy(asc(deckSlidesTable.ord));

  const slides = allTargets.slice(0, MAX_IMAGES);
  if (allTargets.length > slides.length) {
    logger.warn(
      { deckId: id, total: allTargets.length, cap: MAX_IMAGES },
      "Образов больше потолка прогона — хвост дорисует следующая задача",
    );
  }

  // Стиль живёт в базе, а не в коде: это вопрос вкуса автора. Без пакета
  // рисовать нечем — нет ни мастер-промпта, ни запретов.
  const [pack] = deck.stylePackId
    ? await db
        .select()
        .from(stylePacksTable)
        .where(eq(stylePacksTable.id, deck.stylePackId))
        .limit(1)
    : await db.select().from(stylePacksTable).orderBy(asc(stylePacksTable.id)).limit(1);
  if (!pack) throw new Error("Стилевой пакет не найден");

  await db.update(decksTable).set({ status: "drawing", error: null }).where(eq(decksTable.id, id));

  let drawn = 0;
  for (const [i, slide] of slides.entries()) {
    await db
      .update(decksTable)
      .set({ statusMessage: `Рисую образ ${i + 1} из ${slides.length}…` })
      .where(eq(decksTable.id, id));
    await db
      .update(deckSlidesTable)
      .set({ imageStatus: "drawing" })
      .where(eq(deckSlidesTable.id, slide.id));

    try {
      await illustrateSlide(id, slide, pack, payload.instruction);
      drawn += 1;
    } catch (err) {
      // Один упавший образ не должен останавливать остальные: помечаем слайд
      // и рисуем дальше.
      logger.error({ deckId: id, slideId: slide.id, err }, "Образ не нарисовался");
      await db
        .update(deckSlidesTable)
        .set({ imageStatus: "error" })
        .where(eq(deckSlidesTable.id, slide.id));
    }
  }

  // За потолком прогона остались нетронутые слайды — продолжаем следующей
  // задачей, иначе хвост большой колоды навсегда завис бы в «queued».
  // Только при прогрессе (drawn > 0): без него цепочка на вечно падающих
  // слайдах крутилась бы бесконечно и жгла деньги.
  if (!payload.slideIds?.length && allTargets.length > slides.length && drawn > 0) {
    await enqueue("deck.illustrate", id, { instruction: payload.instruction });
    logger.info(
      { deckId: id, leftover: allTargets.length - slides.length },
      "Образы сверх потолка прогона — продолжаю следующей задачей",
    );
    return;
  }

  if (slides.length === 0 || drawn > 0 || payload.slideIds?.length) {
    // Частичные ошибки не валят колоду: показываем автору то, что вышло.
    // Перерисовка тем более не роняет готовую колоду — слайд с ошибкой виден.
    await db
      .update(decksTable)
      .set({ status: "ready", statusMessage: "", error: null })
      .where(eq(decksTable.id, id));
    // Готовая колода — тоже материал: её текст ложится в библиотеку сам.
    await deckToLibrary(id).catch((err) =>
      logger.error({ err, id }, "Не смог отправить презентацию в библиотеку"),
    );
    logger.info({ id, drawn, of: slides.length }, "Образы готовы");
  } else {
    await db
      .update(decksTable)
      .set({
        status: "error",
        statusMessage: "",
        error: "Не удалось нарисовать образы — попробуйте ещё раз",
      })
      .where(eq(decksTable.id, id));
  }
}

async function onGiveUp(job: Job, message: string): Promise<void> {
  await db
    .update(decksTable)
    .set({ status: "error", statusMessage: "", error: message })
    .where(eq(decksTable.id, job.entityId))
    .catch((err) => logger.error({ err, id: job.entityId }, "Не смог записать ошибку презентации"));
}

export function registerIllustrateHandler(): void {
  registerHandler("deck.illustrate", { run, onGiveUp });
}
