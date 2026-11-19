import http from "node:http";
import { readFile } from "node:fs/promises";
import { logger } from "./logger";
import { JSON_RULE, parseModelJson } from "./model-json";
import { notifyOwner } from "./notify";

/**
 * Единственный путь платформы к моделям (ARCHITECTURE.md §5).
 *
 * Основной маршрут - подписка Codex владелицы. Платформа не держит вход в
 * подписку и не продлевает его: запросы уходят в локальный мост ПСИ
 * (psy-platform-bridge, Unix-сокет), а мост берет токен у Hermes. Так у входа
 * остается один владелец, и два продления одного ключа не аннулируют вход.
 *
 * Запасной маршрут - ключ OpenAI API. Платформа переходит на него, только
 * когда подписка недоступна (лимит, вход отозван, мост не выдает токен), и
 * только после того, как владелица получила уведомление в Telegram. Если
 * уведомление не ушло, платформа не платит молча, а ждет.
 *
 * Формат запросов один на оба маршрута: Responses API с потоком событий.
 */

export type Route = "codex" | "api";
export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

export interface ImageAttachment {
  path: string;
  mediaType: ImageMime;
}

export interface WebSource {
  n: number;
  url: string;
  title: string;
}

export interface Answer {
  text: string;
  /** Источники веб-поиска по порядку первого упоминания. */
  sources: WebSource[];
  route: Route;
}

export interface AskOptions {
  model: string;
  system: string;
  user: string;
  /** Картинки, на которые модель должна посмотреть. */
  images?: ImageAttachment[];
  /** Веб-поиск Codex: модель обязана сходить в поиск хотя бы раз. */
  webSearch?: boolean;
  /**
   * Глубина рассуждения. Не задана - Codex берёт свою (проверено 19.11.2026:
   * medium, как у бота в Telegram). Мост платформы пропускает low, medium, high.
   */
  effort?: Effort;
}

export type Effort = "low" | "medium" | "high";
const EFFORTS: readonly Effort[] = ["low", "medium", "high"];

/** Глубина из .env (например EFFORT_LECTURE=high); пусто или неизвестное слово - fallback. */
export function pickEffort(envName: string, fallback: Effort): Effort {
  const raw = (process.env[envName] ?? "").trim().toLowerCase();
  return (EFFORTS as readonly string[]).includes(raw) ? (raw as Effort) : fallback;
}

/**
 * Виды сбоев. quota, signin, access_wait и bridge - сбои маршрута целиком:
 * на них платформа переходит на запасной путь или ждет. Остальное - сбой
 * одного запроса, его повторяет очередь.
 */
export type IssueKind =
  | "quota"
  | "signin"
  | "access_wait"
  | "bridge"
  | "busy"
  | "context"
  | "timeout"
  | "connection"
  | "unavailable"
  | "bad_request"
  | "refused"
  | "incomplete";

const ROUTE_KINDS = new Set<IssueKind>(["quota", "signin", "access_wait", "bridge"]);

