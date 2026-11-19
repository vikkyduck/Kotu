import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  askJson,
  askText,
  classify,
  drawImage,
  ModelError,
  ModelWaitError,
  numberSources,
  resetRouteState,
} from "./codex";

/**
 * Клиент моделей против двух подставных серверов: мост ПСИ на Unix-сокете
 * (как в проде) и OpenAI API на localhost. Сеть наружу не нужна, каждый
 * запрос виден тесту.
 */

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;

let dir: string;
let bridge: http.Server;
let api: http.Server;
let bridgeHandler: Handler;
let apiHandler: Handler;
const bridgeCalls: { path: string; body: unknown }[] = [];
const apiCalls: { path: string; body: unknown }[] = [];

function listen(server: http.Server, target: string | number): Promise<void> {
  return new Promise((resolve) => server.listen(target, () => resolve()));
}

function serve(calls: { path: string; body: unknown }[], pick: () => Handler): http.Server {
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      calls.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : null });
      pick()(req, raw, res);
    });
  });
}

function sse(res: http.ServerResponse, events: unknown[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.end();
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Обычный ответ модели: пояснение по ходу работы и итоговый текст. */
function answer(text: string): unknown[] {
  return [
    { type: "response.output_item.added", output_index: 0, item: { id: "c1", type: "message", phase: "commentary" } },
    { type: "response.output_text.delta", item_id: "c1", delta: "Сейчас подумаю. " },
    { type: "response.output_item.added", output_index: 1, item: { id: "m1", type: "message", phase: "final_answer" } },
    { type: "response.output_text.delta", item_id: "m1", delta: text.slice(0, 3) },
    { type: "response.output_text.delta", item_id: "m1", delta: text.slice(3) },
    {
      type: "response.completed",
      response: {
        status: "completed",
        output: [
          { id: "c1", type: "message", phase: "commentary", content: [{ type: "output_text", text: "Сейчас подумаю. " }] },
          { id: "m1", type: "message", phase: "final_answer", content: [{ type: "output_text", text }] },
        ],
      },
    },
  ];
}

const notices = (): string[] =>
  bridgeCalls.filter((c) => c.path === "/notify").map((c) => (c.body as { text: string }).text);

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kotu-codex-"));
  bridge = serve(bridgeCalls, () => bridgeHandler);
  api = serve(apiCalls, () => apiHandler);
  await listen(bridge, path.join(dir, "bridge.sock"));
  await listen(api, 0);
  const port = (api.address() as { port: number }).port;
  process.env["CODEX_BRIDGE_SOCKET"] = path.join(dir, "bridge.sock");
  process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] = `http://127.0.0.1:${port}/v1`;
  process.env["MODEL_BUSY_DELAYS_MS"] = "5,5";
});

afterAll(async () => {
  await new Promise((r) => bridge.close(r));
  await new Promise((r) => api.close(r));
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetRouteState();
  bridgeCalls.length = 0;
  apiCalls.length = 0;
  process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = "sk-test";
  delete process.env["MODEL_ON_LIMIT"];
  bridgeHandler = (req, _body, res) => {
    if (req.url === "/notify") return json(res, 200, { sent: true });
    return sse(res, answer("Ответ по подписке"));
  };
  apiHandler = (_req, _body, res) => sse(res, answer("Ответ по ключу"));
});

afterEach(() => vi.useRealTimers());

