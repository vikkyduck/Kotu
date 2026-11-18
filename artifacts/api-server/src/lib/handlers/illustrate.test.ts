import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Приемка оплаченной картинки и ожидание подписки Codex.
 *
 * Если подписка стала недоступна во время приемки, нарисованная картинка
 * уже на диске и оплачена. Она ставится на слайд без проверки, а не
 * бросается: иначе отложенная задача начала бы слайд заново и заплатила бы
 * за новую картинку. База, модели и файлы подменены.
 */

const updates = vi.hoisted(() => [] as { table: string; values: Record<string, unknown> }[]);

vi.mock("drizzle-orm", () => ({ and: () => ({}), asc: () => ({}), eq: () => ({}), inArray: () => ({}), isNotNull: () => ({}) }));
vi.mock("@workspace/db", () => {
  const decksTable = { name: "decks" };
  const deckSlidesTable = { name: "deck_slides" };
  const deckImagesTable = { name: "deck_images" };
  return {
    decksTable,
    deckSlidesTable,
    deckImagesTable,
    db: {
      insert: () => ({ values: (v: Record<string, unknown>) => ({ returning: async () => [{ id: 77, ...v }] }) }),
      update: (table: { name: string }) => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            updates.push({ table: table.name, values });
          },
        }),
      }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 5 }] }) }) }),
    },
  };
});
vi.mock("@workspace/db/slides", () => ({ layoutHasImage: () => true, layoutSided: () => true }));
vi.mock("../codex", () => ({
  askJson: vi.fn(),
  pickModel: (_name: string, fallback: string) => fallback,
  ModelWaitError: class ModelWaitError extends Error {
    constructor(message: string, readonly until: Date, readonly kind: string) {
      super(message);
    }
  },
}));
vi.mock("../images", () => ({
  renderIllustration: vi.fn(async () => ({
    buffer: Buffer.from("png"),
    provider: "codex",
    model: "gpt-image-2",
    mime: "image/png",
    ext: "png",
  })),
}));
vi.mock("../jobs", () => ({ registerHandler: vi.fn(), enqueue: vi.fn() }));
vi.mock("../paths", () => ({ DECKS_DIR: "/tmp/kotu-test-decks" }));
vi.mock("../work-doc", () => ({ deckToLibrary: vi.fn() }));
vi.mock("../archive", () => ({ writeDataFile: vi.fn(async () => undefined) }));
vi.mock("../deck-style", () => ({ deckStylePack: vi.fn() }));
vi.mock("./storyboard", () => ({ NO_PACK: "Нет стилевого пакета", onGiveUp: vi.fn(), onWait: vi.fn() }));

import type { DeckSlide, StylePack } from "@workspace/db";
import { askJson, ModelWaitError } from "../codex";
import { renderIllustration } from "../images";
import { illustrateSlide } from "./illustrate";

const slide = { id: 9, imageBrief: "Память как архив", layout: "image_right", imageSide: "right" } as unknown as DeckSlide;
const pack = {
  promptSuffix: "engraving, {{SECOND_METAPHOR}}, image {{IMAGE_SIDE}}, calm {{SAFE_SIDE}}",
  negative: "text, letters",
  rules: {},
} as unknown as StylePack;

beforeEach(() => {
  updates.length = 0;
  vi.mocked(askJson).mockReset();
  vi.mocked(renderIllustration).mockClear();
});

describe("приемка во время ожидания подписки", () => {
  test("оплаченная картинка ставится без проверки и не рисуется заново", async () => {
    vi.mocked(askJson)
      .mockResolvedValueOnce({ scene: "An archive of drawers", secondMetaphor: "roots" })
      .mockRejectedValueOnce(new ModelWaitError("Ждем Codex", new Date(Date.now() + 600_000), "quota"));

    await expect(illustrateSlide(5, slide, pack, undefined)).resolves.toBeUndefined();

    expect(renderIllustration).toHaveBeenCalledTimes(1);
    const image = updates.find((u) => u.table === "deck_images" && "status" in u.values);
    expect(image?.values).toMatchObject({ status: "ready" });
    expect(String(image?.values["verdict"])).toContain("без проверки");
    expect(updates).toContainEqual({ table: "deck_slides", values: { imageId: 77, imageStatus: "ready" } });
  });

  test("ожидание до рисования по-прежнему откладывает задачу: картинки еще нет", async () => {
    vi.mocked(askJson).mockRejectedValueOnce(new ModelWaitError("Ждем Codex", new Date(Date.now() + 600_000), "quota"));
    await expect(illustrateSlide(5, slide, pack, undefined)).rejects.toBeInstanceOf(ModelWaitError);
    expect(renderIllustration).not.toHaveBeenCalled();
  });
});
