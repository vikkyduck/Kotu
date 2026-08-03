import { eq, asc } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server/audio";
import {
  db,
  lecturesTable,
  lectureSectionsTable,
  lectureSourcesTable,
  type Job,
  type LectureBrief,
  type PlannedSection,
} from "@workspace/db";
import { searchLibrary } from "../../routes/documents";
import { embedAll } from "../embeddings";
import { research, isResearchAvailable, type WebSource } from "../perplexity";
import { registerHandler, enqueue } from "../jobs";
import { lectureToLibrary } from "../work-doc";
import { logger } from "../logger";

const MODEL = process.env["MODEL_LECTURE"] ?? "gpt-5";

/** Сколько фрагментов библиотеки даём модели на одну главу. */
const CHUNKS_PER_SECTION = 10;

interface Excerpt {
  n: number;
  chunkId: number;
  title: string;
  heading: string | null;
  text: string;
}

/** Ищет в библиотеке под конкретный запрос и нумерует найденное для ссылок. */
async function findExcerpts(
  ownerId: number,
  query: string,
  documentIds: number[],
  limit: number,
): Promise<Excerpt[]> {
  const [vector] = await embedAll([query], undefined, "query");
  const found = await searchLibrary(ownerId, vector, query, limit, documentIds);
  return found.map((f, i) => ({
    n: i + 1,
    chunkId: f.id,
    title: f.title,
    heading: f.heading,
    text: f.text,
  }));
}

function renderExcerpts(excerpts: Excerpt[]): string {
  return excerpts
    .map((e) => `[${e.n}] ${e.title}${e.heading ? ` — ${e.heading}` : ""}\n${e.text}`)
    .join("\n\n---\n\n");
}

async function setStatus(id: number, message: string): Promise<void> {
  await db.update(lecturesTable).set({ statusMessage: message }).where(eq(lecturesTable.id, id));
}

// ─── Шаг 1: план ──────────────────────────────────────────────────────────

async function runPlan(job: Job): Promise<void> {
  const id = job.entityId;
  const [lecture] = await db.select().from(lecturesTable).where(eq(lecturesTable.id, id)).limit(1);
  if (!lecture) throw new Error("Лекция не найдена");

  const brief = lecture.brief as LectureBrief;
  await db
    .update(lecturesTable)
    .set({ status: "planning", statusMessage: "Смотрю, что есть в библиотеке…", error: null })
    .where(eq(lecturesTable.id, id));

  // Режим исследования: материал собирает модель, библиотека не обязательна.
  const isResearch = brief.mode === "research";
  let material = "";
  if (isResearch) {
    if (isResearchAvailable()) {
      await setStatus(id, "Исследую тему в веб-источниках…");
      const found = await research(
        `Тема лекции по психоанализу: ${brief.topic}. Собери материал для плана лекции.`,
      ).catch((err) => {
        logger.warn({ err }, "Веб-поиск не ответил — планирую по знаниям модели");
        return null;
      });
      if (found) material = found.summary;
    }
  } else {
    const excerpts = await findExcerpts(lecture.ownerId, brief.topic, brief.documentIds, 14);
    material = renderExcerpts(excerpts);
  }

  await setStatus(id, "Продумываю структуру…");

  // Ориентир: примерно 12 минут речи на главу — так шестичасовая лекция
  // не превращается в три необъятных куска.
  const target = Math.max(3, Math.min(14, Math.round(brief.durationMin / 12)));

  const system = [
    "Ты помогаешь преподавателю психоанализа спланировать лекцию на русском языке.",
    isResearch
      ? "Тебе дан замысел лекции" + (material ? " и материал веб-исследования по теме." : ". Материала нет — опирайся на устоявшиеся знания психоанализа: классические работы, признанных авторов.")
      : "Тебе дан замысел лекции и выдержки из личной библиотеки автора.",
    `Составь план примерно из ${target} глав на ${brief.durationMin} минут для аудитории: ${brief.audience}.`,
    isResearch
      ? "План должен быть конкретным: понятия, авторы, работы — не «обзор темы вообще»."
      : "Опирайся на выдержки: план должен быть про то, что в них есть, а не про тему вообще.",
    "Главы идут от простого к сложному, каждая продолжает предыдущую, без повторов.",
    'Верни СТРОГО JSON: {"sections":[{"heading":"...","abstract":"..."}]}.',
    "heading — короткий заголовок главы. abstract — два-три предложения о том, что внутри.",
  ];
  if (brief.mustInclude) system.push(`Обязательно включи: ${brief.mustInclude}`);
  if (brief.mustAvoid) system.push(`Не включай: ${brief.mustAvoid}`);

  const response = await openai.chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system.join("\n") },
      {
        role: "user",
        content:
          `Замысел лекции:\n${brief.topic}` +
          (material
            ? `\n\n${isResearch ? "Материал веб-исследования" : "Выдержки из библиотеки"}:\n\n${material}`
            : ""),
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "";
  let sections: PlannedSection[] = [];
  try {
    const parsed = JSON.parse(raw) as { sections?: unknown };
    if (Array.isArray(parsed.sections)) {
      sections = parsed.sections
        .map((s) => {
          const o = s as Record<string, unknown>;
          return {
            heading: typeof o.heading === "string" ? o.heading : "",
            abstract: typeof o.abstract === "string" ? o.abstract : "",
          };
        })
        .filter((s) => s.heading.trim() !== "");
    }
  } catch {
    throw new Error("Модель вернула план в непонятном виде. Попробуйте ещё раз.");
  }

  if (sections.length === 0) throw new Error("Не удалось составить план");

  await db
    .update(lecturesTable)
    .set({ plan: sections, status: "plan_ready", statusMessage: "" })
    .where(eq(lecturesTable.id, id));

  logger.info({ id, sections: sections.length }, "План лекции готов");
}

