import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { createSession, SESSION_COOKIE } from "./auth";
import { logger } from "./logger";

/**
 * MCP-сервер платформы для агента ПСИ (Hermes в личке владелицы).
 *
 * Слушает только 127.0.0.1 (по умолчанию порт 5011): nginx его не
 * проксирует, снаружи сервера он недоступен. Вход - токен в заголовке
 * Authorization: Bearer. В .env платформы лежит только SHA-256 токена
 * (AGENT_MCP_TOKEN_SHA256), сам токен - в .env профиля агента.
 *
 * Инструменты ничего не делают в обход сайта: каждый вызов - обычный
 * запрос к API платформы от имени владелицы (AGENT_MCP_USER_ID). Поэтому
 * права, проверки и архив работают так же, как в браузере.
 *
 * Протокол: MCP Streamable HTTP без сессий, ответы - JSON.
 */

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 1024 * 1024;
/**
 * Сколько текста отдаём агенту за один ответ. Было 60 тыс. - бот видел только
 * начало длинной лекции или записи. 300 тыс. знаков вмещают четырёхчасовую
 * лекцию целиком и всё ещё помещаются в окно модели бота.
 */
const MAX_TEXT = 300_000;

interface McpConfig {
  port: number;
  tokenSha256: Buffer;
  userId: number;
  apiBase: string;
  publicBase: string;
}

export function mcpConfig(): McpConfig | null {
  const raw = process.env["AGENT_MCP_PORT"] ?? "5011";
  const port = Number(raw);
  const hash = (process.env["AGENT_MCP_TOKEN_SHA256"] ?? "").trim().toLowerCase();
  const userId = Number(process.env["AGENT_MCP_USER_ID"] ?? "");
  if (raw === "off" || !Number.isInteger(port) || port <= 0) return null;
  if (!/^[0-9a-f]{64}$/.test(hash) || !Number.isInteger(userId) || userId <= 0) return null;
  return {
    port,
    tokenSha256: Buffer.from(hash, "hex"),
    userId,
    apiBase: `http://127.0.0.1:${process.env["PORT"] ?? "5010"}/api`,
    publicBase: (process.env["PUBLIC_BASE_URL"] ?? "https://psy3107.ru").replace(/\/+$/, ""),
  };
}

// ─── Запросы к API платформы от имени владелицы ─────────────────────────────

class PlatformApi {
  private session: { token: string; expiresAt: Date } | null = null;

  constructor(private readonly cfg: McpConfig) {}

  private async cookie(fresh = false): Promise<string> {
    const dayAhead = Date.now() + 24 * 3600_000;
    if (fresh || !this.session || this.session.expiresAt.getTime() < dayAhead) {
      this.session = await createSession(this.cfg.userId);
    }
    return `${SESSION_COOKIE}=${this.session.token}`;
  }

  async call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    for (const fresh of [false, true]) {
      const res = await fetch(`${this.cfg.apiBase}${path}`, {
        method,
        headers: { cookie: await this.cookie(fresh), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      // Сессию могли закрыть (смена пароля закрывает все) - одна попытка с новой.
      if (res.status === 401 && !fresh) continue;
      const text = await res.text();
      let data: unknown = text;
      try {
        data = JSON.parse(text);
      } catch {
        // не JSON - отдаем как текст
      }
      return { status: res.status, data };
    }
    return { status: 401, data: { message: "Платформа не приняла вход агента" } };
  }

  link(kind: "lecture" | "deck" | "record", id: number): string {
    return `${this.cfg.publicBase}/#/${kind}/${id}`;
  }
}

// ─── Инструменты ─────────────────────────────────────────────────────────────

type Args = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Args, api: PlatformApi) => Promise<string>;
}

class ToolError extends Error {}

function int(args: Args, key: string): number {
  const value = Number(args[key]);
  if (!Number.isInteger(value) || value <= 0) throw new ToolError(`Нужен номер: ${key}`);
  return value;
}

function str(args: Args, key: string, required = false): string | undefined {
  const value = args[key];
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (required) throw new ToolError(`Нужен текст: ${key}`);
  return undefined;
}