describe("ответ по подписке", () => {
  test("пояснения модели по ходу работы в ответ не попадают", async () => {
    const out = await askText({ model: "gpt-5.6-sol", system: "Система", user: "Вопрос" });
    expect(out).toEqual({ text: "Ответ по подписке", sources: [], route: "codex" });
    const sent = bridgeCalls[0];
    expect(sent.path).toBe("/responses");
    expect(sent.body).toMatchObject({
      model: "gpt-5.6-sol",
      instructions: "Система",
      stream: true,
      store: false,
      input: [{ role: "user", content: [{ type: "input_text", text: "Вопрос" }] }],
    });
    expect(apiCalls).toHaveLength(0);
  });

  test("JSON в обертке ```json разбирается", async () => {
    bridgeHandler = (_req, _body, res) => sse(res, answer('```json\n{"slides":[1,2]}\n```'));
    const out = await askJson<{ slides: number[] }>({ model: "m", system: "s", user: "u" });
    expect(out.slides).toEqual([1, 2]);
    expect((bridgeCalls[0].body as { instructions: string }).instructions).toContain("СТРОГО одним JSON");
  });

  test("ответ, оборванный потолком длины, - честная ошибка", async () => {
    bridgeHandler = (_req, _body, res) =>
      sse(res, [{ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }]);
    await expect(askText({ model: "m", system: "s", user: "u" })).rejects.toMatchObject({ kind: "incomplete" });
  });

  test("поток без response.completed не выдается за полный ответ", async () => {
    bridgeHandler = (_req, _body, res) =>
      sse(res, [{ type: "response.output_text.delta", item_id: "m1", delta: "Полови" }]);
    await expect(askText({ model: "m", system: "s", user: "u" })).rejects.toMatchObject({ kind: "connection" });
  });

  test("временное ограничение частоты - короткая пауза и повтор", async () => {
    let first = true;
    bridgeHandler = (req, _body, res) => {
      if (req.url === "/notify") return json(res, 200, { sent: true });
      if (first) {
        first = false;
        return json(res, 429, { error: { kind: "busy", status: 429 } });
      }
      return sse(res, answer("Со второго раза"));
    };
    const out = await askText({ model: "m", system: "s", user: "u" });
    expect(out.text).toBe("Со второго раза");
    expect(notices()).toHaveLength(0);
  });
});

describe("веб-поиск", () => {
  test("ссылки модели становятся номерами, utm-метки не плодят дубли", async () => {
    const text = "Фрейд ввел понятие ([wiki](https://ru.wikipedia.org/x?utm_source=openai)). Лакан спорил [журнал](https://j.org/a).";
    bridgeHandler = (_req, _body, res) =>
      sse(res, [
        { type: "response.output_item.done", item: { type: "web_search_call", status: "completed", action: { sources: [{ url: "https://ru.wikipedia.org/x" }] } } },
        {
          type: "response.completed",
          response: {
            status: "completed",
            output: [
              { type: "web_search_call", status: "completed", action: { sources: [{ url: "https://ru.wikipedia.org/x" }] } },
              {
                type: "message",
                content: [{ type: "output_text", text, annotations: [{ type: "url_citation", url: "https://j.org/a", title: "Журнал" }] }],
              },
            ],
          },
        },
      ]);
    const out = await askText({ model: "m", system: "s", user: "u", webSearch: true });
    expect(out.text).toBe("Фрейд ввел понятие [1]. Лакан спорил журнал [2].");
    expect(out.sources).toEqual([
      { n: 1, url: "https://ru.wikipedia.org/x", title: "wiki" },
      { n: 2, url: "https://j.org/a", title: "Журнал" },
    ]);
    expect(bridgeCalls[0].body).toMatchObject({
      tools: [{ type: "web_search", search_context_size: "high" }],
      tool_choice: "required",
      include: ["web_search_call.action.sources"],
    });
  });

  test("поиск не выполнился - ответ не принимается", async () => {
    bridgeHandler = (_req, _body, res) => sse(res, answer("Без поиска"));
    await expect(askText({ model: "m", system: "s", user: "u", webSearch: true })).rejects.toBeInstanceOf(ModelError);
  });

  test("numberSources без встроенных ссылок добавляет источники из аннотаций", () => {
    const out = numberSources("Текст", [{ url: "https://a.org", title: "A" }]);
    expect(out).toEqual({ text: "Текст", sources: [{ n: 1, url: "https://a.org/", title: "A" }] });
  });
});

