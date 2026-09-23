import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { toFile } from "openai";
import { openai } from "@workspace/integrations-openai-ai-server/audio";
import type { TranscriptSegment } from "@workspace/db";
import { maskText, unmaskText, NerUnavailableError } from "./privacy";

const execFileAsync = promisify(execFile);

// ffmpeg re-encodes each segment to mono mp3 at 64 kbps (~8 KB/s), so a 600 s
// segment is roughly 4.6 MB — comfortably under OpenAI's 25 MB / 25 min limits,
// with predictable size.
const SEGMENT_SECONDS = 600;

// Higher-quality speech-to-text model. Like its "mini" sibling it caps each
// request at 1500 seconds (25 minutes), so longer recordings must be split.
// Модели задаются в конфигурации, а не в коде: поменять модель можно правкой
// одной строки в .env и перезапуском, без пересборки приложения.
const TRANSCRIBE_MODEL = process.env["MODEL_TRANSCRIBE"] ?? "gpt-4o-transcribe";
const STRUCTURE_MODEL = process.env["MODEL_STRUCTURE"] ?? "gpt-5.4";

/**
 * Transcribe a single audio chunk that is already safely under the size/duration
 * limits. The filename is passed through so the model can detect the format.
 */
async function transcribeAudio(buffer: Buffer, filename: string): Promise<string> {
  const file = await toFile(buffer, filename);
  const response = await openai.audio.transcriptions.create({
    file,
    model: TRANSCRIBE_MODEL,
  });
  return response.text ?? "";
}

export interface AudioChunk {
  buffer: Buffer;
  filename: string;
}

/**
 * Normalize and split any recording into mp3 pieces that each stay safely under
 * the transcription size/duration limits. Every file is decoded and re-encoded
 * with ffmpeg (mono 16 kHz mp3) regardless of size, so any format ffmpeg can
 * read — m4a, mp3, wav, ogg/opus, webm, aac, amr, wma, video containers, … —
 * becomes a format OpenAI reliably accepts. A short clip yields one chunk; a
 * 2–3 hour recording becomes a handful of independently transcribable chunks.
 */
export async function splitAudioIntoChunks(
  inputPath: string,
  originalName: string,
): Promise<AudioChunk[]> {
  const workDir = await mkdtemp(path.join(tmpdir(), "kot-chunks-"));
  try {
    const pattern = path.join(workDir, "chunk_%03d.mp3");
    await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "64k",
      "-f",
      "segment",
      "-segment_time",
      String(SEGMENT_SECONDS),
      "-reset_timestamps",
      "1",
      pattern,
    ]);

    const files = (await readdir(workDir)).filter((f) => f.endsWith(".mp3")).sort();
    if (files.length === 0) {
      throw new Error("ffmpeg produced no audio chunks");
    }

    const base = originalName.replace(/\.[^.]+$/, "") || "запись";
    const chunks: AudioChunk[] = [];
    for (let i = 0; i < files.length; i++) {
      const buffer = await readFile(path.join(workDir, files[i]));
      chunks.push({ buffer, filename: `${base}_part${i + 1}.mp3` });
    }
    return chunks;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Error carrying a friendly, user-facing Russian message describing which part of
 * a long recording failed and at what stage.
 */
export class ChunkError extends Error {
  readonly userMessage: string;
  constructor(part: number, total: number, verb: string, cause: unknown) {
    super(`chunk ${part}/${total} failed to ${verb}`);
    this.name = "ChunkError";
    this.cause = cause;
    // Сервис скрытия имён лёг — запись и файл тут ни при чём, очередь повторит
    // задачу. Текст дойдёт до человека, только если все попытки кончатся.
    // Что делать дальше, говорит кнопка «Попробовать снова» (повтор из
    // сохранённого аудио), поэтому здесь только факт — без советов грузить заново.
    this.userMessage =
      cause instanceof NerUnavailableError
        ? "Сервис скрытия имён временно недоступен"
        : total > 1
          ? `Не удалось ${verb} часть ${part} из ${total}`
          : `Не удалось ${verb} запись`;
  }
}

export interface TranscribeProgress {
  progress: number;
  message: string;
}

