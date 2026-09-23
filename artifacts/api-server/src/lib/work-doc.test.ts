import { test, expect, vi } from "vitest";

/**
 * В библиотеку попадает только готовая колода: правка слайда и переделка
 * бывают и у неутверждённой раскадровки, но черновику в поиске не место.
 */

const deck = { id: 5, ownerId: 1, title: "Черновик", folderId: null, status: "storyboard_ready" };
const insert = vi.fn();
const chain = { from: () => chain, where: () => chain, orderBy: () => chain, limit: async () => [deck] };

vi.mock("@workspace/db", () => ({
  db: { select: () => chain, insert },
  documentsTable: {},
  decksTable: {},
  deckSlidesTable: {},
}));

const { deckToLibrary } = await import("./work-doc");

test("колода не в ready — копия не заводится", async () => {
  expect(await deckToLibrary(deck.id)).toBeNull();
  expect(insert).not.toHaveBeenCalled();
});
