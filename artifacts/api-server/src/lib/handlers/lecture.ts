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
  type LecturePlanNotes,
  type Bibliography,
} from "@workspace/db";
import { searchLibrary } from "../../routes/documents";
import { embedAll } from "../embeddings";
import { research, isResearchAvailable, type WebSource } from "../perplexity";
import { planPrompt, sectionPrompt, bibliographyPrompt } from "../lecture-prompt";

/**
 * Какие источники включены. Старые записи несли одиночный mode «или/или» —
 * читаем его как совместимость; новые несут два независимых флага.
 */
function briefSources(brief: LectureBrief): { lib: boolean; res: boolean } {
  if (brief.useLibrary !== undefined || brief.useResearch !== undefined) {
    return { lib: brief.useLibrary === true, res: brief.useResearch === true };
  }
  if (brief.mode === "research") return { lib: false, res: true };
  return { lib: true, res: false };
}
import { registerHandler, enqueue } from "../jobs";
import { lectureToLibrary } from "../work-doc";
import { logger } from "../logger";

const MODEL = process.env["MODEL_LECTURE"] ?? "gpt-5.6-sol";

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

  // Источники независимы: библиотека И исследование складываются в общий
  // материал; ни одного — план пишется по знаниям модели.
  const src = briefSources(brief);
  const isResearch = src.res;
  const parts: string[] = [];
  if (src.lib && brief.documentIds.length > 0) {
    await setStatus(id, "Смотрю, что есть в библиотеке…");
    const excerpts = await findExcerpts(lecture.ownerId, brief.topic, brief.documentIds, 14);
    if (excerpts.length > 0) parts.push(`Выдержки из библиотеки автора:\n\n${renderExcerpts(excerpts)}`);
  }
  if (src.res && isResearchAvailable()) {
    await setStatus(id, "Исследую тему в веб-источниках…");
    const found = await research(
      `Тема лекции по психоанализу: ${brief.topic}. Собери материал для плана лекции.`,
    ).catch((err) => {
      logger.warn({ err }, "Веб-поиск не ответил — планирую без него");
      return null;
    });
    if (found) parts.push(`Материал веб-исследования:\n\n${found.summary}`);
  }
  const material = parts.join("\n\n═══\n\n");

  await setStatus(id, "Продумываю структуру…");

  // Методика автора: 5–8 смысловых блоков. Хронометраж влияет на их число
  // внутри этой вилки, а не ломает её.
  const blocks = Math.max(5, Math.min(8, Math.round(brief.durationMin / 15)));

  const response = await openai.chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: planPrompt(brief, lecture.title, blocks) },
      {
        role: "user",
        content: material || "Материала под рукой нет — опирайся на профессиональный корпус психоанализа.",
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "";
  let sections: PlannedSection[] = [];
  let notes: LecturePlanNotes = { outOfScope: [], decisions: [] };
  /** Список строк из ответа модели: пустое и не-строки отбрасываем. */
  const strings = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim())
      : [];

  try {
    const parsed = JSON.parse(raw) as {
      sections?: unknown;
      outOfScope?: unknown;
      decisions?: unknown;
    };
    if (Array.isArray(parsed.sections)) {
      sections = parsed.sections
        .map((s) => {
          const o = s as Record<string, unknown>;
          return {
            heading: typeof o.heading === "string" ? o.heading : "",
            abstract: typeof o.abstract === "string" ? o.abstract : "",
            concepts: strings(o.concepts),
            hook: typeof o.hook === "string" ? o.hook : "",
          };
        })
        .filter((s) => s.heading.trim() !== "");
    }
    notes = { outOfScope: strings(parsed.outOfScope), decisions: strings(parsed.decisions) };
  } catch {
    throw new Error("Модель вернула план в непонятном виде. Попробуйте ещё раз.");
  }

  if (sections.length === 0) throw new Error("Не удалось составить план");

  await db
    .update(lecturesTable)
    .set({ plan: sections, planNotes: notes, status: "plan_ready", statusMessage: "" })
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
    const src = briefSources(brief);

    // Материал блока: выдержки библиотеки и веб-исследование складываются.
    // Нумерация ссылок единая: выдержки 1..k, веб-источники k+1..k+m —
    // иначе [2] значило бы двоих разных.
    let excerpts: Excerpt[] = [];
    let webSources: WebSource[] = [];
    const parts: string[] = [];

    if (src.lib && brief.documentIds.length > 0) {
      excerpts = await findExcerpts(lecture.ownerId, query, brief.documentIds, CHUNKS_PER_SECTION);
      if (excerpts.length > 0) parts.push(`Выдержки из библиотеки автора:\n\n${renderExcerpts(excerpts)}`);
    }

    if (src.res && isResearchAvailable()) {
      await setStatus(id, `Исследую блок ${section.ord + 1} из ${total}: ${section.heading}`);
      const found = await research(
        `Блок лекции по психоанализу: «${section.heading}». Тезис: ${section.abstract}. ` +
          `Тема всей лекции: ${brief.topic}. Собери материал для этого блока.`,
      ).catch((err) => {
        logger.warn({ err, sectionId: section.id }, "Веб-поиск не ответил — пишу без него");
        return null;
      });
      if (found) {
        const shift = excerpts.length;
        // Сдвигаем ссылки внутри сводки и номера источников на k выдержек.
        const summary = found.summary.replace(/\[(\d{1,2})\]/g, (_, n) => `[${Number(n) + shift}]`);
        webSources = found.sources.map((w) => ({ ...w, n: w.n + shift }));
        parts.push(
          `Материал веб-исследования (ссылки [n] — на источники ниже):\n\n${summary}` +
            (webSources.length > 0
              ? "\n\nИсточники:\n" + webSources.map((w) => `[${w.n}] ${w.title} — ${w.url}`).join("\n")
              : ""),
        );
      }
    }

    const material = parts.join("\n\n═══\n\n");
    const materialLabel = "Материал";

    await setStatus(id, `Пишу блок ${section.ord + 1} из ${total}: ${section.heading}`);

    // План хранит опорные концепции и «крючок» блока — передаём их пишущей
    // модели, иначе утверждённый автором замысел блока теряется.
    const planned = (lecture.plan ?? [])[section.ord];
    const system = sectionPrompt({
      brief,
      title: lecture.title,
      heading: section.heading,
      abstract: section.abstract,
      concepts: planned?.concepts ?? [],
      hook: planned?.hook ?? "",
      words: wordsPerSection,
      nextHeading: sections[section.ord + 1]?.heading ?? null,
    });

    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content:
            `Блок: ${section.heading}\nТезис: ${section.abstract}` +
            ((planned?.concepts?.length ?? 0) > 0
              ? `\nОпорные концепции и авторы: ${planned!.concepts!.join("; ")}`
              : "") +
            (planned?.hook ? `\nКрючок для аудитории: ${planned.hook}` : "") +
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
    // Прежние источники главы заменяются новыми; старые строки остаются в
    // архиве (триггер на lecture_sources).
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
    }

    if (webSources.length > 0) {
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
    }

    if (material === "") {
      // Материала не вышло ниоткуда: говорим об этом прямо, а не молчим.
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

  // Хвост методики: литература двумя уровнями — истоки и современность.
  // Собирается по написанному тексту, а не по плану: в текст могли войти
  // работы, которых в плане не было.
  await setStatus(id, "Собираю список литературы…");
  const written = await db
    .select()
    .from(lectureSectionsTable)
    .where(eq(lectureSectionsTable.lectureId, id))
    .orderBy(asc(lectureSectionsTable.ord));

  const bibliography = await openai.chat.completions
    .create({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: bibliographyPrompt(brief, lecture.title) },
        {
          role: "user",
          content: written
            .map((w) => `## ${w.heading}\n${w.text}`)
            .join("\n\n")
            .slice(0, 120_000),
        },
      ],
    })
    .then((r) => {
      const parsed = JSON.parse(r.choices[0]?.message?.content ?? "{}") as Record<string, unknown>;
      const list = (v: unknown): string[] =>
        Array.isArray(v)
          ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim())
          : [];
      const out: Bibliography = { primary: list(parsed.primary), modern: list(parsed.modern) };
      return out.primary.length + out.modern.length > 0 ? out : null;
    })
    // Список — украшение, а не суть: лекция готова и без него.
    .catch((err) => {
      logger.warn({ err, id }, "Список литературы не собрался");
      return null;
    });

  await db
    .update(lecturesTable)
    .set({ status: "ready", statusMessage: "", bibliography })
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
