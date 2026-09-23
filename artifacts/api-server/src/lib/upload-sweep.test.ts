import { test, describe, expect, vi } from "vitest";

// Модуль сверки тянет базу, а без DATABASE_URL она падает прямо при импорте.
// Здесь проверяется только чистая логика отбора — база не нужна.
vi.mock("@workspace/db", () => ({ db: {}, jobsTable: {}, transcriptionsTable: {} }));

const {
  pickUploadsToSweep,
  resolveInsideDir,
  FRESH_UPLOAD_MS,
  ERROR_AUDIO_KEEP_MS,
} = await import("./upload-sweep");

const DIR = "/opt/kotu/uploads";
const NOW = Date.parse("2026-09-23T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const old = (name: string) => ({ path: `${DIR}/${name}`, mtimeMs: NOW - 2 * DAY });

describe("resolveInsideDir", () => {
  test("путь внутри каталога нормализуется", () => {
    expect(resolveInsideDir(DIR, `${DIR}/a/../b`)).toBe(`${DIR}/b`);
    expect(resolveInsideDir(DIR, "abc")).toBe(`${DIR}/abc`);
  });

  test("выход за каталог, сам каталог и мусор отбрасываются", () => {
    expect(resolveInsideDir(DIR, `${DIR}/../library/book.pdf`)).toBeNull();
    expect(resolveInsideDir(DIR, "/etc/passwd")).toBeNull();
    expect(resolveInsideDir(DIR, `${DIR}-evil/x`)).toBeNull();
    expect(resolveInsideDir(DIR, DIR)).toBeNull();
    expect(resolveInsideDir(DIR, "")).toBeNull();
    expect(resolveInsideDir(DIR, undefined)).toBeNull();
    expect(resolveInsideDir(DIR, 42)).toBeNull();
  });

  test("имя файла, начинающееся с точек, — не выход за каталог", () => {
    expect(resolveInsideDir(DIR, `${DIR}/..hidden`)).toBe(`${DIR}/..hidden`);
  });
});

describe("pickUploadsToSweep", () => {
  test("старый файл без ссылок удаляется, свежий — нет", () => {
    const files = [old("orphan"), { path: `${DIR}/uploading`, mtimeMs: NOW - FRESH_UPLOAD_MS + 1000 }];
    expect(pickUploadsToSweep(DIR, files, [], NOW)).toEqual([`${DIR}/orphan`]);
  });

  test("задача в очереди или в работе держит файл", () => {
    const files = [old("q"), old("r")];
    const refs = [
      { inputPath: `${DIR}/q`, jobStatus: "queued" as const, recordStatus: "processing" as const, failedAtMs: null },
      { inputPath: `${DIR}/r`, jobStatus: "running" as const, recordStatus: "processing" as const, failedAtMs: null },
    ];
    expect(pickUploadsToSweep(DIR, files, refs, NOW)).toEqual([]);
  });

  test("задача удалённой записи файл не держит", () => {
    const refs = [{ inputPath: `${DIR}/gone`, jobStatus: "queued" as const, recordStatus: null, failedAtMs: null }];
    expect(pickUploadsToSweep(DIR, [old("gone")], refs, NOW)).toEqual([`${DIR}/gone`]);
  });

  test("провал держит аудио 14 дней, потом отпускает", () => {
    const fresh = { inputPath: `${DIR}/e1`, jobStatus: "error" as const, recordStatus: "error" as const, failedAtMs: NOW - 13 * DAY };
    const stale = { inputPath: `${DIR}/e2`, jobStatus: "error" as const, recordStatus: "error" as const, failedAtMs: NOW - ERROR_AUDIO_KEEP_MS - 1 };
    const files = [old("e1"), { path: `${DIR}/e2`, mtimeMs: NOW - 20 * DAY }];
    expect(pickUploadsToSweep(DIR, files, [fresh, stale], NOW)).toEqual([`${DIR}/e2`]);
  });

  test("старый провал не мешает, если после повтора задача снова в очереди", () => {
    const refs = [
      { inputPath: `${DIR}/x`, jobStatus: "error" as const, recordStatus: "processing" as const, failedAtMs: NOW - 30 * DAY },
      { inputPath: `${DIR}/x`, jobStatus: "queued" as const, recordStatus: "processing" as const, failedAtMs: null },
    ];
    expect(pickUploadsToSweep(DIR, [old("x")], refs, NOW)).toEqual([]);
  });

  test("проваленная задача готовой записи аудио не держит", () => {
    const refs = [{ inputPath: `${DIR}/d`, jobStatus: "error" as const, recordStatus: "done" as const, failedAtMs: NOW - DAY }];
    expect(pickUploadsToSweep(DIR, [old("d")], refs, NOW)).toEqual([`${DIR}/d`]);
  });

  test("время провала неизвестно — храним", () => {
    const refs = [{ inputPath: `${DIR}/u`, jobStatus: "error" as const, recordStatus: "error" as const, failedAtMs: null }];
    expect(pickUploadsToSweep(DIR, [old("u")], refs, NOW)).toEqual([]);
  });

  test("ссылка записана в другом виде — это тот же файл", () => {
    const refs = [{ inputPath: `${DIR}/sub/../k`, jobStatus: "running" as const, recordStatus: "processing" as const, failedAtMs: null }];
    expect(pickUploadsToSweep(DIR, [old("k")], refs, NOW)).toEqual([]);
  });

  test("файлы вне каталога не удаляются никогда", () => {
    const files = [
      { path: "/opt/kotu/library/book.pdf", mtimeMs: NOW - 100 * DAY },
      { path: `${DIR}/../decks/1/a.png`, mtimeMs: NOW - 100 * DAY },
    ];
    expect(pickUploadsToSweep(DIR, files, [], NOW)).toEqual([]);
  });
});
