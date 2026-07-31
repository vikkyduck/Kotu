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

  const excerpts = await findExcerpts(lecture.ownerId, brief.topic, brief.documentIds, 14);

  await setStatus(id, "Продумываю структуру…");

  // Ориентир: примерно 12 минут речи на главу — так шестичасовая лекция
  // не превращается в три необъятных куска.
  const target = Math.max(3, Math.min(14, Math.round(brief.durationMin / 12)));

  const system = [
    "Ты помогаешь преподавателю психоанализа спланировать лекцию на русском языке.",
    "Тебе дан замысел лекции и выдержки из личной библиотеки автора.",
    `Составь план примерно из ${target} глав на ${brief.durationMin} минут для аудитории: ${brief.audience}.`,
    "Опирайся на выдержки: план должен быть про то, что в них есть, а не про тему вообще.",
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
        content: `Замысел лекции:\n${brief.topic}\n\nВыдержки из библиотеки:\n\n${renderExcerpts(excerpts)}`,
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
    const excerpts = await findExcerpts(
      lecture.ownerId,
      query,
      brief.documentIds,
      CHUNKS_PER_SECTION,
    );

    const system = [
      "Ты пишешь главу лекции по психоанализу на русском языке для преподавателя.",
      `Аудитория: ${brief.audience}. Это часть лекции «${lecture.title}».`,
      "Пиши живым устным языком, как говорят с кафедры: без канцелярита и без academese.",
      "Опирайся ТОЛЬКО на предоставленные выдержки. Не выдумывай фактов, дат, имён и цитат.",
      "Если в выдержках нет нужного — просто не пиши об этом, не додумывай.",
      "Когда опираешься на выдержку, ставь ссылку в квадратных скобках: [1], [2].",
      "Ссылку ставь сразу после утверждения, к которому она относится.",
      "Не пересказывай выдержки подряд — выстрой связное рассуждение.",
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
            `Глава: ${section.heading}\nО чём она: ${section.abstract}\n\n` +
            `Выдержки из библиотеки:\n\n${renderExcerpts(excerpts)}`,
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
