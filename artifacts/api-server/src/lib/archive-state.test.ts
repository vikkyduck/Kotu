import { test, describe, expect, vi, afterEach } from "vitest";
import type { Request, Response } from "express";
import { createArchiveSupervisor } from "./archive-state";
import { ArchiveUnavailableError } from "./archive-files";

/**
 * Состояние архива без базы: включение и проверку триггеров подменяем.
 * Проверяем обещания: пока архив не включён, сервер только на чтение;
 * повтор — через минуту после провала; долгая или зависшая попытка не
 * держит ждущих вечно и не плодит параллельных попыток;
 * пропавший триггер снова включает режим только чтения.
 */

const silent = { info() {}, warn() {}, error() {} };
const OK = { snapshotted: [], initialRows: 0 };

afterEach(() => {
  vi.useRealTimers();
});

function fakeHttp(method: string) {
  const req = { method, log: { warn: vi.fn() } } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  const next = vi.fn();
  return { req, res: res as unknown as Response & typeof res, next };
}

function pass(mw: ReturnType<typeof createArchiveSupervisor>["rejectWritesWithoutArchive"], method: string) {
  const h = fakeHttp(method);
  void mw(h.req, h.res, h.next);
  return { passed: h.next.mock.calls.length === 1, status: h.res.status.mock.calls[0]?.[0] as number | undefined };
}

describe("rejectWritesWithoutArchive", () => {
  test("пока архив не включён: чтение проходит, изменения — 503; после ok — проходят", async () => {
    let finish!: () => void;
    const sup = createArchiveSupervisor({
      ensure: () => new Promise((resolve) => (finish = () => resolve(OK))),
      missingTriggers: async () => [],
      log: silent,
    });
    const first = sup.ensureArchive();
    expect(sup.state()).toBe("pending");
    const mw = sup.rejectWritesWithoutArchive;

    expect(pass(mw, "GET")).toEqual({ passed: true, status: undefined });
    expect(pass(mw, "HEAD").passed).toBe(true);
    for (const m of ["POST", "PATCH", "PUT", "DELETE"]) {
      expect(pass(mw, m), m).toEqual({ passed: false, status: 503 });
    }

    // ensure зовётся на следующем такте — дожидаемся его и отпускаем.
    await new Promise((r) => setImmediate(r));
    finish();
    expect(await first).toBe("ok");
    for (const m of ["POST", "PATCH", "DELETE"]) expect(pass(mw, m).passed, m).toBe(true);
  });

  test("архив не включился (off): изменения — 503, удаления бросают ArchiveUnavailableError", async () => {
    vi.useFakeTimers();
    const sup = createArchiveSupervisor({
      ensure: async () => {
        throw new Error("нет прав на таблицу");
      },
      missingTriggers: async () => [],
      log: silent,
    });
    expect(await sup.ensureArchive()).toBe("off");
    expect(pass(sup.rejectWritesWithoutArchive, "POST")).toEqual({ passed: false, status: 503 });
    expect(pass(sup.rejectWritesWithoutArchive, "GET").passed).toBe(true);
    await expect(sup.requireArchive()).rejects.toBeInstanceOf(ArchiveUnavailableError);
  });
});

describe("whenArchiveReady", () => {
  test("разрешается только после ok и повторяет раз в минуту", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const ensure = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error(`отказ ${calls}`);
      return OK;
    });
    const sup = createArchiveSupervisor({ ensure, missingTriggers: async () => [], log: silent });
    let resolved = false;
    void sup.whenArchiveReady().then(() => (resolved = true));

    await vi.advanceTimersByTimeAsync(0);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(sup.state()).toBe("off");
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(ensure).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(ensure).toHaveBeenCalledTimes(3);
    expect(sup.state()).toBe("ok");
    expect(resolved).toBe(true);

    // Включён — повторов больше нет.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(ensure).toHaveBeenCalledTimes(3);
  });

  test("упавшая попытка — off, повтор ровно через минуту после провала", async () => {
    vi.useFakeTimers();
    const ensure = vi
      .fn<() => Promise<typeof OK>>()
      .mockRejectedValueOnce(new Error("нет прав на таблицу"))
      .mockResolvedValue(OK);
    const sup = createArchiveSupervisor({ ensure, missingTriggers: async () => [], log: silent });
    expect(await sup.ensureArchive()).toBe("off");
    expect(ensure).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(sup.state()).toBe("off");
    await vi.advanceTimersByTimeAsync(1);
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(sup.state()).toBe("ok");
  });
});