// ─── Шаг 2: написание глав ────────────────────────────────────────────────

async function runWrite(job: Job): Promise<void> {
  const id = job.entityId;
  const [lecture] = await db.select().from(lecturesTable).where(eq(lecturesTable.id, id)).limit(1);
  if (!lecture) throw new Error("Лекция не найдена");
  if (!lecture.planApproved) throw new Error("План ещё не утверждён");

  const brief = lecture.brief as LectureBrief;
  await db
    .update(lecturesTable)
    .set({ status: "writing", error: null })
    .where(eq(lecturesTable.id, id));

  const sections = await db
    .select()
    .from(lectureSectionsTable)
    .where(eq(lectureSectionsTable.lectureId, id))
    .orderBy(asc(lectureSectionsTable.ord));

  const total = sections.length;

  /**
   * Объём главы считаем от заказанной длительности, а не берём из головы.
   * Лекцию читают примерно 125 слов в минуту. Если план вышел короче
   * задуманного, главы становятся длиннее и лекция всё равно занимает
   * заказанное время. Потолок в 1800 слов — за ним качество текста падает.
   */
  const wordsPerSection = Math.max(
    600,
    Math.min(1800, Math.round((brief.durationMin * 125) / Math.max(1, total))),
  );

  for (const section of sections) {
    // Правку автора не трогаем и заново не пишем.
    if (section.editedByHuman || section.status === "ready") continue;

    await setStatus(id, `Пишу главу ${section.ord + 1} из ${total}: ${section.heading}`);
    await db
      .update(lectureSectionsTable)
      .set({ status: "writing" })
      .where(eq(lectureSectionsTable.id, section.id));

    const query = `${section.heading}. ${section.abstract}`;
    const isResearch = brief.mode === "research";

    // Материал главы — по режиму: выдержки библиотеки, веб-исследование
    // или честное «пишем по знаниям модели», если поиск не настроен.
    let excerpts: Excerpt[] = [];
    let webSources: WebSource[] = [];
    let material = "";
    let materialLabel = "Выдержки из библиотеки";

    if (!isResearch) {
      excerpts = await findExcerpts(lecture.ownerId, query, brief.documentIds, CHUNKS_PER_SECTION);
      material = renderExcerpts(excerpts);
    } else if (isResearchAvailable()) {
      await setStatus(id, `Исследую главу ${section.ord + 1} из ${total}: ${section.heading}`);
      const found = await research(
        `Глава лекции по психоанализу: «${section.heading}». О чём она: ${section.abstract}. ` +
          `Тема всей лекции: ${brief.topic}. Собери материал для этой главы.`,
      ).catch((err) => {
        logger.warn({ err, sectionId: section.id }, "Веб-поиск не ответил — пишу по знаниям модели");
        return null;
      });
      if (found) {
        webSources = found.sources;
        materialLabel = "Материал веб-исследования (ссылки [n] — на источники ниже)";
        material =
          found.summary +
          (found.sources.length > 0
            ? "\n\nИсточники:\n" + found.sources.map((w) => `[${w.n}] ${w.title} — ${w.url}`).join("\n")
            : "");
      }
    }

    await setStatus(id, `Пишу главу ${section.ord + 1} из ${total}: ${section.heading}`);

    const system = [
      "Ты пишешь главу лекции по психоанализу на русском языке для преподавателя.",
      `Аудитория: ${brief.audience}. Это часть лекции «${lecture.title}».`,
      "Пиши живым устным языком, как говорят с кафедры: без канцелярита и без academese.",
      ...(material !== ""
        ? [
            "Опирайся ТОЛЬКО на предоставленный материал. Не выдумывай фактов, дат, имён и цитат.",
            "Если в материале нет нужного — просто не пиши об этом, не додумывай.",
            "Когда опираешься на фрагмент материала, ставь ссылку в квадратных скобках: [1], [2].",
            "Ссылку ставь сразу после утверждения, к которому она относится.",
            "Не пересказывай материал подряд — выстрой связное рассуждение.",
          ]
        : [
            // Поиска нет: пишем по устоявшимся знаниям, без имитации точности.
            "Опирайся на устоявшиеся знания психоанализа: классические работы и признанных авторов.",
            "НЕ выдумывай дословных цитат, точных дат и номеров страниц.",
            "Работы упоминай по названию только там, где уверен. Ссылок [n] не ставь.",
          ]),
      "Не повторяй заголовок главы в начале текста.",
      `Объём: примерно ${wordsPerSection} слов — это ${Math.round(wordsPerSection / 125)} минут звучащей речи.`,
      "Разворачивай мысль: примеры, оговорки, переходы — так, как говорят на лекции, а не тезисами.",
      "Верни только текст главы, без JSON и пояснений.",
    ];

    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: system.join("\n") },
        {
          role: "user",
          content:
            `Глава: ${section.heading}\nО чём она: ${section.abstract}` +
            (material !== "" ? `\n\n${materialLabel}:\n\n${material}` : ""),
        },
      ],
    });

    const text = (response.choices[0]?.message?.content ?? "").trim();
    if (text === "") throw new Error(`Глава «${section.heading}» вышла пустой`);

    await db
      .update(lectureSectionsTable)
      .set({ text, status: "ready" })
      .where(eq(lectureSectionsTable.id, section.id));

    // Записываем только те источники, на которые модель реально сослалась:
    // так под текстом стоят проверяемые цитаты, а не список «что мы читали».
    const cited = new Set(
      [...text.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])).filter((n) => n > 0),
    );
    await db.delete(lectureSourcesTable).where(eq(lectureSourcesTable.sectionId, section.id));

    if (excerpts.length > 0) {
      const used = excerpts.filter((e) => cited.has(e.n));
      if (used.length > 0) {
        await db.insert(lectureSourcesTable).values(
          used.map((e) => ({
            lectureId: id,
            sectionId: section.id,
            kind: "doc" as const,
            chunkId: e.chunkId,
            title: e.heading ? `${e.title} — ${e.heading}` : e.title,
            quote: e.text.slice(0, 600),
          })),
        );
      }
    } else if (webSources.length > 0) {
      // Веб-источник открывается по ссылке; цитатой кладём фразы выжимки,
      // которые на него ссылались, — их и стоит сверять.
      const used = webSources.filter((w) => cited.has(w.n));
      if (used.length > 0) {
        const sentences = material.split(/(?<=[.!?…])\s+/);
        await db.insert(lectureSourcesTable).values(
          used.map((w) => ({
            lectureId: id,
            sectionId: section.id,
            kind: "web" as const,
            url: w.url,
            title: w.title.slice(0, 300),
            quote: (sentences.filter((t) => t.includes(`[${w.n}]`)).join(" ").trim() ||
              "Найдено веб-поиском — откройте источник по ссылке.").slice(0, 600),
          })),
        );
      }
    } else if (isResearch) {
      // Ни библиотеки, ни поиска: говорим об этом прямо, а не молчим.
      await db.insert(lectureSourcesTable).values({
        lectureId: id,
        sectionId: section.id,
        kind: "model" as const,
        title: "Написано по знаниям модели",
        quote:
          "Веб-поиск не настроен, глава основана на общих знаниях модели: имена, даты и " +
          "формулировки стоит сверить. Ключ Perplexity (./set-ai-key.sh, пункт 3) включит " +
          "настоящие источники со ссылками.",
      });
    }
  }

  await db
    .update(lecturesTable)
    .set({ status: "ready", statusMessage: "" })
    .where(eq(lecturesTable.id, id));

  // Написанная лекция — такой же материал, как книга: кладём её в библиотеку,
  // чтобы следующая работа могла на неё опереться. Не удалась копия — лекция
  // всё равно готова; стартовая сверка попробует ещё раз.
  await lectureToLibrary(id).catch((err) =>
    logger.error({ err, id }, "Не смог отправить лекцию в библиотеку"),
  );

  logger.info({ id, sections: total }, "Лекция написана");
}

async function onGiveUp(job: Job, message: string): Promise<void> {
  await db
    .update(lecturesTable)
    .set({ status: "error", statusMessage: "", error: message })
    .where(eq(lecturesTable.id, job.entityId))
    .catch((err) => logger.error({ err, id: job.entityId }, "Не смог записать ошибку лекции"));
}

export function registerLectureHandlers(): void {
  registerHandler("lecture.plan", { run: runPlan, onGiveUp });
  registerHandler("lecture.write", { run: runWrite, onGiveUp });
}

export { enqueue };
