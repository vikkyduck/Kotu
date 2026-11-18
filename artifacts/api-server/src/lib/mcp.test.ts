import http from "node:http";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * MCP-сервер для агента: вход по токену, протокол JSON-RPC и инструменты
 * как обертки над API платформы. API подменен: тест видит, какие запросы
 * агент отправил бы сайту и с какой сессией.
 */

vi.mock("./auth", () => ({
  SESSION_COOKIE: "kot_session",
  createSession: vi.fn(async () => ({ token: "agent-session", expiresAt: new Date(Date.now() + 30 * 86400_000) })),
}));

import { createMcpServer } from "./mcp";

const TOKEN = "secret-token";
const apiCalls: { method: string; url: string; cookie: string; body: unknown }[] = [];
let apiReply: (method: string, url: string) => { status: number; body: unknown };

let server: http.Server;
let port = 0;

function rpc(body: unknown, token: string | null = TOKEN, method = "POST"): Promise<{ status: number; body: unknown }> {
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null });
        });
      },
    );
    req.on("error", reject);
    req.end(method === "POST" ? data : undefined);
  });
}

const call = (name: string, args: Record<string, unknown>) =>
  rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } });

beforeAll(async () => {
  vi.stubGlobal("fetch", async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    apiCalls.push({ method: init.method, url, cookie: init.headers["cookie"], body: init.body ? JSON.parse(init.body) : undefined });
    const { status, body } = apiReply(init.method, url);
    return { status, text: async () => JSON.stringify(body) };
  });
  server = createMcpServer({
    port: 0,
    tokenSha256: createHash("sha256").update(TOKEN).digest(),
    userId: 1,
    apiBase: "http://platform/api",
    publicBase: "https://psy3107.ru",
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  apiCalls.length = 0;
  apiReply = () => ({ status: 200, body: {} });
});

describe("вход", () => {
  test("без токена и с чужим токеном - 401", async () => {
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, null)).status).toBe(401);
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, "wrong")).status).toBe(401);
  });

  test("поток событий от сервера не предлагается - GET 405", async () => {
    expect((await rpc(null, TOKEN, "GET")).status).toBe(405);
  });
});

describe("протокол", () => {
  test("initialize отвечает версией клиента и возможностью tools", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {} } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "psy3107" } },
    });
  });

  test("уведомление без id - 202 без тела", async () => {
    const res = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res).toEqual({ status: 202, body: null });
  });

  test("tools/list - инструменты библиотеки, лекций, расшифровок и презентаций", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = (res.body as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(names).toEqual([
      "library_search",
      "lectures_list",
      "lecture_get",
      "lecture_create",
      "lecture_approve_plan",
      "transcriptions_list",
      "transcription_get",
      "deck_create_from_lecture",
      "deck_get",
      "deck_approve",
    ]);
  });

  test("неизвестный метод - ошибка JSON-RPC", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 3, method: "resources/list" });
    expect(res.body).toMatchObject({ error: { code: -32601 } });
  });
});

describe("инструменты", () => {
  test("поиск по библиотеке идет в API от имени владелицы", async () => {
    apiReply = () => ({
      status: 200,
      body: { results: [{ documentId: 5, title: "Толкование сновидений", kind: "book", quotes: [{ heading: "Глава 2", text: "Сон есть исполнение желания" }] }] },
    });
    const res = await call("library_search", { query: "сновидение" });
    const text = (res.body as { result: { content: { text: string }[] } }).result.content[0].text;
    expect(text).toContain("Толкование сновидений (book, документ 5)");
    expect(text).toContain("Глава 2: Сон есть исполнение желания");
    expect(apiCalls[0]).toMatchObject({ method: "GET", url: "http://platform/api/search?q=%D1%81%D0%BD%D0%BE%D0%B2%D0%B8%D0%B4%D0%B5%D0%BD%D0%B8%D0%B5", cookie: "kot_session=agent-session" });
  });

  test("заказ лекции - POST /lectures, ответ со ссылкой", async () => {
    apiReply = () => ({ status: 201, body: { id: 12 } });
    const res = await call("lecture_create", { topic: "Перенос у Фрейда", durationMin: 60, documentIds: [5] });
    const text = (res.body as { result: { content: { text: string }[] } }).result.content[0].text;
    expect(text).toContain("Лекция 12 заказана");
    expect(text).toContain("https://psy3107.ru/#/lecture/12");
    expect(apiCalls[0]).toMatchObject({
      method: "POST",
      url: "http://platform/api/lectures",
      body: { topic: "Перенос у Фрейда", durationMin: 60, useLibrary: true, documentIds: [5], useResearch: false },
    });
  });

  test("отказ платформы - ошибка инструмента ее словами", async () => {
    apiReply = () => ({ status: 409, body: { message: "План пуст" } });
    const res = await call("lecture_approve_plan", { id: 3 });
    expect(res.body).toMatchObject({ result: { isError: true, content: [{ type: "text", text: "План пуст" }] } });
  });

  test("неверный номер - понятная ошибка, в API запрос не уходит", async () => {
    const res = await call("deck_get", { id: "abc" });
    expect(res.body).toMatchObject({ result: { isError: true } });
    expect(apiCalls).toHaveLength(0);
  });

  test("сессию закрыли - одна попытка с новой", async () => {
    let first = true;
    apiReply = () => {
      if (first) {
        first = false;
        return { status: 401, body: { message: "Нужно войти" } };
      }
      return { status: 200, body: [{ id: 1, title: "Запись", status: "done" }] };
    };
    const res = await call("transcriptions_list", {});
    const text = (res.body as { result: { content: { text: string }[] } }).result.content[0].text;
    expect(text).toBe("1. Запись - done");
    expect(apiCalls).toHaveLength(2);
  });
});
