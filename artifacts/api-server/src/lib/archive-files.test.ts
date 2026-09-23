import { test, describe, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  appendFile,
  link,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { ensureArchiveWith, type Query } from "./archive-sql";
import { createTestDb, type TestDb } from "./archive-test-db";
import {
  ArchiveUnavailableError,
  TMP_PREFIX,
  createFileArchive,
  writeFileAtomic,
} from "./archive-files";

/**
 * Архив файлов на временном каталоге и настоящем Postgres (PGlite).
 * Главное обещание: файл данных исчезает из рабочего каталога только после
 * того, как его содержимое легло в архив, и архивная копия потом не меняется.
 */

let db: TestDb;
let root: string;
let lib: string;
let decks: string;
let archiveDir: string;
let isReady = true;
let failQueries = false;

const query: Query = (text, params) =>
  failQueries ? Promise.reject(new Error("база недоступна")) : db.query(text, params);

function makeArchive(extra: Partial<Parameters<typeof createFileArchive>[0]> = {}) {
  return createFileArchive({
    archiveDir,
    dataDirs: [lib, decks],
    query,
    ready: async () => isReady,
    minAgeMs: 0,
    ...extra,
  });
}

/** Обещание, которое обязано успеть: зависание — это провал, а не вечный тест. */
function inTime<T>(p: Promise<T>, ms = 5_000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`не завершилось за ${ms} мс`)), ms).unref(),
    ),
  ]);
}

/** link, который ведёт себя как на другом диске или под запретом ядра. */
function failingLink(code: string) {
  return async () => {
    throw Object.assign(new Error(code), { code });
  };
}

async function scalar(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.query(sql, params);
  return Number(Object.values(rows[0]!)[0]);
}

beforeAll(async () => {
  db = await createTestDb();
  await ensureArchiveWith(db.runner);
}, 60_000);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kotu-archive-test-"));
  lib = path.join(root, "library");
  decks = path.join(root, "decks");
  archiveDir = path.join(root, "archive");
  await mkdir(lib, { recursive: true });
  await mkdir(decks, { recursive: true });
  isReady = true;
  failQueries = false;
});

afterEach(async () => {
  // Временный каталог теста — не данные платформы.
  await rm(root, { recursive: true, force: true });
});

afterAll(async () => {
  await db?.pg.close();
});