function cap(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n[текст обрезан: показаны первые ${MAX_TEXT} знаков]` : text;
}

/** Ответ платформы с ошибкой - ее же словами, без технических подробностей. */
function failed(res: { status: number; data: unknown }): never {
  const message =
    typeof res.data === "object" && res.data !== null && typeof (res.data as { message?: unknown }).message === "string"
      ? (res.data as { message: string }).message
      : `Платформа ответила ошибкой ${res.status}`;
  throw new ToolError(message);
}

type Row = Record<string, unknown>;
const rows = (data: unknown, key?: string): Row[] => {
  const list = key && typeof data === "object" && data !== null ? (data as Row)[key] : data;
  return Array.isArray(list) ? (list as Row[]) : [];
};
const s = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

const STATUS_HINT: Record<string, string> = {
  plan_ready: "план готов и ждет утверждения (lecture_approve_plan)",
  storyboard_ready: "раскадровка готова и ждет утверждения (deck_approve)",
};

const TOOLS: Tool[] = [
  {
    name: "library_search",
    description:
      "Поиск по библиотеке платформы psy3107: книги, статьи, лекции, расшифровки. Возвращает до 8 материалов с цитатами.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Что искать, своими словами" } },
      required: ["query"],
    },
    run: async (args, api) => {
      const query = str(args, "query", true)!;
      const res = await api.call("GET", `/search?q=${encodeURIComponent(query)}`);
      if (res.status !== 200) failed(res);
      const found = rows(res.data, "results");
      if (found.length === 0) return "В библиотеке ничего не нашлось.";
      return cap(
        found
          .map((r, i) => {
            const quotes = rows(r["quotes"]).map((q) => `   - ${q["heading"] ? `${s(q["heading"])}: ` : ""}${s(q["text"])}`);
            return [`${i + 1}. ${s(r["title"])} (${s(r["kind"])}, документ ${s(r["documentId"])})`, ...quotes].join("\n");
          })
          .join("\n\n"),
      );
    },
  },
  {
    name: "lectures_list",
    description: "Список лекций на платформе: номер, название, состояние.",
    inputSchema: { type: "object", properties: {} },
    run: async (_args, api) => {
      const res = await api.call("GET", "/lectures");
      if (res.status !== 200) failed(res);
      const list = rows(res.data);
      if (list.length === 0) return "Лекций пока нет.";
      return cap(list.map((l) => `${s(l["id"])}. ${s(l["title"])} - ${s(l["status"])}`).join("\n"));
    },
  },
  {
    name: "lecture_get",
    description: "Лекция целиком: состояние, план, текст глав, источники, ссылка на сайт.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer", description: "Номер лекции" } },
      required: ["id"],
    },
    run: async (args, api) => {
      const id = int(args, "id");
      const res = await api.call("GET", `/lectures/${id}`);
      if (res.status !== 200) failed(res);
      const l = res.data as Row;
      const status = s(l["status"]);
      const out = [`Лекция ${id}: ${s(l["title"])}`, `Состояние: ${STATUS_HINT[status] ?? status}`, `Ссылка: ${api.link("lecture", id)}`];
      if (s(l["statusMessage"])) out.push(`Сейчас: ${s(l["statusMessage"])}`);
      if (s(l["error"])) out.push(`Ошибка: ${s(l["error"])}`);
      const plan = rows(l["plan"]);
      if (plan.length > 0) out.push("", "План:", ...plan.map((p, i) => `${i + 1}. ${s(p["heading"])} - ${s(p["abstract"])}`));
      const sections = rows(l["sections"]).filter((x) => s(x["text"]) !== "");
      for (const sec of sections) out.push("", `## ${s(sec["heading"])}`, s(sec["text"]));
      const sources = rows(l["sources"]);
      if (sources.length > 0) {
        out.push("", "Источники:", ...sources.map((src, i) => `[${i + 1}] ${s(src["title"])}${src["url"] ? ` - ${s(src["url"])}` : ""}`));
      }
      return cap(out.join("\n"));
    },
  },
  {
    name: "lecture_create",
    description:
      "Заказать новую лекцию. Платформа сначала составит план, его нужно утвердить инструментом lecture_approve_plan, потом пишутся главы.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Тема и замысел лекции" },
        durationMin: { type: "integer", description: "Длительность в минутах, 30-240, по умолчанию 90" },
        audience: { type: "string", description: "Аудитория, необязательно" },
        useResearch: { type: "boolean", description: "Собрать материал веб-поиском" },
        documentIds: {
          type: "array",
          items: { type: "integer" },
          description: "Документы библиотеки, на которые опереться (номера из library_search)",
        },
        mustInclude: { type: "string", description: "Что обязательно включить" },
        mustAvoid: { type: "string", description: "Чего избегать" },
      },
      required: ["topic"],
    },
    run: async (args, api) => {
      const documentIds = Array.isArray(args["documentIds"]) ? args["documentIds"].map(Number).filter(Number.isInteger) : [];
      const res = await api.call("POST", "/lectures", {
        topic: str(args, "topic", true),
        durationMin: args["durationMin"],
        audience: str(args, "audience"),
        useResearch: args["useResearch"] === true,
        useLibrary: documentIds.length > 0,
        documentIds,
        mustInclude: str(args, "mustInclude"),
        mustAvoid: str(args, "mustAvoid"),
      });
      if (res.status !== 201) failed(res);
      const id = Number((res.data as Row)["id"]);
      return `Лекция ${id} заказана, платформа составляет план. Когда план будет готов, придет уведомление. Ссылка: ${api.link("lecture", id)}`;
    },
  },
  {
    name: "lecture_approve_plan",
    description: "Утвердить план лекции: платформа начнет писать главы.",
    inputSchema: { type: "object", properties: { id: { type: "integer", description: "Номер лекции" } }, required: ["id"] },
    run: async (args, api) => {
      const id = int(args, "id");
      const res = await api.call("POST", `/lectures/${id}/plan/approve`);
      if (res.status >= 300) failed(res);
      return `План лекции ${id} утвержден, главы пишутся. Ссылка: ${api.link("lecture", id)}`;
    },
  },
  {
    name: "transcriptions_list",
    description: "Список расшифровок записей: номер, название, состояние.",
    inputSchema: { type: "object", properties: {} },
    run: async (_args, api) => {
      const res = await api.call("GET", "/transcriptions");
      if (res.status !== 200) failed(res);
      const list = rows(res.data);
      if (list.length === 0) return "Расшифровок пока нет.";
      return cap(list.map((t) => `${s(t["id"])}. ${s(t["title"])} - ${s(t["status"])}`).join("\n"));
    },
  },
  {
    name: "transcription_get",
    description: "Текст расшифровки записи по репликам.",
    inputSchema: { type: "object", properties: { id: { type: "integer", description: "Номер расшифровки" } }, required: ["id"] },
    run: async (args, api) => {
      const id = int(args, "id");
      const res = await api.call("GET", `/transcriptions/${id}`);
      if (res.status !== 200) failed(res);
      const t = res.data as Row;
      const lines = rows(t["segments"]).map((seg) => (s(seg["who"]) ? `${s(seg["who"])}: ${s(seg["text"])}` : s(seg["text"])));
      return cap([`Расшифровка ${id}: ${s(t["title"])} (${s(t["status"])})`, `Ссылка: ${api.link("record", id)}`, "", ...lines].join("\n"));
    },
  },
  {
    name: "deck_create_from_lecture",
    description:
      "Сделать презентацию по готовой лекции. Платформа разложит лекцию по слайдам, раскадровку нужно утвердить инструментом deck_approve.",
    inputSchema: {
      type: "object",
      properties: { lectureId: { type: "integer", description: "Номер готовой лекции" }, title: { type: "string" } },
      required: ["lectureId"],
    },
    run: async (args, api) => {
      const res = await api.call("POST", "/decks", { sourceKind: "lecture", sourceId: int(args, "lectureId"), title: str(args, "title") });
      if (res.status !== 201) failed(res);
      const id = Number((res.data as Row)["id"]);
      return `Презентация ${id} заказана, идет раскадровка. Ссылка: ${api.link("deck", id)}`;
    },
  },
  {
    name: "deck_get",
    description: "Состояние презентации: этап, сообщение, число слайдов, ссылка.",
    inputSchema: { type: "object", properties: { id: { type: "integer", description: "Номер презентации" } }, required: ["id"] },
    run: async (args, api) => {
      const id = int(args, "id");
      const res = await api.call("GET", `/decks/${id}`);
      if (res.status !== 200) failed(res);
      const d = res.data as Row;
      const status = s(d["status"]);
      const out = [`Презентация ${id}: ${s(d["title"])}`, `Состояние: ${STATUS_HINT[status] ?? status}`, `Слайдов: ${rows(d["slides"]).length}`, `Ссылка: ${api.link("deck", id)}`];
      if (s(d["statusMessage"])) out.push(`Сейчас: ${s(d["statusMessage"])}`);
      if (s(d["error"])) out.push(`Ошибка: ${s(d["error"])}`);
      return out.join("\n");
    },
  },
  {
    name: "deck_approve",
    description: "Утвердить раскадровку презентации: платформа начнет рисовать иллюстрации.",
    inputSchema: { type: "object", properties: { id: { type: "integer", description: "Номер презентации" } }, required: ["id"] },
    run: async (args, api) => {
      const id = int(args, "id");
      const res = await api.call("POST", `/decks/${id}/approve`);
      if (res.status >= 300) failed(res);
      return `Раскадровка презентации ${id} утверждена, рисуются иллюстрации. Ссылка: ${api.link("deck", id)}`;
    },
  },
];

