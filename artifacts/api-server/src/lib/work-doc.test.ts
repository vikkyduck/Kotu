import { test, expect, vi, beforeEach } from "vitest";

const deck = { id: 5, ownerId: 1, title: "Черновик", folderId: null, status: "storyboard_ready" };
/** Что по очереди вернут select-запросы (каждый заканчивается на limit). */
let selects: unknown[][] = [];
const insertValues = vi.fn();
const updateSet = vi.fn();
const chain = {
  from: () => chain,
  where: () => chain,
  orderBy: () => chain,
  limit: async () => selects.shift() ?? [],
};

vi.mock("@workspace/db", () => ({
  db: {
    select: () => chain,
    insert: () => ({
      values: (v: object) => {
        insertValues(v);
        // Копия уже есть — вставка упирается в уникальный индекс.
        return { onConflictDoNothing: () => ({ returning: async () => [] }) };
      },
    }),
    update: () => ({
      set: (v: object) => {
        updateSet(v);
        return { where: async () => undefined };
      },
    }),
  },
  documentsTable: {},
  decksTable: {},
  deckSlidesTable: {},
  jobsTable: {},
}));
vi.mock("./archive", () => ({ writeDataFile: vi.fn(async () => undefined), archiveAndRemove: vi.fn() }));
vi.mock("./jobs", () => ({ enqueue: vi.fn(async () => undefined) }));

const { deckToLibrary, upsertWorkDoc } = await import("./work-doc");
const { documentsTable } = await import("@workspace/db");

beforeEach(() => {
  selects = [];
  insertValues.mockClear();
  updateSet.mockClear();
});

/**
 * В библиотеку попадает только готовая колода: правка слайда и переделка
 * бывают и у неутверждённой раскадровки, но черновику в поиске не место.
 */
test("колода не в ready — копия не заводится", async () => {
  selects = [[deck]];
  expect(await deckToLibrary(deck.id)).toBeNull();
  expect(insertValues).not.toHaveBeenCalled();
});

const base = {
  ownerId: 1,
  title: "Сессия",
  link: { column: documentsTable.transcriptionId, id: 7 },
  fileName: "transcript-7.txt",
  text: "слово ".repeat(100),
};

/**
 * Папку копии расшифровки выбирает пользовательница (своей папки у записи
 * нет) — правка слова или стартовая сверка не должны уносить её в корень.
 */
test("повторная синхронизация расшифровки не трогает папку копии", async () => {
  selects = [[{ id: 42 }], []];
  const docId = await upsertWorkDoc({ ...base, kind: "transcript", values: { transcriptionId: 7 } });
  expect(docId).toBe(42);
  expect(updateSet).toHaveBeenCalledOnce();
  expect(updateSet.mock.calls[0][0]).not.toHaveProperty("folderId");
});

test("новая копия расшифровки ложится в корень", async () => {
  selects = [[{ id: 42 }], []];
  await upsertWorkDoc({ ...base, kind: "transcript", values: { transcriptionId: 7 } });
  expect(insertValues.mock.calls[0][0]).toMatchObject({ folderId: null });
});

test("копия лекции переезжает вслед за лекцией", async () => {
  selects = [[{ id: 43 }], []];
  await upsertWorkDoc({ ...base, kind: "lecture", values: { lectureId: 7 }, folderId: 3 });
  expect(updateSet.mock.calls[0][0]).toMatchObject({ folderId: 3 });
});