/**
 * Transcribe a recording of any length: split into chunks, transcribe and
 * structure each chunk with the same privacy/speaker options, then stitch the
 * resulting segments back together in order. Reports calm progress via the
 * optional callback. Throws a {@link ChunkError} if a chunk fails.
 */
export async function transcribeLongAudio(
  inputPath: string,
  originalName: string,
  opts: StructureOptions,
  onProgress?: (p: TranscribeProgress) => void | Promise<void>,
): Promise<TranscriptSegment[]> {
  await onProgress?.({ progress: 6, message: "Готовлю запись…" });

  const chunks = await splitAudioIntoChunks(inputPath, originalName);
  const total = chunks.length;
  const multi = total > 1;

  const all: TranscriptSegment[] = [];
  for (let i = 0; i < total; i++) {
    const human = `${i + 1} из ${total}`;
    // Spread chunk work across the 10–92% band; save/finalize happens after.
    const bandStart = 10 + Math.round((i / total) * 82);
    const bandHalf = bandStart + Math.round((0.5 / total) * 82);

    await onProgress?.({
      progress: bandStart,
      message: multi ? `Слушаю часть ${human}…` : "Слушаю запись…",
    });

    let rawText: string;
    try {
      rawText = await transcribeAudio(chunks[i].buffer, chunks[i].filename);
    } catch (err) {
      throw new ChunkError(i + 1, total, "распознать", err);
    }

    if (rawText.trim() === "") continue; // silence in this part — skip it

    await onProgress?.({
      progress: bandHalf,
      message: multi ? `Навожу порядок в части ${human}…` : "Навожу порядок…",
    });

    let segs: TranscriptSegment[];
    try {
      // Уже собранное — чтобы кусок продолжил нумерацию Speaker, а не начал заново.
      segs = await structureTranscript(rawText, opts, all);
    } catch (err) {
      throw new ChunkError(i + 1, total, "оформить", err);
    }
    all.push(...segs);
  }

  if (all.length === 0) {
    all.push({ who: "", text: "В записи не удалось распознать речь." });
  }

  await onProgress?.({ progress: 96, message: "Сохраняю текст…" });
  return all;
}

/**
 * Длинная запись оформляется кусками по 10 минут, и без подсказки каждый кусок
 * нумеровал бы говорящих заново: Speaker 1 в начале и в середине оказались бы
 * разными людьми. Поэтому следующему куску говорим, какие Speaker уже были и
 * кто говорил последним. Без скрытия имён — ещё и концы двух последних реплик;
 * со скрытием их текст не отправляем: в нём уже настоящие имена.
 */
function speakerContext(previous: TranscriptSegment[], hideNames: boolean): string | null {
  const labeled = previous.filter((s) => /^Speaker \d+$/.test(s.who));
  if (labeled.length === 0) return null;
  const seen = [...new Set(labeled.map((s) => s.who))];
  const lines = [
    `Это продолжение записи. Уже встречались: ${seen.join(", ")}; последним говорил ${labeled[labeled.length - 1]!.who}. Продолжай ту же нумерацию: тот же человек — тот же номер, новый — следующий по порядку. Если в этой части говорит один человек — всё равно помечай его.`,
  ];
  if (!hideNames) {
    lines.push("Конец предыдущей части — только для справки, в ответ не включай:");
    for (const s of labeled.slice(-2)) lines.push(`${s.who}: …${s.text.slice(-300)}`);
  }
  return lines.join("\n");
}

/** «Спикер 2», «speaker2» и т. п. — к одному виду «Speaker 2»; прочее как есть. */
function normalizeSpeaker(who: string): string {
  const m = who.trim().match(/^(?:speaker|спикер)\s*(\d+)$/i);
  return m ? `Speaker ${m[1]}` : who.trim();
}

interface StructureOptions {
  /**
   * Галочка «Скрыть имена и города» в форме. true — имена маскируются ДО
   * отправки в модель (если сервис имён лежит, текст не уходит), хранятся в
   * скобках [[Анна]] и на экране видны как «имя скрыто». false — текст уходит
   * на оформление как есть и хранится обычным: на платформе лекции и
   * воркшопы, а не сеансы (решение владелицы 23.09.2026: выбирает клиент).
   */
  hideNames: boolean;
  markSpeakers: boolean;
}

