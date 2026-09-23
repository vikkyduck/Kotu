import type { RequestHandler } from "express";
import { ArchiveUnavailableError } from "./archive-files";

/**
 * Состояние архива в процессе: включён ли он, повторы, самопроверка и режим
 * «только чтение». Без пула и путей: включение и проверку триггеров передают
 * снаружи (lib/archive.ts — настоящие, тесты — поддельные), поэтому логику
 * повторов и тайм-аутов можно проверить без базы.
 *
 * "pending" — идёт (или ещё не начата) попытка включить архив; в том числе
 *             долгая: первое включение снимает все таблицы (INITIAL);
 * "ok"      — триггеры архива на месте и проверены;
 * "off"     — попытка включить архив упала: сервер только на чтение, очередь
 *             стоит, повтор через минуту после провала.
 *
 * Попытка всегда одна. Тайм-аут не бросает висящую попытку и не запускает
 * рядом новую: каждая держала бы клиента пула и ждала бы advisory lock
 * предыдущей, и за ~20 минут повторов пул (max=10) кончился бы — упали бы
 * даже GET. Тайм-аут только отпускает тех, кто ждёт ответа (ready(),
 * requireArchive → «архив не готов», 503), а состояние остаётся "pending",
 * пока попытка не кончится сама. Чтобы она кончалась, её транзакции
 * ограничены самой базой (lock_timeout, statement_timeout — archive-sql.ts).
 */
export type ArchiveState = "pending" | "ok" | "off";

