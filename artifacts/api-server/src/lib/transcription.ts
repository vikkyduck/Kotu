import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { toFile } from "openai";
import { openai } from "@workspace/integrations-openai-ai-server/audio";
import type { TranscriptSegment } from "@workspace/db";

const execFileAsync = promisify(execFile);

// OpenAI's transcription endpoint rejects files over 25 MB; keep a safety margin.
const CHUNK_SAFE_BYTES = 24 * 1024 * 1024;
// ffmpeg re-encodes each segment to mono mp3 at 64 kbps (~8 KB/s), so a 600 s
// segment is roughly 4.6 MB — comfortably under the limit, with predictable size.
const SEGMENT_SECONDS = 600;

// Higher-quality speech-to-text model. Like its "mini" sibling it caps each
// request at 1500 seconds (25 minutes), so longer recordings must be split.
const TRANSCRIBE_MODEL = "gpt-4o-transcribe";

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
 * Split a (possibly very long) recording into pieces that each stay safely under
 * the transcription size limit. Small files are returned untouched as a single
 * chunk; larger files are re-encoded and time-segmented with ffmpeg so a 2–3 hour
 * recording becomes a handful of small, independently transcribable mp3 chunks.
 */
export async function splitAudioIntoChunks(
  inputPath: string,
  originalName: string,
): Promise<AudioChunk[]> {
  const { size } = await stat(inputPath);
  if (size <= CHUNK_SAFE_BYTES) {
    const buffer = await readFile(inputPath);
    return [{ buffer, filename: originalName }];
  }

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
    this.userMessage =
      total > 1
        ? `Не удалось ${verb} часть ${part} из ${total}. Попробуйте загрузить запись ещё раз.`
        : `Не удалось ${verb} запись. Попробуйте другой файл.`;
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
      segs = await structureTranscript(rawText, opts);
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

interface StructureOptions {
  hideNames: boolean;
  markSpeakers: boolean;
}

/**
 * Turn a raw transcript into clean, structured segments. Optionally redacts
 * personal names / places and labels the two speakers. Best-effort: if the
 * model output can't be parsed, falls back to a single plain-text segment.
 */
export async function structureTranscript(
  rawText: string,
  { hideNames, markSpeakers }: StructureOptions,
): Promise<TranscriptSegment[]> {
  const trimmed = rawText.trim();
  if (trimmed === "") {
    return [{ who: "", text: "В записи не удалось распознать речь." }];
  }

  const rules: string[] = [
    "Ты помогаешь психологу аккуратно оформить расшифровку аудиозаписи на русском языке.",
    "Не выдумывай и не добавляй слов, которых нет в записи. Только аккуратно оформи уже сказанное: расставь знаки препинания, раздели на осмысленные реплики и абзацы, убери слова-паразиты только если это явно мусор распознавания.",
  ];

  if (markSpeakers) {
    rules.push(
      'Определи, где говорит ведущий/психолог, а где собеседник. Для реплик ведущего ставь "who": "Вы", для реплик второго человека — "who": "Собеседник". Если говорящий один (например это лекция), оставляй "who": "" для всех реплик.',
    );
  } else {
    rules.push('Не помечай говорящих: у каждой реплики "who" должно быть пустой строкой "".');
  }

  if (hideNames) {
    rules.push(
      'Скрой персональные данные: имена и фамилии людей, названия городов и адреса замени на слово «скрыто» (вместе с предлогом сохрани читаемость). Это важно для конфиденциальности пациентов.',
    );
  }

  rules.push(
    'Верни СТРОГО JSON-объект вида {"segments":[{"who":"...","text":"..."}]} без какого-либо другого текста.',
  );

  const response = await openai.chat.completions.create({
    model: "gpt-5.4",
    max_completion_tokens: 8192,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: rules.join("\n") },
      { role: "user", content: trimmed },
    ],
  });

  const content = response.choices[0]?.message?.content ?? "";

  try {
    const parsed = JSON.parse(content) as { segments?: unknown };
    const segments = Array.isArray(parsed.segments) ? parsed.segments : [];
    const clean: TranscriptSegment[] = segments
      .map((s) => {
        const seg = s as Record<string, unknown>;
        return {
          who: typeof seg.who === "string" ? seg.who : "",
          text: typeof seg.text === "string" ? seg.text : "",
        };
      })
      .filter((s) => s.text.trim() !== "");

    if (clean.length > 0) return clean;
  } catch {
    // fall through to plain-text fallback
  }

  return [{ who: "", text: trimmed }];
}
