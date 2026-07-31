import { test, describe, expect } from "vitest";
import { writeFile } from "node:fs/promises";
import type { Deck, DeckSlide, StylePack } from "@workspace/db";
import { buildDeckPdf } from "./pdf";
import { buildDeckPptx } from "./pptx";

/**
 * Выгрузка собирается для всех восьми макетов сразу.
 *
 * Геометрия слайда живёт в одной таблице, но рисуют по ней три разных движка
 * (PowerPoint, PDF, предпросмотр в браузере). Этот тест — страховка от того,
 * что правка таблицы уронит один из них: он прогоняет колоду со всеми
 * макетами через оба экспорта и проверяет, что файлы получились.
 *
 * Если задать SNAPSHOT_DIR, тест дополнительно кладёт туда готовые файлы —
 * так выгрузку можно сравнить до и после правки.
 */

const deck = {
  id: 1,
  ownerId: 1,
  title: "Работа негатива",
  folderId: null,
  sourceKind: "raw",
  sourceId: null,
  stylePackId: 1,
  storyboardApproved: true,
  status: "ready",
  statusMessage: "",
  error: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
} as unknown as Deck;

const pack = {
  id: 1,
  ownerId: null,
  name: "Архивный сон",
  promptSuffix: "",
  negative: "",
  palette: {},
  typography: null,
  rules: null,
  createdAt: new Date(0),
} as unknown as StylePack;

const common = {
  deckId: 1,
  notes: "Заметка докладчику: раскрыть мысль голосом.",
  imageBrief: null,
  imageSide: "right" as const,
  imageId: null,
  imageStatus: "none" as const,
  diagramSpec: null,
};

const slides = [
  {
    id: 1, ord: 0, layout: "cover",
    content: { eyebrow: "Открытый семинар", title: "Работа негатива", subtitle: "Шесть маршрутов чтения" },
  },
  { id: 2, ord: 1, layout: "divider", content: { eyebrow: "Часть первая", title: "I · Отрицание" } },
  {
    id: 3, ord: 2, layout: "theory",
    content: {
      title: "Отрицание не отменяет восприятие",
      bullets: ["Сказанное «нет» уже воспринято", "Отрицание — форма признания", "Слушать то, что отвергается настойчиво"],
      question: "Что в материале нельзя восстановить как связный рассказ?",
      plate: "PLATE V",
    },
  },
  {
    id: 4, ord: 3, layout: "quote",
    content: { quote: "Отрицание не устраняет восприятие — оно меняет его психическую судьбу", attribution: "Фрейд, 1925" },
  },
  {
    id: 5, ord: 4, layout: "clinical",
    content: {
      title: "Пустое кресло",
      bullets: ["Пациентка говорит о звонке, которого ждёт.", "Кресло напротив остаётся пустым весь час."],
      question: "Что остаётся после исчезновения собеседника?",
    },
  },
  {
    id: 6, ord: 5, layout: "comparison",
    content: {
      title: "Verneinung и Verwerfung",
      cards: [
        { title: "Verneinung", body: "Отвергнутое возвращается в символическом" },
        { title: "Verwerfung", body: "Форклюзированное возвращается в Реальном" },
      ],
    },
  },
  {
    id: 7, ord: 6, layout: "diagram",
    content: { title: "Маршрут работы негатива" },
    diagramSpec: {
      kind: "flow",
      items: [
        { label: "Восприятие", sub: "след отпечатался" },
        { label: "Отказ", sub: "вход со знаком минус" },
        { label: "Возвращение", sub: "окольными путями" },
      ],
    },
  },
  {
    id: 8, ord: 7, layout: "final",
    content: { title: "Негатив — не пустота, а работа", subtitle: "К следующему чтению: Грин" },
  },
].map((s) => ({ ...common, ...s })) as unknown as DeckSlide[];

const snapshotDir = process.env["SNAPSHOT_DIR"];

describe("выгрузка презентации", () => {
  test("PDF собирается по всем восьми макетам", async () => {
    const pdf = await buildDeckPdf(deck, slides, new Map(), pack);

    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(20_000);
    // Восемь слайдов — восемь листов.
    expect(pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g)?.length).toBe(8);

    if (snapshotDir) await writeFile(`${snapshotDir}/deck.pdf`, pdf);
  });

  test("PPTX собирается по всем восьми макетам", async () => {
    const pptx = await buildDeckPptx(deck, slides, new Map(), pack);

    // PPTX — это zip, он начинается с PK.
    expect(pptx.subarray(0, 2).toString()).toBe("PK");
    expect(pptx.length).toBeGreaterThan(20_000);

    if (snapshotDir) await writeFile(`${snapshotDir}/deck.pptx`, pptx);
  });
});