describe("лимит подписки и запасной ключ", () => {
  const quota = (resetsAt: number): Handler => (req, _body, res) => {
    if (req.url === "/notify") return json(res, 200, { sent: true });
    return json(res, 429, { error: { kind: "quota", status: 429, resets_at: resetsAt } });
  };

  test("уведомление уходит до первого платного запроса, дальше - ключ без новых уведомлений", async () => {
    const resets = Math.floor(Date.now() / 1000) + 3600;
    bridgeHandler = quota(resets);

    const first = await askText({ model: "m", system: "s", user: "u" });
    expect(first).toMatchObject({ text: "Ответ по ключу", route: "api" });
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toContain("перешла на запасной ключ OpenAI API");
    expect(notices()[0]).toContain("лимит подписки Codex исчерпан");
    // Уведомление записано раньше, чем ушел платный запрос.
    const notifyAt = bridgeCalls.findIndex((c) => c.path === "/notify");
    expect(notifyAt).toBeGreaterThanOrEqual(0);
    expect(apiCalls).toHaveLength(1);

    const second = await askText({ model: "m", system: "s", user: "u" });
    expect(second.route).toBe("api");
    expect(bridgeCalls.filter((c) => c.path === "/responses")).toHaveLength(1);
    expect(notices()).toHaveLength(1);
  });

  test("после сброса лимита - снова подписка и уведомление о возврате", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const resets = Math.floor(Date.now() / 1000) + 600;
    bridgeHandler = quota(resets);
    await askText({ model: "m", system: "s", user: "u" });

    bridgeHandler = (req, _body, res) =>
      req.url === "/notify" ? json(res, 200, { sent: true }) : sse(res, answer("Снова подписка"));
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const back = await askText({ model: "m", system: "s", user: "u" });
    expect(back).toMatchObject({ text: "Снова подписка", route: "codex" });
    expect(notices().at(-1)).toContain("вернулась на подписку Codex");
  });

  test("без ключа API задача ждет сброса, уведомление об ожидании одно", async () => {
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = "";
    const resets = Math.floor(Date.now() / 1000) + 1800;
    bridgeHandler = quota(resets);

    const err = await askText({ model: "m", system: "s", user: "u" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelWaitError);
    expect((err as ModelWaitError).until.getTime()).toBe(resets * 1000);
    await askText({ model: "m", system: "s", user: "u" }).catch(() => undefined);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toContain("ждут");
    expect(apiCalls).toHaveLength(0);
  });

  test("отозванный вход без ключа - напоминание не чаще раза в 6 часов", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = "";
    bridgeHandler = (req, _body, res) =>
      req.url === "/notify" ? json(res, 200, { sent: true }) : json(res, 401, { error: { kind: "signin", status: 401 } });
    await askText({ model: "m", system: "s", user: "u" }).catch(() => undefined);
    vi.setSystemTime(Date.now() + 20 * 60_000);
    await askText({ model: "m", system: "s", user: "u" }).catch(() => undefined);
    expect(notices()).toHaveLength(1);
    vi.setSystemTime(Date.now() + 6 * 3600_000);
    await askText({ model: "m", system: "s", user: "u" }).catch(() => undefined);
    expect(notices()).toHaveLength(2);
  });

  test("MODEL_ON_LIMIT=wait - ключ есть, но платформа ждет", async () => {
    process.env["MODEL_ON_LIMIT"] = "wait";
    bridgeHandler = quota(Math.floor(Date.now() / 1000) + 600);
    await expect(askText({ model: "m", system: "s", user: "u" })).rejects.toBeInstanceOf(ModelWaitError);
    expect(apiCalls).toHaveLength(0);
  });

  test("уведомление не доставлено - на платный ключ не переходим", async () => {
    bridgeHandler = (req, _body, res) => {
      if (req.url === "/notify") return json(res, 502, { sent: false, reason: "telegram" });
      return json(res, 429, { error: { kind: "quota", status: 429, resets_at: Math.floor(Date.now() / 1000) + 600 } });
    };
    await expect(askText({ model: "m", system: "s", user: "u" })).rejects.toBeInstanceOf(ModelWaitError);
    expect(apiCalls).toHaveLength(0);
  });

  test("часовой лимит сообщений исчерпан - на платный ключ не переходим", async () => {
    bridgeHandler = (req, _body, res) => {
      if (req.url === "/notify") return json(res, 429, { sent: false, reason: "rate_limited" });
      return json(res, 429, { error: { kind: "quota", status: 429, resets_at: Math.floor(Date.now() / 1000) + 600 } });
    };
    await expect(askText({ model: "m", system: "s", user: "u" })).rejects.toBeInstanceOf(ModelWaitError);
    expect(apiCalls).toHaveLength(0);
  });

  test("такое же сообщение уже ушло недавно - считается доставленным", async () => {
    bridgeHandler = (req, _body, res) => {
      if (req.url === "/notify") return json(res, 200, { sent: false, reason: "duplicate" });
      return json(res, 429, { error: { kind: "quota", status: 429, resets_at: Math.floor(Date.now() / 1000) + 600 } });
    };
    const out = await askText({ model: "m", system: "s", user: "u" });
    expect(out.route).toBe("api");
  });

  test("мост не отвечает - тоже ожидание, а не платный ключ без уведомления", async () => {
    const saved = process.env["CODEX_BRIDGE_SOCKET"];
    process.env["CODEX_BRIDGE_SOCKET"] = path.join(dir, "missing.sock");
    try {
      const err = await askText({ model: "m", system: "s", user: "u" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ModelWaitError);
      expect((err as ModelWaitError).kind).toBe("bridge");
      expect(apiCalls).toHaveLength(0);
    } finally {
      process.env["CODEX_BRIDGE_SOCKET"] = saved;
    }
  });

  test("отказ во входе в подписку - ключ API с уведомлением о причине", async () => {
    bridgeHandler = (req, _body, res) =>
      req.url === "/notify" ? json(res, 200, { sent: true }) : json(res, 401, { error: { kind: "signin", status: 401 } });
    const out = await askText({ model: "m", system: "s", user: "u" });
    expect(out.route).toBe("api");
    expect(notices()[0]).toContain("отклонил вход");
  });
});

