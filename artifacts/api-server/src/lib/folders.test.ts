import { test, describe, expect, vi, beforeEach } from "vitest";

/**
 * Номер папки при перекладывании и загрузке: одно правило с номерами в адресе.
 * Кривой номер — «папки нет» ещё до базы; настоящий — проверяется в базе.
 */

// Модуль тянет базу, а без DATABASE_URL она падает прямо при импорте; здесь
// база подменена: важно лишь, дошло ли дело до запроса и с каким номером.
const found = vi.fn<() => { id: number }[]>();
const limit = vi.fn(async () => found());
vi.mock("@workspace/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit }) }) }) },
  foldersTable: { id: "id", ownerId: "ownerId" },
}));

const { ownFolderId } = await import("./folders");

beforeEach(() => {
  limit.mockClear();
  found.mockReset();
});

describe("ownFolderId", () => {
  test("null — вынуть из папки, без похода в базу", async () => {
    expect(await ownFolderId(null, 1)).toBeNull();
    expect(limit).not.toHaveBeenCalled();
  });

  test("номер из JSON и из формы — одна и та же папка", async () => {
    found.mockReturnValue([{ id: 5 }]);
    expect(await ownFolderId(5, 1)).toBe(5);
    expect(await ownFolderId("5", 1)).toBe(5);
  });

  test("чужая или удалённая папка — undefined", async () => {
    found.mockReturnValue([]);
    expect(await ownFolderId(5, 1)).toBeUndefined();
  });

  test("кривой номер папкой не считается и в базу не уходит", async () => {
    for (const raw of ["0x10", "1e1", " 5 ", "", true, 1.5, -3, 0, "100000000000000000000", undefined]) {
      expect(await ownFolderId(raw, 1)).toBeUndefined();
    }
    expect(limit).not.toHaveBeenCalled();
  });
});