describe("архив файлов", () => {
  test("жёсткая ссылка: тот же inode, переживает rm оригинала", async () => {
    const a = makeArchive();
    const f = path.join(lib, "book.pdf");
    await writeFile(f, "содержимое книги");
    const r = await a.archiveFile(f, { kind: "upload", entityType: "document", entityId: 1 });
    expect(r?.stored).toBe(true);
    expect((await stat(r!.storedPath)).ino).toBe((await stat(f)).ino);

    await rm(f);
    expect(await readFile(r!.storedPath, "utf8")).toBe("содержимое книги");
    expect(await scalar(`SELECT count(*) FROM archive.files WHERE sha256 = $1`, [r!.sha256])).toBe(1);
    expect(
      await scalar(
        `SELECT count(*) FROM archive.file_events WHERE sha256 = $1 AND entity_type = 'document'`,
        [r!.sha256],
      ),
    ).toBe(1);
  });

  test("жёсткая ссылка невозможна (EXDEV) — копия: завершается, байт в байт, свой inode", async () => {
    const a = makeArchive({ link: failingLink("EXDEV") });
    const f = path.join(lib, "session.m4a");
    // Больше куска чтения — чтобы цикл копирования сделал несколько шагов.
    const data = randomBytes(2 * 1024 * 1024 + 12_345);
    await writeFile(f, data);

    const r = await inTime(a.archiveFile(f, { kind: "upload", entityType: "transcription", entityId: 5 }));
    expect(r!.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    expect(r!.stored).toBe(true);
    expect((await readFile(r!.storedPath)).equals(data)).toBe(true);
    expect((await stat(r!.storedPath)).ino).not.toBe((await stat(f)).ino);
    // Временных файлов копирования в архиве не осталось — всё переименовано.
    const shard = await readdir(path.dirname(r!.storedPath));
    expect(shard).toEqual([r!.sha256]);

    const removed = await inTime(a.archiveAndRemove(f, { entityType: "transcription", entityId: 5 }));
    expect(removed!.sha256).toBe(r!.sha256);
    await expect(stat(f)).rejects.toThrow();
    expect((await readFile(r!.storedPath)).equals(data)).toBe(true);
  });

  test("EPERM на ссылке (protected_hardlinks) — та же копия, и сверка не виснет", async () => {
    const a = makeArchive({ link: failingLink("EPERM") });
    await writeFile(path.join(lib, "a.txt"), "первый");
    await writeFile(path.join(decks, "b.txt"), "второй");
    const r = await inTime(a.sweep());
    expect(r).toMatchObject({ archived: 2, failed: 0 });
  });

  test("другая ошибка ссылки не маскируется копией", async () => {
    const a = makeArchive({ link: failingLink("EIO") });
    const f = path.join(lib, "c.txt");
    await writeFile(f, "третий");
    await expect(inTime(a.archiveAndRemove(f, { entityType: "document" }))).rejects.toThrow("EIO");
    expect(await readFile(f, "utf8")).toBe("третий");
  });

  test("одинаковое содержимое хранится один раз, события — все", async () => {
    const a = makeArchive();
    const one = path.join(lib, "one.txt");
    const two = path.join(decks, "two.txt");
    await writeFile(one, "дубликат");
    await writeFile(two, "дубликат");
    const r1 = await a.archiveFile(one, { kind: "upload" });
    const r2 = await a.archiveFile(two, { kind: "upload" });
    expect(r2!.sha256).toBe(r1!.sha256);
    expect(r2!.stored).toBe(false);
    const shard = await readdir(path.dirname(r1!.storedPath));
    expect(shard.filter((n) => !n.startsWith(TMP_PREFIX))).toEqual([r1!.sha256]);
    expect(await scalar(`SELECT count(*) FROM archive.file_events WHERE sha256 = $1`, [r1!.sha256])).toBe(2);
  });

  test("перезапись атомарная: архивная копия прежней версии цела", async () => {
    const a = makeArchive();
    const f = path.join(lib, "lecture-1.txt");
    await a.writeDataFile(f, "версия 1", { entityType: "lecture", entityId: 1 });
    const v1 = await a.archiveFile(f, { kind: "write" });
    await a.writeDataFile(f, "версия 2", { entityType: "lecture", entityId: 1 });

    expect(await readFile(f, "utf8")).toBe("версия 2");
    expect(await readFile(v1!.storedPath, "utf8")).toBe("версия 1");
    const v2 = await a.archiveFile(f, { kind: "write" });
    expect(await readFile(v2!.storedPath, "utf8")).toBe("версия 2");
    // Временных файлов атомарной записи в каталоге данных не осталось.
    expect((await readdir(lib)).filter((n) => n.startsWith(TMP_PREFIX))).toEqual([]);
  });

  test("writeFileAtomic не трогает прежний inode (на нём висят архив и снимки)", async () => {
    const f = path.join(lib, "x.txt");
    await writeFile(f, "старое");
    const before = (await stat(f)).ino;
    await writeFileAtomic(f, "новое");
    expect((await stat(f)).ino).not.toBe(before);
  });

  test("сверка находит пропущенный файл и не хэширует известное заново", async () => {
    const a = makeArchive();
    const nested = path.join(decks, "7");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "3.png"), "картинка мимо архива");
    await writeFile(path.join(lib, "book.epub"), "книга мимо архива");
    await writeFile(path.join(lib, `${TMP_PREFIX}half`), "недописанное");
    await symlink(path.join(lib, "book.epub"), path.join(lib, "link.epub"));

    const first = await a.sweep();
    expect(first).toMatchObject({ archived: 2, failed: 0 });
    expect(await scalar(`SELECT count(*) FROM archive.file_seen WHERE path LIKE $1`, [`${root}%`])).toBe(2);

    const second = await a.sweep();
    expect(second.archived).toBe(0);

    await writeFileAtomic(path.join(lib, "book.epub"), "книга, второе издание");
    const third = await a.sweep();
    expect(third.archived).toBe(1);
  });

  test("rm без успешной архивации не выполняется", async () => {
    const a = makeArchive();
    const f = path.join(lib, "keep.txt");
    await writeFile(f, "нельзя терять");

    isReady = false;
    await expect(a.archiveAndRemove(f, { entityType: "document" })).rejects.toBeInstanceOf(
      ArchiveUnavailableError,
    );
    expect(await readFile(f, "utf8")).toBe("нельзя терять");

    isReady = true;
    failQueries = true;
    await expect(a.archiveAndRemove(f, { entityType: "document" })).rejects.toThrow(/недоступна/);
    expect(await readFile(f, "utf8")).toBe("нельзя терять");

    failQueries = false;
    const r = await a.archiveAndRemove(f, { entityType: "document" });
    await expect(stat(f)).rejects.toThrow();
    expect(await readFile(r!.storedPath, "utf8")).toBe("нельзя терять");
  });

  test("файл вне каталогов данных архивируется, но не удаляется", async () => {
    const a = makeArchive();
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "чужое");
    const r = await a.archiveAndRemove(outside, { entityType: "document" });
    expect(r).not.toBeNull();
    expect(await readFile(outside, "utf8")).toBe("чужое");
  });

  test("нет файла — нечего архивировать и нечего удалять", async () => {
    const a = makeArchive();
    expect(await a.archiveAndRemove(path.join(lib, "нет.txt"), {})).toBeNull();
  });

  test("каталог колоды: удаляется, только когда всё в архиве", async () => {
    const a = makeArchive();
    const dir = path.join(decks, "12");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "1.png"), "образ 1");
    await writeFile(path.join(dir, "2.png"), "образ 2");

    failQueries = true;
    await expect(a.archiveTreeAndRemove(dir, { entityType: "deck", entityId: 12 })).rejects.toThrow();
    expect((await readdir(dir)).sort()).toEqual(["1.png", "2.png"]);

    failQueries = false;
    expect(await a.archiveTreeAndRemove(dir, { entityType: "deck", entityId: 12 })).toBe(2);
    await expect(stat(dir)).rejects.toThrow();
    // Ровно по одному событию на файл — без повторной архивации при rm.
    expect(
      await scalar(
        `SELECT count(*) FROM archive.file_events WHERE entity_type = 'deck' AND entity_id = 12 AND kind = 'remove'`,
      ),
    ).toBe(2);
  });

  test("каталог колоды: файл дописали на месте между проходами — перед rm архивируется заново", async () => {
    const dir = path.join(decks, "13");
    await mkdir(dir, { recursive: true });
    const one = path.join(dir, "1.png");
    await writeFile(one, "образ 1");
    await writeFile(path.join(dir, "2.png"), "образ 2");
    // Другой диск: архив — копия, а не ссылка, и запись на месте (тот же
    // inode) архивную копию не трогает. Сверка только по inode пропустила бы
    // такую правку, и rm стёр бы дописанное.
    let seen = 0;
    const a = makeArchive({
      link: failingLink("EXDEV"),
      query: async (text, params) => {
        const r = await query(text, params);
        if (text.includes("INSERT INTO archive.file_seen") && ++seen === 2) {
          await appendFile(one, " и дописанное");
        }
        return r;
      },
    });

    expect(await a.archiveTreeAndRemove(dir, { entityType: "deck", entityId: 13 })).toBe(2);
    await expect(stat(dir)).rejects.toThrow();
    const shas = (
      await db.query(
        `SELECT e.sha256 FROM archive.file_events e WHERE e.source_path = $1 ORDER BY e.id`,
        [path.resolve(one)],
      )
    ).rows.map((r) => String(r["sha256"]));
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    // Обе версии — и до, и после дописывания — в архиве.
    expect(shas).toEqual([sha("образ 1"), sha("образ 1 и дописанное")]);
    expect(await readFile(path.join(archiveDir, shas[1]!.slice(0, 2), shas[1]!), "utf8")).toBe(
      "образ 1 и дописанное",
    );
  });

  test("гонка двух архиваций одного содержимого: объект не подменяется", async () => {
    const one = path.join(lib, "race-1.txt");
    const two = path.join(decks, "race-2.txt");
    await writeFile(one, "одно содержимое");
    await writeFile(two, "одно содержимое");

    // Обе архивации проходят проверку «объекта ещё нет», затем первая
    // публикует объект целиком, и только потом вторая пытается свой.
    let secondReached!: () => void;
    const secondAtLink = new Promise<void>((r) => (secondReached = r));
    let firstDone!: () => void;
    const firstFinished = new Promise<void>((r) => (firstDone = r));
    const racyLink: typeof link = async (from, to) => {
      if (String(from) === one) await secondAtLink;
      if (String(from) === two) {
        secondReached();
        await firstFinished;
      }
      return link(from, to);
    };
    const a = makeArchive({ link: racyLink });
    const p1 = a.archiveFile(one, { kind: "upload" }).then((r) => {
      firstDone();
      return r;
    });
    const p2 = a.archiveFile(two, { kind: "upload" });
    const [r1, r2] = await inTime(Promise.all([p1, p2]));

    expect(r1!.sha256).toBe(r2!.sha256);
    expect(r1!.stored).toBe(true);
    expect(r2!.stored).toBe(false);
    // Объект — по-прежнему первый файл (тот же inode), rename поверх его бы заменил.
    expect((await stat(r1!.storedPath)).ino).toBe((await stat(one)).ino);
    expect(await readFile(r1!.storedPath, "utf8")).toBe("одно содержимое");
    const shard = await readdir(path.dirname(r1!.storedPath));
    expect(shard).toEqual([r1!.sha256]);
    expect(await scalar(`SELECT count(*) FROM archive.file_events WHERE sha256 = $1`, [r1!.sha256])).toBe(2);
  });

  test("запись поверх существующего файла без архива не идёт", async () => {
    const a = makeArchive();
    const f = path.join(lib, "deck-1.txt");
    await writeFile(f, "прежний текст");
    isReady = false;
    await expect(a.writeDataFile(f, "новый", { entityType: "deck" })).rejects.toBeInstanceOf(
      ArchiveUnavailableError,
    );
    expect(await readFile(f, "utf8")).toBe("прежний текст");
  });
});