export class ModelError extends Error {
  constructor(
    message: string,
    readonly kind: IssueKind,
    readonly route: Route = "codex",
    /** Для quota: когда подписка снова доступна, если сервер это сообщил. */
    readonly resetsAt: Date | null = null,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

/**
 * Модели сейчас недоступны, а запасного пути нет или он выключен.
 * Очередь не тратит на это попытку, а откладывает задачу до until.
 */
export class ModelWaitError extends Error {
  constructor(
    message: string,
    readonly until: Date,
    readonly kind: IssueKind,
  ) {
    super(message);
    this.name = "ModelWaitError";
  }
}

// ─── Настройки ───────────────────────────────────────────────────────────────

/** Читаем окружение при каждом вызове: тесты и смена .env не требуют пересборки. */
function cfg() {
  return {
    socket: process.env["CODEX_BRIDGE_SOCKET"] ?? "/run/psy-platform-bridge.sock",
    apiBase: (process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey: process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ?? "",
    /** api - переходить на ключ API, wait - ждать подписку. */
    onLimit: (process.env["MODEL_ON_LIMIT"] ?? "api") === "wait" ? "wait" : "api",
    imageSize: process.env["IMAGE_SIZE"] ?? "1536x864",
    imageQuality: process.env["IMAGE_QUALITY"] ?? "medium",
    imageModel: pickModel("MODEL_IMAGE", "gpt-image-2"),
    timeZone: process.env["NOTIFY_TZ"] ?? "Europe/Moscow",
    /** Сколько ждать новых байтов ответа, прежде чем признать обрыв. */
    idleMs: Number(process.env["MODEL_IDLE_MS"] ?? 300_000),
    /** Пауза перед повтором при временном ограничении частоты. */
    busyDelaysMs: (process.env["MODEL_BUSY_DELAYS_MS"] ?? "20000,60000")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n >= 0),
  };
}

/**
 * Модель из .env. Старые значения прежних поставщиков (claude-*, gemini-*,
 * sonar-*) Codex не примет, поэтому вместо них берем значение по умолчанию
 * и оставляем след в журнале: так старый .env не ломает переезд.
 */
export function pickModel(envName: string, fallback: string): string {
  const raw = (process.env[envName] ?? "").trim();
  if (raw === "") return fallback;
  if (/^(claude|gemini|sonar|anthropic)/i.test(raw)) {
    logger.warn({ envName, configured: raw, used: fallback }, "Модель прежнего поставщика в .env - беру модель Codex");
    return fallback;
  }
  return raw;
}

/**
 * Модели задач: переменная .env и значение по умолчанию. Одно место и для
 * задач (транскрипция, лекции, презентации), и для самопроверки: умолчание
 * поменяли здесь - поменялось везде.
 */
const MODEL_DEFAULTS = {
  MODEL_STRUCTURE: "gpt-5.6-sol",
  MODEL_LECTURE: "gpt-6.1-sol",
  MODEL_DECK: "gpt-5.6-sol",
  MODEL_SCENE: "gpt-5.6-sol",
  MODEL_REVIEW: "gpt-5.6-sol",
} as const;

export type ModelTask = keyof typeof MODEL_DEFAULTS | "MODEL_RESEARCH";
export const MODEL_TASKS: readonly ModelTask[] = [...(Object.keys(MODEL_DEFAULTS) as ModelTask[]), "MODEL_RESEARCH"];

/** Модель задачи: из .env или по умолчанию; веб-исследование - как лекция, если своей нет. */
export function modelFor(task: ModelTask): string {
  if (task === "MODEL_RESEARCH") return pickModel("MODEL_RESEARCH", modelFor("MODEL_LECTURE"));
  return pickModel(task, MODEL_DEFAULTS[task]);
}

// ─── Состояние маршрута ──────────────────────────────────────────────────────

interface FallbackState {
  /** Платформа сейчас работает по ключу API. */
  active: boolean;
  /** До какого времени не пробовать подписку снова. */
  until: number;
  /** Ждем без запасного пути: уведомление уже ушло, повторять не нужно. */
  waitingNoticeUntil: number;
}

const state: FallbackState = { active: false, until: 0, waitingNoticeUntil: 0 };

/** Для тестов: вернуть маршрут в исходное состояние. */
export function resetRouteState(): void {
  state.active = false;
  state.until = 0;
  state.waitingNoticeUntil = 0;
}

function clock(date: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: cfg().timeZone,
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function reasonText(kind: IssueKind): string {
  switch (kind) {
    case "quota":
      return "лимит подписки Codex исчерпан";
    case "signin":
      return "Codex отклонил вход в подписку, нужен повторный вход в агенте";
    case "access_wait":
      return "агент временно не выдает доступ к Codex";
    case "bridge":
      return "мост ПСИ к Codex не отвечает";
    default:
      return "Codex недоступен";
  }
}

/** Когда снова пробовать подписку. */
function retryAt(err: ModelError): Date {
  const now = Date.now();
  if (err.kind === "quota") {
    const at = err.resetsAt?.getTime() ?? now + 60 * 60_000;
    // Сервер может прислать прошедшее время или неделю вперед: держим в рамках.
    return new Date(Math.min(Math.max(at, now + 60_000), now + 8 * 24 * 3600_000));
  }
  if (err.kind === "signin") return new Date(now + 15 * 60_000);
  return new Date(now + 5 * 60_000);
}

/**
 * Выполняет запрос по текущему маршруту и переключает маршрут, когда
 * подписка недоступна. Вся логика запасного пути - здесь, обработчики о ней
 * не знают.
 */
async function withRoute<T>(run: (route: Route) => Promise<T>): Promise<T> {
  const settings = cfg();
  if (state.active && Date.now() < state.until) {
    return run("api");
  }

  try {
    const out = await withBusyRetry(() => run("codex"));
    if (state.active) {
      state.active = false;
      state.waitingNoticeUntil = 0;
      logger.info("Платформа вернулась на подписку Codex");
      await notifyOwner("Платформа psy3107 вернулась на подписку Codex. Ключ API больше не расходуется.");
    }
    state.waitingNoticeUntil = 0;
    return out;
  } catch (err) {
    if (!(err instanceof ModelError) || !ROUTE_KINDS.has(err.kind)) throw err;
    const until = retryAt(err);

    const canFallBack = settings.onLimit === "api" && settings.apiKey !== "";
    if (canFallBack && state.active) {
      // Подписку пробовали снова - еще недоступна. Остаемся на ключе молча.
      state.until = until.getTime();
      return run("api");
    }
    if (canFallBack) {
      // Переход на платный ключ - только после доставленного уведомления.
      const delivered = await notifyOwner(
        `Платформа psy3107 перешла на запасной ключ OpenAI API: ${reasonText(err.kind)}. ` +
          `Запросы теперь оплачиваются по объему. Подписку попробую снова ${clock(until)} по Москве.`,
      );
      if (delivered) {
        state.active = true;
        state.until = until.getTime();
        logger.warn({ kind: err.kind, until }, "Подписка Codex недоступна - перехожу на ключ API");
        return run("api");
      }
      logger.warn({ kind: err.kind }, "Уведомление о переходе на ключ API не доставлено - жду подписку");
    }

    if (Date.now() >= state.waitingNoticeUntil) {
      // Одно сообщение на эпизод: при отозванном входе подписку пробуем каждые
      // 15 минут, но напоминаем не чаще раза в 6 часов.
      state.waitingNoticeUntil = Math.max(until.getTime(), Date.now() + 6 * 3600_000);
      await notifyOwner(
        `Задачи платформы psy3107 ждут: ${reasonText(err.kind)}. Продолжу ${clock(until)} по Москве.`,
      );
    }
    throw new ModelWaitError(`Ждем Codex: ${reasonText(err.kind)}. Продолжу ${clock(until)} по Москве`, until, err.kind);
  }
}

/** Временное ограничение частоты: пара коротких пауз, потом обычный повтор очереди. */
async function withBusyRetry<T>(run: () => Promise<T>): Promise<T> {
  const delays = cfg().busyDelaysMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (!(err instanceof ModelError) || err.kind !== "busy" || attempt >= delays.length) throw err;
      logger.warn({ attempt: attempt + 1, delayMs: delays[attempt] }, "Codex ограничил частоту - подожду");
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

// ─── Транспорт ───────────────────────────────────────────────────────────────

interface Upstream {
  status: number;
  body: AsyncIterable<Uint8Array>;
}

/** POST в мост ПСИ по Unix-сокету. Ответ читается потоком. */
function bridgePost(path: string, payload: unknown): Promise<Upstream> {
  const settings = cfg();
  const data = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: settings.socket,
        path,
        method: "POST",
        headers: { host: "psy-platform-bridge", "content-type": "application/json", "content-length": data.length },
      },
      (res) => resolve({ status: res.statusCode ?? 0, body: res }),
    );
    // Таймаут сокета срабатывает на тишину и до ответа, и посреди потока.
    req.setTimeout(settings.idleMs, () => req.destroy(new ModelError("Мост Codex перестал отвечать", "timeout")));
    req.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (err instanceof ModelError) reject(err);
      else if (code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES") {
        reject(new ModelError("Мост ПСИ к Codex недоступен", "bridge"));
      } else reject(new ModelError("Связь с мостом Codex прервалась", "connection"));
    });
    req.end(data);
  });
}