// ─── Протокол ────────────────────────────────────────────────────────────────

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type RpcReply = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

export async function handleRpc(msg: RpcMessage, api: PlatformApi): Promise<RpcReply | null> {
  const isRequest = msg.id !== undefined && msg.id !== null;
  const reply = (result: unknown): RpcReply => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const fail = (code: number, message: string): RpcReply => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });

  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return isRequest ? fail(-32600, "Invalid Request") : null;
  if (!isRequest) return null; // уведомления (notifications/initialized и др.) ответа не требуют

  switch (msg.method) {
    case "initialize": {
      const asked = typeof msg.params?.["protocolVersion"] === "string" ? (msg.params["protocolVersion"] as string) : "";
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "psy3107", version: "1.0.0" },
        instructions:
          "Инструменты платформы psy3107: библиотека, лекции, расшифровки, презентации. " +
          "Лекция и презентация делаются в два шага: сначала план или раскадровка, потом утверждение.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const name = msg.params?.["name"];
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return fail(-32602, `Unknown tool: ${String(name)}`);
      const args = (msg.params?.["arguments"] ?? {}) as Args;
      try {
        const text = await tool.run(typeof args === "object" && args !== null ? args : {}, api);
        return reply({ content: [{ type: "text", text }] });
      } catch (err) {
        const message = err instanceof ToolError ? err.message : "Платформа не смогла выполнить действие";
        if (!(err instanceof ToolError)) logger.error({ err, tool: tool.name }, "Сбой инструмента MCP");
        return reply({ content: [{ type: "text", text: message }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

function authorized(header: string | undefined, expected: Buffer): boolean {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  if (!match) return false;
  const got = createHash("sha256").update(match[1]).digest();
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export function createMcpServer(cfg: McpConfig): http.Server {
  const api = new PlatformApi(cfg);
  return http.createServer((req, res) => {
    const send = (status: number, body?: unknown): void => {
      res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if ((req.url ?? "").split("?")[0] !== "/mcp") return send(404, { error: "not found" });
    if (!authorized(req.headers.authorization, cfg.tokenSha256)) return send(401, { error: "unauthorized" });
    // Потока событий от сервера нет: инструменты отвечают сразу.
    if (req.method !== "POST") return send(405, { error: "method not allowed" });

    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      void (async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        }
        const batch = Array.isArray(parsed);
        const messages = (batch ? parsed : [parsed]) as RpcMessage[];
        const replies = (await Promise.all(messages.map((m) => handleRpc(m, api)))).filter((r): r is RpcReply => r !== null);
        if (replies.length === 0) return send(202);
        return send(200, batch ? replies : replies[0]);
      })().catch((err) => {
        logger.error({ err }, "Сбой MCP");
        send(500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } });
      });
    });
  });
}

/** Запускает MCP, если он настроен. Без настроек молчит: платформа работает и без агента. */
export function startMcpServer(): void {
  const cfg = mcpConfig();
  if (!cfg) {
    logger.info("MCP для агента не настроен (AGENT_MCP_TOKEN_SHA256, AGENT_MCP_USER_ID) - не запускаю");
    return;
  }
  const server = createMcpServer(cfg);
  server.listen(cfg.port, "127.0.0.1", () => logger.info({ port: cfg.port }, "MCP для агента слушает 127.0.0.1"));
  server.on("error", (err) => logger.error({ err }, "MCP для агента не запустился"));
}
