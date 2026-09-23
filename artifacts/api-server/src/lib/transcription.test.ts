import { test, describe, expect, vi, afterEach, beforeEach } from "vitest";

/**
 * Оформление расшифровки: наружу — только текст с метками.
 *
 * Модель оформления зарубежная, поэтому имена прячутся ВСЕГДА, какой бы ни
 * была галочка «скрывать имена» в форме: она решает только, как имена
 * хранятся и показываются. А если сервис распознавания имён лежит, запрос к
 * модели не уходит вовсе.
 *
 * Клиент OpenAI подменён: сеть не нужна, а каждый вызов виден тесту.
 */

const create = vi.hoisted(() => vi.fn());
vi.mock("@workspace/integrations-openai-ai-server/audio", () => ({
  openai: { chat: { completions: { create } }, audio: { transcriptions: { create: vi.fn() } } },
}));

import { structureTranscript, ChunkError } from "./transcription";
import { NerUnavailableError } from "./privacy";

const RAW = "Анна пришла и сразу заговорила о матери.";

/** NER находит «Анна» в начале текста — ровно то место, где ошибалась эвристика. */
function nerFindsAnna() {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    json: async () => ({ spans: [{ start: 0, stop: 4, text: "Анна", type: "PER" }] }),
  }));
}

/** Модель возвращает оформленный текст с той же меткой. */
function modelAnswers(content: string) {
  create.mockResolvedValue({ choices: [{ message: { content } }] });
}

/** Всё, что ушло в модель за вызов: системный промпт и текст пользователя. */
function sentToModel(): string {
  const [{ messages }] = create.mock.calls[0] as [{ messages: { content: string }[] }];
  return messages.map((m) => m.content).join("\n");
}

beforeEach(() => create.mockReset());
afterEach(() => vi.unstubAllGlobals());

describe("имена не уходят в модель", () => {
  test("hideNames=false: в модель — метка, в результате — имя без скобок", async () => {
    nerFindsAnna();
    modelAnswers(
      JSON.stringify({ segments: [{ who: "", text: "[[PER1]] пришла и сразу заговорила о матери." }] }),
    );

    const segs = await structureTranscript(RAW, { hideNames: false, markSpeakers: false });

    expect(create).toHaveBeenCalledTimes(1);
    const sent = sentToModel();
    expect(sent.includes("Анна"), `имя ушло в модель: ${sent}`).toBe(false);
    expect(sent).toContain("[[PER1]] пришла");
    expect(sent).toContain("Переноси эти метки в ответ ДОСЛОВНО");
    expect(segs).toEqual([{ who: "", text: "Анна пришла и сразу заговорила о матери." }]);
  });

  test("hideNames=true: в модель — метка, в результате — имя в скобках", async () => {
    nerFindsAnna();
    modelAnswers(
      JSON.stringify({ segments: [{ who: "", text: "[[PER1]] пришла и сразу заговорила о матери." }] }),
    );

    const segs = await structureTranscript(RAW, { hideNames: true, markSpeakers: false });

    expect(sentToModel().includes("Анна")).toBe(false);
    expect(segs).toEqual([{ who: "", text: "[[Анна]] пришла и сразу заговорила о матери." }]);
  });

  test("модель ответила не JSON, hideNames=false — исходный текст как есть", async () => {
    nerFindsAnna();
    modelAnswers("не json");

    const segs = await structureTranscript(`  ${RAW}  `, { hideNames: false, markSpeakers: false });

    expect(sentToModel().includes("Анна")).toBe(false);
    expect(segs).toEqual([{ who: "", text: RAW }]);
  });

  test("модель ответила не JSON, hideNames=true — имена в скобках", async () => {
    nerFindsAnna();
    modelAnswers("не json");

    const segs = await structureTranscript(RAW, { hideNames: true, markSpeakers: false });

    expect(segs).toEqual([{ who: "", text: "[[Анна]] пришла и сразу заговорила о матери." }]);
  });
});

describe("сервис распознавания имён лежит", () => {
  test.each([
    [
      "сеть",
      async () => {
        throw new TypeError("fetch failed");
      },
    ],
    ["500", async () => ({ ok: false, status: 500, json: async () => ({}) })],
    [
      "таймаут",
      async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    ],
  ])("%s — оформление отклоняется, запрос к модели не отправлен", async (_name, impl) => {
    vi.stubGlobal("fetch", impl);
    modelAnswers(JSON.stringify({ segments: [{ who: "", text: "не должно понадобиться" }] }));

    for (const hideNames of [false, true]) {
      await expect(
        structureTranscript(RAW, { hideNames, markSpeakers: true }),
      ).rejects.toBeInstanceOf(NerUnavailableError);
    }
    expect(create).not.toHaveBeenCalled();
  });

  test("человеку — про временную недоступность, а не «не удалось оформить»", () => {
    const err = new ChunkError(2, 3, "оформить", new NerUnavailableError(new Error("down")));

    expect(err.userMessage).toMatch(/Сервис скрытия имён временно недоступен/);
    expect(err.userMessage.includes("Не удалось оформить")).toBe(false);
  });

  test("прочие сбои по-прежнему называют часть записи", () => {
    const err = new ChunkError(2, 3, "оформить", new Error("boom"));

    expect(err.userMessage).toBe("Не удалось оформить часть 2 из 3. Попробуйте загрузить запись ещё раз.");
  });
});