/** Попытка, которую тест завершает сам, когда захочет. */
function controlled() {
  let resolve!: (v: typeof OK) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<typeof OK>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function logSpy() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("долгая или зависшая попытка", () => {
  test("медленная, но успешная попытка дольше тайм-аута: pending → ok, без off и без второго ensure", async () => {
    vi.useFakeTimers();
    const first = controlled();
    const ensure = vi.fn(() => first.promise);
    const log = logSpy();
    const sup = createArchiveSupervisor({ ensure, missingTriggers: async () => [], log });
    let resolved = false;
    void sup.whenArchiveReady().then(() => (resolved = true));
    // Удаление в это время ждёт не дольше тайм-аута и получает «не готов».
    const required = sup.requireArchive().then(
      () => "ok",
      (err: unknown) => (err instanceof ArchiveUnavailableError ? "unavailable" : "other"),
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(await required).toBe("unavailable");
    expect(sup.state()).toBe("pending");
    expect(pass(sup.rejectWritesWithoutArchive, "POST")).toEqual({ passed: false, status: 503 });
    expect(log.warn).toHaveBeenCalledTimes(1); // «дольше обычного» — в журнал

    // Ещё полторы минуты снимка: ни off, ни повторов.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(sup.state()).toBe("pending");
    expect(ensure).toHaveBeenCalledTimes(1);

    first.resolve(OK);
    await vi.advanceTimersByTimeAsync(0);
    expect(sup.state()).toBe("ok");
    expect(resolved).toBe(true);
    expect(log.error).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  test("висящая попытка: второго ensure нет, пока первая не завершилась; упала — off и повтор через минуту", async () => {
    vi.useFakeTimers();
    const first = controlled();
    const ensure = vi
      .fn<() => Promise<typeof OK>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(OK);
    const sup = createArchiveSupervisor({ ensure, missingTriggers: async () => [], log: silent });
    void sup.ensureArchive();

    // Двадцать минут: удаления и сверки спрашивают ready() снова и снова —
    // раньше каждый тайм-аут запускал новую попытку, и пул кончался.
    for (let i = 0; i < 20; i++) {
      const r = sup.ready();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await r).toBe(false);
      await sup.verify();
    }
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(sup.state()).toBe("pending");

    // Попытка наконец упала (lock_timeout в базе) — только теперь off и повтор.
    first.reject(new Error("canceling statement due to lock timeout"));
    await vi.advanceTimersByTimeAsync(0);
    expect(sup.state()).toBe("off");
    expect(ensure).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(sup.state()).toBe("ok");
  });

  test("зависшая проверка триггеров не плодит параллельных проверок", async () => {
    vi.useFakeTimers();
    const hang = new Promise<string[]>(() => {});
    const missingTriggers = vi.fn(() => hang);
    const ensure = vi.fn(async () => OK);
    const sup = createArchiveSupervisor({ ensure, missingTriggers, log: silent });
    expect(await sup.ensureArchive()).toBe("ok");

    const firstCheck = sup.verify();
    await vi.advanceTimersByTimeAsync(60_000);
    await firstCheck;
    // Проверка не ответила — архив ставится заново (как при пропаже триггера).
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(sup.state()).toBe("ok");

    // Прежний запрос всё ещё висит — новая проверка не начинается.
    await sup.verify();
    await sup.verify();
    expect(missingTriggers).toHaveBeenCalledTimes(1);
  });
});

describe("самопроверка триггеров", () => {
  test("триггеры на месте — ничего не меняется", async () => {
    const ensure = vi.fn(async () => OK);
    const sup = createArchiveSupervisor({ ensure, missingTriggers: async () => [], log: silent });
    await sup.ensureArchive();
    await sup.verify();
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(sup.state()).toBe("ok");
  });

  test("пропал триггер — только чтение, повтор ensure; не вышло — off и повтор раз в минуту", async () => {
    vi.useFakeTimers();
    let missing: string[] = [];
    let fail = false;
    const ensure = vi.fn(async () => {
      if (fail) throw new Error("не смог поставить триггер");
      missing = [];
      return OK;
    });
    const sup = createArchiveSupervisor({ ensure, missingTriggers: async () => missing, log: silent });
    expect(await sup.ensureArchive()).toBe("ok");

    // drizzle push пересоздал таблицу — триггер пропал, а поставить не выходит.
    missing = ["public.lectures: kotu_archive"];
    fail = true;
    const checking = sup.verify();
    expect(sup.state()).toBe("ok"); // проверка ещё идёт
    await checking;
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(sup.state()).toBe("off");
    expect(pass(sup.rejectWritesWithoutArchive, "PATCH")).toEqual({ passed: false, status: 503 });

    fail = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ensure).toHaveBeenCalledTimes(3);
    expect(sup.state()).toBe("ok");
    expect(pass(sup.rejectWritesWithoutArchive, "PATCH").passed).toBe(true);
  });

  test("проверка не удалась (база не ответила) — тоже заново ensure", async () => {
    const ensure = vi.fn(async () => OK);
    const sup = createArchiveSupervisor({
      ensure,
      missingTriggers: async () => {
        throw new Error("соединение оборвалось");
      },
      log: silent,
    });
    await sup.ensureArchive();
    await sup.verify();
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(sup.state()).toBe("ok");
  });
});
