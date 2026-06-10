import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { toFile } from "openai";
import { openai } from "@workspace/integrations-openai-ai-server/audio";
import type { TranscriptSegment } from "@workspace/db";

// Higher-quality speech-to-text model. Like its "mini" sibling it caps each
// request at 1500 seconds (25 minutes), so longer recordings must be split.
const TRANSCRIBE_MODEL = "gpt-4o-transcribe";

// Length of each audio chunk. Kept well under the model's 25-minute limit so
// even imprecise split boundaries stay safe.
const CHUNK_SECONDS = 600;

// How many chunks to transcribe / structure at once. Keeps long recordings
// fast enough to finish within a single request without hammering the API.
const CONCURRENCY = 3;

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      }
    });
  });
}

/**
 * Run an async mapper over items with a bounded number of concurrent calls,
 * preserving input order in the results.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]!, idx);
    }
  }
  const count = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: count }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Normalize the recording to mono 16 kHz MP3 and split it into time-based
 * chunks small enough for the transcription model. 16 kHz mono is exactly what
 * speech models consume internally, so this shrinks the data dramatically
 * without hurting transcription quality. Returns ordered chunk paths; the
 * caller is responsible for removing the returned directory.
 */
async function splitIntoChunks(inputPath: string): Promise<{ dir: string; files: string[] }> {
  const dir = await mkdtemp(path.join(tmpdir(), "kot-chunks-"));
  try {
    await runFfmpeg([
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
      "-b:a",
      "64k",
      "-f",
      "segment",
      "-segment_time",
      String(CHUNK_SECONDS),
      path.join(dir, "chunk-%04d.mp3"),
    ]);
    const files = (await readdir(dir))
      .filter((f) => f.endsWith(".mp3"))
      .sort()
      .map((f) => path.join(dir, f));
    return { dir, files };
  } catch (err) {
    // Don't leak the temp dir if ffmpeg (or readdir) fails.
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

async function transcribeChunk(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  const file = await toFile(buf, path.basename(filePath));
  const response = await openai.audio.transcriptions.create({
    file,
    model: TRANSCRIBE_MODEL,
  });
  return response.text ?? "";
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

/**
 * Full pipeline for a recording of any length: split into safe chunks,
 * transcribe each chunk (in parallel, in order), then structure each chunk's
 * text and stitch the resulting segments back together into one transcript.
 */
export async function transcribeRecording(
  inputPath: string,
  options: StructureOptions,
): Promise<TranscriptSegment[]> {
  const { dir, files } = await splitIntoChunks(inputPath);
  try {
    if (files.length === 0) {
      return [{ who: "", text: "В записи не удалось распознать речь." }];
    }

    const texts = await mapWithConcurrency(files, CONCURRENCY, (f) => transcribeChunk(f));
    const nonEmpty = texts.filter((t) => t.trim() !== "");

    if (nonEmpty.length === 0) {
      return [{ who: "", text: "В записи не удалось распознать речь." }];
    }

    const segmentChunks = await mapWithConcurrency(nonEmpty, CONCURRENCY, (t) =>
      structureTranscript(t, options),
    );
    const all = segmentChunks.flat();

    if (all.length === 0) {
      return [{ who: "", text: "В записи не удалось распознать речь." }];
    }
    return all;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
