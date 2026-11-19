import { test, describe, expect, vi, afterEach, beforeEach } from "vitest";

/**
 * Оформление расшифровки. Скрытия имён больше нет (решение владелицы
 * 18.11.2026): текст уходит в модель как есть.
 *
 * Клиент модели подменен: сеть не нужна, а каждый вызов виден тесту.
 */

const create = vi.hoisted(() => vi.fn());
vi.mock("./codex", () => ({
  askText: create,
  modelFor: () => "gpt-5.6-sol",
  ModelWaitError: class ModelWaitError extends Error {},
}));
vi.mock("./whisper", () => ({ whisper: { audio: { transcriptions: { create: vi.fn() } } } }));

import { structureTranscript, ChunkError } from "./transcription";

const RAW = "Анна пришла и сразу заговорила о матери.";

/** Модель возвращает оформленный текст с той же меткой. */
function modelAnswers(content: string) {
  create.mockResolvedValue({ text: content, sources: [], route: "codex" });
}

/** Всё, что ушло в модель за вызов: системный промпт и текст пользователя. */
function sentToModel(): string {
  const [{ system, user }] = create.mock.calls[0] as [{ system: string; user: string }];
  return [system, user].join("\n");
}

beforeEach(() => create.mockReset());
afterEach(() => vi.unstubAllGlobals());

describe("текст как есть", () => {
  test("в модель — исходный текст, других запросов нет", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    modelAnswers(JSON.stringify({ segments: [{ who: "", text: "Анна пришла и сразу заговорила о матери." }] }));

    const segs = await structureTranscript(RAW, { markSpeakers: false });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    const sent = sentToModel();
    expect(sent).toContain(RAW);
    expect(sent).not.toContain("Переноси эти метки");
    expect(segs).toEqual([{ who: "", text: "Анна пришла и сразу заговорила о матери." }]);
  });

  test("модель ответила не JSON — исходный текст как есть", async () => {
    modelAnswers("не json");

    const segs = await structureTranscript(`  ${RAW}  `, { markSpeakers: false });

    expect(segs).toEqual([{ who: "", text: RAW }]);
  });
});

describe("ошибка части записи", () => {
  test("человеку называется часть записи", () => {
    const err = new ChunkError(2, 3, "оформить", new Error("boom"));

    expect(err.userMessage).toBe("Не удалось оформить часть 2 из 3");
  });
});

describe("пометки говорящих — Speaker 1, Speaker 2", () => {
  test("правило в промпте; «Спикер 2» приводится к «Speaker 2»", async () => {
    modelAnswers(
      JSON.stringify({
        segments: [
          { who: "Speaker 1", text: "Начнём." },
          { who: "Спикер 2", text: "Вопрос." },
        ],
      }),
    );

    const segs = await structureTranscript(RAW, { markSpeakers: true });

    expect(sentToModel()).toContain('"Speaker 1", "Speaker 2"');
    expect(sentToModel()).not.toContain("Собеседник");
    expect(segs.map((s) => s.who)).toEqual(["Speaker 1", "Speaker 2"]);
  });

  test("следующая часть продолжает нумерацию и видит конец прошлой", async () => {
    modelAnswers(JSON.stringify({ segments: [{ who: "Speaker 2", text: "Дальше." }] }));
    const previous = [
      { who: "Speaker 1", text: "Вводная часть лекции." },
      { who: "Speaker 2", text: "Можно вопрос про Фрейда?" },
    ];

    await structureTranscript(RAW, { markSpeakers: true }, previous);

    const sent = sentToModel();
    expect(sent).toContain("Уже встречались: Speaker 1, Speaker 2; последним говорил Speaker 2");
    expect(sent).toContain("Можно вопрос про Фрейда?");
  });

  test("без пометок говорящих контекст не передаётся", async () => {
    modelAnswers(JSON.stringify({ segments: [{ who: "", text: "Текст." }] }));

    await structureTranscript(RAW, { markSpeakers: false }, [
      { who: "Speaker 1", text: "Было." },
    ]);

    expect(sentToModel()).not.toContain("Уже встречались");
  });
});