async function apiPost(path: string, payload: unknown): Promise<Upstream> {
  const settings = cfg();
  const controller = new AbortController();
  let res: Response;
  try {
    res = await fetch(`${settings.apiBase}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    throw new ModelError("Связь с OpenAI API прервалась", "connection", "api");
  }
  const body = res.body ?? (async function* () {})();
  return { status: res.status, body: withIdleTimeout(body as AsyncIterable<Uint8Array>, settings.idleMs, () => controller.abort()) };
}

/** Тишина в потоке дольше idleMs - обрыв, а не бесконечное ожидание. */
async function* withIdleTimeout(
  source: AsyncIterable<Uint8Array>,
  idleMs: number,
  abort: () => void,
): AsyncIterable<Uint8Array> {
  const it = source[Symbol.asyncIterator]();
  while (true) {
    let timer: NodeJS.Timeout | undefined;
    const idle = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort();
        reject(new ModelError("Модель перестала присылать ответ", "timeout", "api"));
      }, idleMs);
    });
    let next: IteratorResult<Uint8Array>;
    try {
      next = await Promise.race([it.next(), idle]);
    } finally {
      clearTimeout(timer);
    }
    if (next.done) return;
    yield next.value;
  }
}

async function readAll(body: AsyncIterable<Uint8Array>, limit = 64 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > limit) throw new ModelError("Ответ модели превысил допустимый размер", "unavailable");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function asDate(value: unknown, seconds?: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value > 1e12 ? value : value * 1000);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asDate(asNumber);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    return new Date(Date.now() + seconds * 1000);
  }
  return null;
}

/**
 * Разбор ошибки. Мост уже присылает готовый вид сбоя, OpenAI API - свой
 * формат ошибки; правила те же, что у агента (psy_group_codex.py, _failure).
 */
export function classify(status: number, raw: string, route: Route): ModelError {
  let error: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (parsed && typeof parsed.error === "object" && parsed.error !== null) {
      error = parsed.error as Record<string, unknown>;
    }
  } catch {
    // Тело не JSON - решаем по статусу.
  }

  const kind = typeof error["kind"] === "string" ? (error["kind"] as string) : null;
  const codes = [error["code"], error["type"]].filter((c): c is string => typeof c === "string");
  const resetsAt = asDate(error["resets_at"], error["resets_in_seconds"]);
  const who = route === "codex" ? "Codex" : "OpenAI API";

  if (kind === "quota" || codes.some((c) => ["usage_limit_reached", "usage_limit_exceeded", "insufficient_quota"].includes(c))) {
    // У ключа API исчерпанный баланс не сбрасывается по времени - это обычная ошибка.
    if (route === "api") return new ModelError(`${who}: исчерпан баланс ключа`, "unavailable", route);
    return new ModelError(`${who}: лимит подписки исчерпан`, "quota", route, resetsAt);
  }
  if (kind === "context" || codes.some((c) => ["context_length_exceeded", "context_window_exceeded", "input_too_large"].includes(c))) {
    return new ModelError("Материал превысил окно модели", "context", route);
  }
  if (kind === "signin" || (route === "codex" && status === 401)) {
    return new ModelError(`${who}: вход в подписку отклонен`, "signin", route);
  }
  if (kind === "access_wait") return new ModelError("Агент временно не выдает доступ к Codex", "access_wait", route);
  if (kind === "busy" || status === 429 || codes.includes("rate_limit_exceeded")) {
    return new ModelError(`${who}: временное ограничение частоты`, "busy", route);
  }
  if (kind === "timeout" || status === 408 || status === 504) return new ModelError(`${who}: нет ответа`, "timeout", route);
  if (kind === "bad_request" || status === 400) return new ModelError(`${who}: запрос отклонен (400)`, "bad_request", route);
  if (kind === "connection" || status === 502) return new ModelError(`${who}: связь прервалась`, "connection", route);
  if (route === "api" && status === 401) return new ModelError("OpenAI API: ключ не принят", "unavailable", route);
  return new ModelError(`${who}: ошибка ${status}`, "unavailable", route);
}

// ─── Ответы модели (Responses API) ───────────────────────────────────────────

async function buildInput(opts: AskOptions): Promise<unknown[]> {
  const content: Record<string, unknown>[] = [{ type: "input_text", text: opts.user }];
  for (const img of opts.images ?? []) {
    const data = await readFile(img.path);
    content.push({ type: "input_image", image_url: `data:${img.mediaType};base64,${data.toString("base64")}` });
  }
  return [{ role: "user", content }];
}

export function payloadFor(opts: AskOptions, input: unknown[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: opts.model,
    instructions: opts.system,
    input,
    stream: true,
    store: false,
  };
  if (opts.effort) payload["reasoning"] = { effort: opts.effort };
  if (opts.webSearch) {
    payload["tools"] = [{ type: "web_search" }];
    payload["tool_choice"] = "required";
    payload["include"] = ["web_search_call.action.sources"];
  }
  return payload;
}

interface StreamItem {
  id?: string;
  type?: string;
  phase?: string;
  status?: string;
  content?: { type?: string; text?: string; refusal?: string; annotations?: { type?: string; url?: string; title?: string }[] }[];
  action?: { type?: string; url?: string; sources?: { url?: string; title?: string }[] };
}

interface StreamEvent {
  type?: string;
  item?: StreamItem;
  item_id?: string;
  output_index?: number;
  content_index?: number;
  delta?: string;
  text?: string;
  part?: { type?: string; text?: string };
  response?: {
    status?: string;
    output?: StreamItem[];
    error?: unknown;
    incomplete_details?: { reason?: string };
  };
  error?: unknown;
}

interface Collected {
  text: string;
  citations: { url: string; title: string }[];
  searches: number;
}

function citationsOf(item: StreamItem): { url: string; title: string }[] {
  const out: { url: string; title: string }[] = [];
  if (item.type === "web_search_call" && item.status === "completed") {
    for (const s of item.action?.sources ?? []) {
      if (typeof s.url === "string" && /^https?:\/\//.test(s.url)) out.push({ url: s.url, title: s.title ?? "" });
    }
  } else if (item.type === "message" && item.phase !== "commentary") {
    for (const part of item.content ?? []) {
      for (const a of part.annotations ?? []) {
        if (a.type === "url_citation" && typeof a.url === "string" && /^https?:\/\//.test(a.url)) {
          out.push({ url: a.url, title: a.title ?? "" });
        }
      }
    }
  }
  return out;
}

function messageText(item: StreamItem): string {
  if (item.type !== "message" || item.phase === "commentary") return "";
  return (item.content ?? [])
    .filter((p) => p.type === "output_text")
    .map((p) => p.text ?? "")
    .join("\n");
}

/**
 * Разбор потока событий Responses API. Повторяет проверенную логику агента
 * (psy_group_codex.py, _stream): пояснения модели по ходу работы (phase
 * commentary) в ответ не попадают, итог берется из response.completed.
 */
export async function collectStream(body: AsyncIterable<Uint8Array>, route: Route, webSearch: boolean): Promise<Collected> {
  const decoder = new TextDecoder();
  const commentary = new Set<string | number>();
  const written = new Map<string | number, Map<number, string>>();
  const citations: { url: string; title: string }[] = [];
  let searches = 0;
  let refused = false;
  let buf = "";

  const finish = (output: StreamItem[] | undefined): Collected => {
    let text = "";
    if (output) {
      for (const item of output) citations.push(...citationsOf(item));
      if (webSearch && searches === 0) {
        searches = output.filter((i) => i.type === "web_search_call" && i.status === "completed").length;
      }
      text = output.map(messageText).filter((t) => t !== "").join("\n").trim();
    }
    if (text === "") text = joinWritten(written, commentary);
    if (refused) throw new ModelError("Модель отказалась отвечать", "refused", route);
    if (webSearch && searches === 0) throw new ModelError("Веб-поиск не выполнился", "unavailable", route);
    if (text === "") throw new ModelError("Модель вернула пустой ответ", "unavailable", route);
    return { text, citations, searches };
  };

  const handle = (event: StreamEvent): Collected | null => {
    const typ = event.type ?? "";
    const item = event.item ?? {};
    const itemId = event.item_id ?? item.id ?? event.output_index ?? 0;
    const contentIndex = event.content_index ?? 0;

    if ((typ === "response.output_item.added" || typ === "response.output_item.done") && item.phase === "commentary") {
      commentary.add(itemId);
      if (event.output_index !== undefined) commentary.add(event.output_index);
    }
    if (typ === "response.refusal.delta" || typ === "response.refusal.done" || event.part?.type === "refusal") refused = true;
    if (typ === "response.output_text.delta" && !commentary.has(itemId)) {
      const parts = written.get(itemId) ?? new Map<number, string>();
      parts.set(contentIndex, (parts.get(contentIndex) ?? "") + (event.delta ?? ""));
      written.set(itemId, parts);
    }
    if (typ === "response.output_text.done" && typeof event.text === "string" && event.text !== "" && !commentary.has(itemId)) {
      const parts = written.get(itemId) ?? new Map<number, string>();
      parts.set(contentIndex, event.text);
      written.set(itemId, parts);
    }
    if (typ === "response.output_item.done") {
      citations.push(...citationsOf(item));
      if (item.type === "web_search_call" && item.status === "completed") searches += 1;
      if (item.type === "message" && !commentary.has(itemId)) {
        if ((item.content ?? []).some((p) => p.type === "refusal")) refused = true;
        const text = messageText(item);
        if (text !== "") written.set(itemId, new Map([[0, text]]));
      }
    }
    const body = event.response ?? {};
    if (typ === "response.completed") {
      if (body.status && body.status !== "completed") {
        throw classify(0, JSON.stringify({ error: body.error ?? {} }), route);
      }
      return finish(body.output);
    }
    if (typ === "response.incomplete") {
      const reason = body.incomplete_details?.reason;
      if (reason === "max_output_tokens") {
        throw new ModelError(
          "Ответ модели уперся в потолок длины и оборвался - материал слишком объемный для одного захода",
          "incomplete",
          route,
        );
      }
      throw classify(0, JSON.stringify({ error: body.error ?? {} }), route);
    }
    if (typ === "response.failed" || typ === "error") {
      const error = body.error ?? event.error ?? event;
      throw classify(0, JSON.stringify({ error }), route);
    }
    return null;
  };

  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let cut: number;
    while ((cut = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, cut).replace(/\r$/, "");
      buf = buf.slice(cut + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "" || data === "[DONE]") continue;
      let event: StreamEvent;
      try {
        event = JSON.parse(data) as StreamEvent;
      } catch {
        throw new ModelError("Поток модели пришел в непонятном виде", "connection", route);
      }
      const done = handle(event);
      if (done) return done;
    }
  }
  // Поток кончился без response.completed: ответ не гарантированно полный.
  throw new ModelError("Поток модели оборвался до конца ответа", "connection", route);
}

function joinWritten(written: Map<string | number, Map<number, string>>, commentary: Set<string | number>): string {
  const out: string[] = [];
  for (const [id, parts] of written) {
    if (commentary.has(id)) continue;
    out.push([...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t).join(""));
  }
  return out.join("\n").trim();
}

/** Ссылки веб-поиска нумеруются по первому появлению; utm-метки не различают источники. */
function sourceKey(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) if (key.startsWith("utm_")) u.searchParams.delete(key);
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Встроенные ссылки модели вида ([сайт](url)) или [сайт](url) превращаются в
 * номера [n], список источников идет отдельно - как раньше у Perplexity.
 */
export function numberSources(text: string, citations: { url: string; title: string }[]): { text: string; sources: WebSource[] } {
  const sources: WebSource[] = [];
  const byKey = new Map<string, WebSource>();
  const add = (url: string, title: string): WebSource => {
    const key = sourceKey(url);
    const known = byKey.get(key);
    if (known) {
      if (!known.title || known.title === known.url) known.title = title || known.title;
      return known;
    }
    const entry = { n: sources.length + 1, url: key, title: title || key };
    sources.push(entry);
    byKey.set(key, entry);
    return entry;
  };

  const titles = new Map(citations.map((c) => [sourceKey(c.url), c.title]));
  const replaced = text
    .replace(/\s?\(\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)\)/g, (_m, label: string, url: string) => {
      const entry = add(url, titles.get(sourceKey(url)) || label);
      return ` [${entry.n}]`;
    })
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => {
      const entry = add(url, titles.get(sourceKey(url)) || label);
      return `${label} [${entry.n}]`;
    });
  for (const c of citations) add(c.url, c.title);
  return { text: replaced, sources };
}

async function respondOnce(route: Route, payload: Record<string, unknown>, webSearch: boolean): Promise<Answer> {
  const upstream = route === "codex" ? await bridgePost("/responses", payload) : await apiPost("/responses", payload);
  if (upstream.status !== 200) {
    throw classify(upstream.status, await readAll(upstream.body, 64 * 1024).catch(() => ""), route);
  }
  const collected = await collectStream(upstream.body, route, webSearch);
  if (!webSearch) return { text: collected.text, sources: [], route };
  const numbered = numberSources(collected.text, collected.citations);
  return { text: numbered.text, sources: numbered.sources, route };
}

/** Текстовый ответ модели. Маршрут выбирается здесь, вызывающему он не важен. */
export async function askText(opts: AskOptions): Promise<Answer> {
  const input = await buildInput(opts);
  const payload = payloadFor(opts, input);
  return withRoute((route) => respondOnce(route, payload, opts.webSearch === true));
}

/** Ответ строго объектом - разбор в lib/model-json.ts. */
export async function askJson<T>(opts: Omit<AskOptions, "webSearch">): Promise<T> {
  const answer = await askText({ ...opts, system: `${opts.system}\n\n${JSON_RULE}` });
  return parseModelJson<T>(answer.text, "Codex");
}

// ─── Картинки ────────────────────────────────────────────────────────────────

export interface DrawnImage {
  buffer: Buffer;
  route: Route;
  model: string;
}

/**
 * Codex рисует горизонтальную картинку 3:2, мост обрезает ее до 16:9 по центру.
 * Просим держать все важное в средней полосе, чтобы обрезка ничего не съела.
 */
const CROP_HINT =
  "Composition note: wide 16:9 framing. Keep every important element inside the central horizontal band; " +
  "the top and bottom edges of the picture will be trimmed.";

async function drawOnce(route: Route, prompt: string): Promise<DrawnImage> {
  const settings = cfg();
  if (route === "codex") {
    const upstream = await bridgePost("/images", {
      prompt: `${prompt}\n\n${CROP_HINT}`,
      size: settings.imageSize,
      quality: settings.imageQuality,
    });
    const raw = await readAll(upstream.body);
    if (upstream.status !== 200) throw classify(upstream.status, raw, route);
    const data = JSON.parse(raw) as { b64?: string };
    if (!data.b64) throw new ModelError("Codex не вернул изображение", "unavailable", route);
    return { buffer: Buffer.from(data.b64, "base64"), route, model: "gpt-image-2" };
  }
  const upstream = await apiPost("/images/generations", {
    model: settings.imageModel,
    prompt,
    size: settings.imageSize,
    n: 1,
  });
  const raw = await readAll(upstream.body);
  if (upstream.status !== 200) throw classify(upstream.status, raw, route);
  const data = JSON.parse(raw) as { data?: { b64_json?: string }[] };
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new ModelError("OpenAI API не вернул изображение", "unavailable", route);
  return { buffer: Buffer.from(b64, "base64"), route, model: settings.imageModel };
}

export async function drawImage(prompt: string): Promise<DrawnImage> {
  return withRoute((route) => drawOnce(route, prompt));
}
