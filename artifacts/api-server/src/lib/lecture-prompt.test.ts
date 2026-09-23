import { test, expect } from "vitest";
import { renumberCitations, sectionPrompt, titleFromTopic } from "./lecture-prompt";

test("renumberCitations: номера в тексте совпадают со списком источников под главой", () => {
  // Процитированы выдержка 3 и веб-источник 7 — под главой они станут 1 и 2.
  expect(renumberCitations("Фрейд [3], Кляйн [7], снова [3].", [3, 7])).toBe(
    "Фрейд [1], Кляйн [2], снова [1].",
  );
  // Номер, которого не было в материале, не трогаем.
  expect(renumberCitations("Выдумка [9] и [3]", [3])).toBe("Выдумка [9] и [1]");
  expect(renumberCitations("Без ссылок", [])).toBe("Без ссылок");
});

test("titleFromTopic: тема до 70 знаков остаётся целой", () => {
  expect(titleFromTopic("З. Фрейд и толкование сновидений")).toBe("З. Фрейд и толкование сновидений");
  expect(titleFromTopic("Лекция о Лакане, т. е. о зеркальной стадии")).toBe(
    "Лекция о Лакане, т. е. о зеркальной стадии",
  );
  expect(titleFromTopic("Лекция проф. Иванова о переносе")).toBe("Лекция проф. Иванова о переносе");
  expect(titleFromTopic("Защиты, напр. проекция и расщепление")).toBe("Защиты, напр. проекция и расщепление");
  expect(titleFromTopic("Термин лат. происхождения")).toBe("Термин лат. происхождения");
  expect(titleFromTopic("Защитные механизмы. Начать с Анны Фрейд.")).toBe(
    "Защитные механизмы. Начать с Анны Фрейд",
  );
  expect(titleFromTopic("\nТема\nподробности")).toBe("Тема");
});

test("titleFromTopic: длинная тема — первая фраза, иначе граница слова", () => {
  expect(
    titleFromTopic(
      "защитные механизмы личности — для студентов второго курса. Начать с Фрейда и дойти до современных взглядов, с клиническими примерами.",
    ),
  ).toBe("защитные механизмы личности — для студентов второго курса");
  expect(
    titleFromTopic("Теория объектных отношений М. Кляйн. Для студентов второго курса и для всех, кто работает с детьми"),
  ).toBe("Теория объектных отношений М. Кляйн");
  const long =
    "Психоаналитическая теория объектных отношений в работах британской школы середины двадцатого века";
  const title = titleFromTopic(long);
  expect(title).toBe("Психоаналитическая теория объектных отношений в работах британской…");
  expect(title.length).toBeLessThanOrEqual(71);
});

test("sectionPrompt: вынесенное планом за скобки доходит до письма главы", () => {
  const base = {
    brief: { topic: "Перенос", audience: "коллеги", durationMin: 60, documentIds: [] },
    title: "Перенос",
    heading: "Истоки",
    abstract: "Фрейд о переносе",
    concepts: [],
    hook: "",
    words: 1500,
    nextHeading: null,
  };
  const withNotes = sectionPrompt({ ...base, outOfScope: ["Лакан", "нейронауки"] });
  expect(withNotes).toContain("Сознательно за скобками (не разворачивай): Лакан; нейронауки.");
  expect(sectionPrompt({ ...base, outOfScope: [] })).not.toContain("за скобками");
  // Метки скрытых имён из копий расшифровок в текст не переносятся.
  expect(withNotes).toContain("[[PER1]]");
});
