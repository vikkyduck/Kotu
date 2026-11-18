import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Самопроверка: что считается проблемой, когда владелице пишем и когда нет.
 * Модели, почта и мост подменены, сеть подменена через fetch.
 */

const codex = vi.hoisted(() => {
  class ModelWaitError extends Error {}
  return {
    askText: vi.fn(async (_opts: { model: string }) => ({ text: "ок", sources: [] as unknown[], route: "codex" })),
    ModelWaitError,
    pickModel: (name: string, fallback: string) => process.env[name] || fallback,
  };
});
const mail = vi.hoisted(() => ({ checkMail: vi.fn(async (): Promise<string | null> => null) }));
const notify = vi.hoisted(() => ({ notifyOwner: vi.fn(async (_text: string) => true) }));
vi.mock("./codex", () => codex);
vi.mock("./mail", () => mail);
vi.mock("./notify", () => notify);
vi.mock("./logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

import { checkAndNotify, configuredModels, resetSelfCheckState, runSelfCheck } from "./self-check";

const noDelay = async () => {};

function servicesUp() {
  vi.stubGlobal("fetch", async (url: string) =>
    String(url).includes("/audio/")
      ? new Response('{"detail":"file required"}', { status: 422 })
      : new Response(JSON.stringify({ vectors: [[0.1, 0.2]] }), { status: 200 }),
  );
}

beforeEach(() => {
  resetSelfCheckState();
  codex.askText.mockClear();
  mail.checkMail.mockReset().mockResolvedValue(null);
  notify.notifyOwner.mockClear();
  servicesUp();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("что проверяется", () => {
  test("всё работает - проблем нет, владелице не пишем", async () => {
    expect(await checkAndNotify(noDelay)).toEqual([]);
    expect(notify.notifyOwner).not.toHaveBeenCalled();
  });

  test("одинаковые модели проверяются одним запросом", async () => {
    await runSelfCheck();
    expect(new Set(configuredModels().map((m) => m.model)).size).toBe(1);
    expect(codex.askText).toHaveBeenCalledTimes(1);
  });

  test("модель, которую подписка не принимает, - проблема с названием настройки", async () => {
    vi.stubEnv("MODEL_STRUCTURE", "gpt-5.4");
    codex.askText.mockImplementation(async (opts: { model: string }) => {
      if (opts.model === "gpt-5.4") throw new Error("Codex: запрос отклонен (400)");
      return { text: "ок", sources: [] as unknown[], route: "codex" };
    });
    const problems = await runSelfCheck();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("gpt-5.4");
    expect(problems[0]).toContain("MODEL_STRUCTURE");
  });

  test("Whisper лежит (502 маршрутизатора) - проблема, отказ в данных (422) - нет", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      String(url).includes("/audio/")
        ? new Response("bad gateway", { status: 502 })
        : new Response(JSON.stringify({ vectors: [[0.1]] }), { status: 200 }),
    );
    expect((await runSelfCheck()).join()).toContain("Whisper");
  });

  test("векторы не отвечают - проблема", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/audio/")) return new Response("", { status: 422 });
      throw new TypeError("fetch failed");
    });
    expect((await runSelfCheck()).join()).toContain("векторы");
  });

  test("почта не уходит - проблема", async () => {
    mail.checkMail.mockResolvedValue("письма не уходят: Postbox ответил 403");
    expect(await runSelfCheck()).toEqual(["письма не уходят: Postbox ответил 403"]);
  });
});

describe("когда пишем владелице", () => {
  test("проблема держится после перепроверки - одно сообщение со списком", async () => {
    mail.checkMail.mockResolvedValue("письма не уходят: тест");
    await checkAndNotify(noDelay);
    expect(notify.notifyOwner).toHaveBeenCalledTimes(1);
    expect(notify.notifyOwner.mock.calls[0]![0]).toContain("письма не уходят: тест");
  });

  test("проблема прошла к перепроверке (служба стартовала) - не пишем", async () => {
    mail.checkMail.mockResolvedValueOnce("письма не уходят: старт").mockResolvedValue(null);
    expect(await checkAndNotify(noDelay)).toEqual([]);
    expect(notify.notifyOwner).not.toHaveBeenCalled();
  });

  test("та же проблема в следующий раз - повторно не пишем; исправилась - пишем один раз", async () => {
    mail.checkMail.mockResolvedValue("письма не уходят: тест");
    await checkAndNotify(noDelay);
    await checkAndNotify(noDelay);
    expect(notify.notifyOwner).toHaveBeenCalledTimes(1);

    mail.checkMail.mockResolvedValue(null);
    await checkAndNotify(noDelay);
    await checkAndNotify(noDelay);
    expect(notify.notifyOwner).toHaveBeenCalledTimes(2);
    expect(notify.notifyOwner.mock.calls[1]![0]).toContain("снова в порядке");
  });

  test("сообщение не ушло (мост недоступен) - попробуем в следующий раз", async () => {
    mail.checkMail.mockResolvedValue("письма не уходят: тест");
    notify.notifyOwner.mockResolvedValueOnce(false);
    await checkAndNotify(noDelay);
    await checkAndNotify(noDelay);
    expect(notify.notifyOwner).toHaveBeenCalledTimes(2);
  });
});
