import { toFile } from "openai";
import { openai } from "@workspace/integrations-openai-ai-server/audio";
import type { TranscriptSegment } from "@workspace/db";

/**
 * Transcribe an audio buffer to raw text using OpenAI's speech-to-text model.
 * The filename (with extension) is passed through so OpenAI can detect the
 * container format — supports mp3, m4a, mp4, wav, webm, ogg, flac, etc.
 */
export async function transcribeAudio(buffer: Buffer, filename: string): Promise<string> {
  const file = await toFile(buffer, filename);
  const response = await openai.audio.transcriptions.create({
    file,
    model: "gpt-4o-mini-transcribe",
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
