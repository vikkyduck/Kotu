import type { RequestHandler } from "express";
import { ArchiveUnavailableError } from "./archive-files";

/**
 * Состояние архива в процессе: включён ли он, повторы, самопроверка и режим
 * «только чтение». Без пула и путей: включение и проверку триггеров передают
 * снаружи (lib/archive.ts — настоящие, тесты — поддельные), поэтому логику
 * повторов и тайм-аутов можно проверить без базы.
 *
 * "pending" — идёт (или ещё не начата) попытка включить архив;
 * "ok"      — триггеры архива на месте и проверены;
 * "off"     — архив не включился: сервер только на чтение, очередь стоит,
 *             повтор раз в минуту.
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
  /** Пауза между попытками, пока архив выключен. */
  retryMs?: number;
  /**
   * Сколько ждать одну попытку или проверку. Зависший pool.connect или
   * advisory lock иначе подвесил бы requireArchive (и с ним удаление) навсегда,
   * а healthz так и показывал бы pending. По тайм-ауту — "off" и повтор.
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

const READ_ONLY = new Set(["GET", "HEAD", "OPTIONS"]);

export function createArchiveSupervisor(opts: ArchiveSupervisorOptions) {
  const { log } = opts;
  const retryMs = opts.retryMs ?? 60_000;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  let state: ArchiveState = "pending";
  /** Последняя попытка включить архив; её итог — ответ ready(). */
  let last: Promise<ArchiveState> | null = null;
  let inflight = false;
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

  /** Одна попытка включить архив. Не бросает: итог — в state и в логе. */
  function attempt(): Promise<ArchiveState> {
    if (inflight && last) return last;
    inflight = true;
    last = withTimeout(
      Promise.resolve().then(() => opts.ensure()),
      timeoutMs,
      "Включение архива",
    )
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
        inflight = false;
      });
    return last;
  }

  /** Первая попытка включить архив (или итог последней). Не бросает. */
  function ensureArchive(): Promise<ArchiveState> {
    return last ?? attempt();
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
      if (!last) void attempt();
    });
    return readyPromise;
  }

  /** Архив включён? Идёт попытка — ждём её итога, а не прошлого «off». */
  async function ready(): Promise<boolean> {
    await (last ?? attempt());
    if (inflight && last) await last;
    return state === "ok";
  }

  /**
   * Самопроверка на лету: «ok» не вечно. drizzle push может пересоздать
   * таблицу на работающем сервере — триггер пропадёт вместе с ней, а
   * процесс продолжал бы считать архив включённым. Нет триггеров (или не
   * удалось проверить) — сразу только чтение (pending) и заново
   * ensureArchive; не вышло — "off" и повтор раз в минуту.
   */
  async function verify(): Promise<void> {
    if (state !== "ok" || inflight) return;
    let missing: string[];
    try {
      missing = await withTimeout(
        Promise.resolve().then(() => opts.missingTriggers()),
        timeoutMs,
        "Проверка триггеров архива",
      );
    } catch (err) {
      log.error({ err }, "Не смог проверить триггеры архива — включаю архив заново");
      missing = ["проверка не удалась"];
    }
    if (missing.length === 0 || state !== "ok" || inflight) return;
    log.error(
      { missing },
      "ТРИГГЕРЫ АРХИВА ПРОПАЛИ — сервер только на чтение, пока не поставлю их снова",
    );
    state = "pending";
    await attempt();
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
    res.status(503).json({ message, error: message });
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