describe("картинки", () => {
  test("по подписке - через мост, с подсказкой о кадрировании 16:9", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0]);
    bridgeHandler = (_req, _body, res) => json(res, 200, { b64: png.toString("base64"), mime: "image/png", width: 1536, height: 864 });
    const out = await drawImage("Гравюра");
    expect(out.route).toBe("codex");
    expect(out.buffer.equals(png)).toBe(true);
    const sent = bridgeCalls[0];
    expect(sent.path).toBe("/images");
    expect(sent.body).toMatchObject({ size: "1536x864" });
    expect((sent.body as { prompt: string }).prompt).toContain("16:9");
  });

  test("по ключу - images/generations с размером 1536x864", async () => {
    bridgeHandler = (req, _body, res) =>
      req.url === "/notify"
        ? json(res, 200, { sent: true })
        : json(res, 429, { error: { kind: "quota", resets_at: Math.floor(Date.now() / 1000) + 600 } });
    apiHandler = (_req, _body, res) => json(res, 200, { data: [{ b64_json: Buffer.from("img").toString("base64") }] });
    const out = await drawImage("Гравюра");
    expect(out.route).toBe("api");
    expect(apiCalls[0]).toMatchObject({ path: "/v1/images/generations", body: { model: "gpt-image-2", size: "1536x864" } });
  });
});

describe("разбор ошибок", () => {
  test("исчерпанный баланс ключа API - не повод ждать сброса", () => {
    const err = classify(429, JSON.stringify({ error: { code: "insufficient_quota" } }), "api");
    expect(err.kind).toBe("unavailable");
  });

  test("лимит Codex с resets_in_seconds", () => {
    const err = classify(429, JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 120 } }), "codex");
    expect(err.kind).toBe("quota");
    expect(err.resetsAt!.getTime()).toBeGreaterThan(Date.now() + 100_000);
  });

  test("слишком длинный материал", () => {
    expect(classify(400, JSON.stringify({ error: { code: "context_length_exceeded" } }), "codex").kind).toBe("context");
  });
});