/**
 * Turn a raw transcript into clean, structured segments. With hideNames masks
 * personal names / places before the model call; optionally labels the two
 * speakers. Best-effort: if the model output can't be parsed, falls back to a
 * single plain-text segment. With hideNames throws {@link NerUnavailableError}
 * without calling the model if names can't be masked.
 */
export async function structureTranscript(
  rawText: string,
  { hideNames, markSpeakers }: StructureOptions,
  previous: TranscriptSegment[] = [],
): Promise<TranscriptSegment[]> {
  const trimmed = rawText.trim();
  if (trimmed === "") {
    return [{ who: "", text: "В записи не удалось распознать речь." }];
  }

  // Скрыть имена попросили — прячем их ЛОКАЛЬНО до отправки в модель. Если
  // NER лежит, maskText бросает, и запрос к модели не уходит вовсе. Не
  // попросили — текст уходит как есть, сервис имён не нужен.
  const { masked: payload, map: nameMap } = hideNames
    ? await maskText(trimmed)
    : { masked: trimmed, map: {} };
  const reveal = (text: string) => (hideNames ? unmaskText(text, nameMap) : text);

  const rules: string[] = [
    "Ты аккуратно оформляешь расшифровку аудиозаписи на русском языке — лекции, воркшопа или беседы.",
    "Не выдумывай и не добавляй слов, которых нет в записи. Только аккуратно оформи уже сказанное: расставь знаки препинания, раздели на осмысленные реплики и абзацы, убери слова-паразиты только если это явно мусор распознавания.",
  ];

  if (markSpeakers) {
    // Пометки «Speaker 1, Speaker 2…» — решение владелицы 23.09.2026: на
    // платформе лекции и воркшопы, «Вы / Собеседник» из сеансов тут не к месту.
    rules.push(
      'Раздели текст на реплики разных говорящих и пометь их по порядку первого появления: "who": "Speaker 1", "Speaker 2", "Speaker 3" и так далее. Один и тот же человек — всегда один и тот же номер. Если говорит один человек (например, лекция) и ниже не сказано продолжать нумерацию — оставляй "who": "" у всех реплик.',
    );
    const context = speakerContext(previous, hideNames);
    if (context) rules.push(context);
  } else {
    rules.push('Не помечай говорящих: у каждой реплики "who" должно быть пустой строкой "".');
  }

  if (hideNames) {
    rules.push(
      'В тексте уже стоят метки вида [[PER1]], [[LOC1]] — за ними скрыты имена людей и названия мест. Переноси эти метки в ответ ДОСЛОВНО и на то же место: не переводи, не склоняй, не раскрывай и не придумывай новых меток. Больше двойные квадратные скобки ни для чего не используй.',
    );
  } else {
    // [[…]] фронт читает как скрытое имя — в тексте без скрытия их быть не должно.
    rules.push("Двойные квадратные скобки не используй.");
  }

  rules.push(
    'Верни СТРОГО JSON-объект вида {"segments":[{"who":"...","text":"..."}]} без какого-либо другого текста.',
  );

  const response = await openai.chat.completions.create({
    model: STRUCTURE_MODEL,
    max_completion_tokens: 8192,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: rules.join("\n") },
      { role: "user", content: payload },
    ],
  });

  const content = response.choices[0]?.message?.content ?? "";

  try {
    const parsed = JSON.parse(content) as { segments?: unknown };
    const segments = Array.isArray(parsed.segments) ? parsed.segments : [];
    const clean: TranscriptSegment[] = segments
      .map((s) => {
        const seg = s as Record<string, unknown>;
        const text = typeof seg.text === "string" ? seg.text : "";
        return {
          who: typeof seg.who === "string" ? normalizeSpeaker(seg.who) : "",
          // Возвращаем настоящие имена на место меток — уже на нашем сервере.
          text: reveal(text),
        };
      })
      .filter((s) => s.text.trim() !== "");

    if (clean.length > 0) return clean;
  } catch {
    // fall through to plain-text fallback
  }

  // Оформление не удалось — отдаём исходный текст, повторно за границу ничего
  // не шлём. Со скрытием имён — через метки, чтобы имена легли в скобки.
  const fallbackText = hideNames ? reveal(payload) : trimmed;
  return [{ who: "", text: fallbackText }];
}