interface Log {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface ArchiveSupervisorOptions {
  /** Поставить архив (ensureArchiveWith). Бросает, если не вышло. */
  ensure: () => Promise<{ snapshotted: string[]; initialRows: number }>;
  /** Каких триггеров архива нет (findMissingTriggers); пусто — всё на месте. */
  missingTriggers: () => Promise<string[]>;
  log: Log;
  /** Пауза между провалом попытки и следующей. */
  retryMs?: number;
  /**
   * Сколько ждать ответа попытки или проверки тем, кто его ждёт (удаление,
   * сверка файлов). Зависший pool.connect или advisory lock иначе подвесил бы
   * удаление навсегда. По тайм-ауту ждущий получает «не готов», а сама
   * попытка продолжается — см. комментарий к ArchiveState.
   */
  timeoutMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: нет ответа за ${Math.round(ms / 1000)} с`)), ms);
  });
  return Promise.race([p, expired]).finally(() => clearTimeout(timer));
}

/** Дождаться p, но не дольше ms. Не бросает: ответ ждущему — в state. */
function waitAtMost(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([p.then(() => undefined, () => undefined), expired]).finally(() =>
    clearTimeout(timer),
  );
}

const READ_ONLY = new Set(["GET", "HEAD", "OPTIONS"]);

export function createArchiveSupervisor(opts: ArchiveSupervisorOptions) {
  const { log } = opts;
  const retryMs = opts.retryMs ?? 60_000;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  let state: ArchiveState = "pending";
  /** Была ли хоть одна попытка. */
  let started = false;
  /**
   * Идущая попытка — сам исходный promise ensure(), а не обёртка с
   * тайм-аутом: пока он не завершился, новой попытки нет.
   */
  let running: Promise<ArchiveState> | null = null;
  /** Идущая проверка триггеров — тоже исходный promise, без параллельных. */
  let checking: Promise<string[]> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let waiters: (() => void)[] = [];
  let readyPromise: Promise<void> | null = null;

  function scheduleRetry(): void {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void attempt();
    }, retryMs);
  }

  /**
   * Одна попытка включить архив; идёт уже — та же самая. Не бросает: итог —
   * в state и в логе. Повтор назначается только после провала, то есть
   * когда попытка действительно кончилась.
   */
  function attempt(): Promise<ArchiveState> {
    if (running) return running;
    started = true;
    // Долгая попытка — не провал (первый снимок большой таблицы), но в
    // журнале её должно быть видно: healthz всё это время отвечает pending.
    const slow = setTimeout(() => {
      log.warn(
        { waitedMs: timeoutMs },
        "Архив включается дольше обычного — жду, новую попытку не начинаю; пока сервер только на чтение",
      );
    }, timeoutMs);
    const p = Promise.resolve()
      .then(() => opts.ensure())
      .then(
        (r) => {
          state = "ok";
          log.info(
            { snapshotted: r.snapshotted, initialRows: r.initialRows },
            "Архив включён: триггеры на месте",
          );
          const ready = waiters;
          waiters = [];
          for (const resolve of ready) resolve();
          return state;
        },
        (err: unknown) => {
          state = "off";
          log.error(
            { err },
            "АРХИВ НЕ ВКЛЮЧИЛСЯ — сервер только на чтение: очередь стоит, изменения отклоняются. Повтор через минуту",
          );
          scheduleRetry();
          return state;
        },
      )
      .finally(() => {
        clearTimeout(slow);
        if (running === p) running = null;
      });
    running = p;
    return p;
  }

  /**
   * Первая попытка включить архив; идёт попытка — её итог; иначе — текущее
   * состояние. Не бросает и не ограничен тайм-аутом (index.ts ограничивает
   * ожидание сам).
   */
  function ensureArchive(): Promise<ArchiveState> {
    if (running) return running;
    if (!started) return attempt();
    return Promise.resolve(state);
  }

  /**
   * Разрешается, когда архив включён: не вышло с первого раза — повтор раз в
   * минуту, пока не выйдет. Всё, что меняет данные без участия человека
   * (очередь, стартовые сверки), запускается только после него.
   */
  function whenArchiveReady(): Promise<void> {
    readyPromise ??= new Promise<void>((resolve) => {
      if (state === "ok") {
        resolve();
        return;
      }
      waiters.push(resolve);
      if (!started) void attempt();
    });
    return readyPromise;
  }

  /**
   * Архив включён? Идёт попытка — ждём её итога (а не прошлого «off»), но не
   * дольше timeoutMs: дольше — «не готов», попытка при этом продолжается.
   */
  async function ready(): Promise<boolean> {
    const p = running ?? (started ? null : attempt());
    if (p) await waitAtMost(p, timeoutMs);
    return state === "ok";
  }

  /**
   * Самопроверка на лету: «ok» не вечно. drizzle push может пересоздать
   * таблицу на работающем сервере — триггер пропадёт вместе с ней, а
   * процесс продолжал бы считать архив включённым. Нет триггеров (или не
   * удалось проверить) — сразу только чтение (pending) и заново
   * ensureArchive; не вышло — "off" и повтор раз в минуту.
   *
   * Проверка одна: прежняя ещё идёт (запрос повис) — новую не начинаем, а
   * тайм-аут лишь перестаёт её ждать. Сам запрос ограничен statement_timeout
   * в базе (archive.ts), так что кончится и он.
   */
  async function verify(): Promise<void> {
    if (state !== "ok" || running || checking) return;
    const check = Promise.resolve().then(() => opts.missingTriggers());
    checking = check;
    void check
      .catch(() => undefined)
      .finally(() => {
        if (checking === check) checking = null;
      });
    let missing: string[];
    try {
      missing = await withTimeout(check, timeoutMs, "Проверка триггеров архива");
    } catch (err) {
      log.error({ err }, "Не смог проверить триггеры архива — включаю архив заново");
      missing = ["проверка не удалась"];
    }
    if (missing.length === 0 || state !== "ok" || running) return;
    log.error(
      { missing },
      "ТРИГГЕРЫ АРХИВА ПРОПАЛИ — сервер только на чтение, пока не поставлю их снова",
    );
    state = "pending";
    await waitAtMost(attempt(), timeoutMs);
  }

  /**
   * Проверка в начале пользовательских удалений: без архива не удаляем
   * ничего, в том числе строки, — иначе они ушли бы мимо триггеров.
   */
  async function requireArchive(): Promise<void> {
    if (!(await ready())) throw new ArchiveUnavailableError();
  }

  /**
   * Пока архив не включён, сервер только на чтение: правка расшифровки или
   * главы лекции без триггера затёрла бы прежний текст насовсем. Ставится
   * после входа — сам вход и сброс пароля архива не касаются.
   */
  const rejectWritesWithoutArchive: RequestHandler = (req, res, next) => {
    if (READ_ONLY.has(req.method) || state === "ok") {
      next();
      return;
    }
    req.log?.warn({ archive: state }, "Изменение отклонено: архив не включён");
    const message = "Архив сейчас недоступен, поэтому изменения не сохраняются. Попробуйте позже";
    res.status(503).json({ message });
  };

  return {
    state: (): ArchiveState => state,
    ensureArchive,
    whenArchiveReady,
    ready,
    verify,
    requireArchive,
    rejectWritesWithoutArchive,
  };
}

export type ArchiveSupervisor = ReturnType<typeof createArchiveSupervisor>;
