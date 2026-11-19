import { test, expect } from "vitest";
import { planPrompt, planSections, renumberCitations, sectionPrompt, titleFromTopic } from "./lecture-prompt";

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
});

test("указания как у бота: коротко, без отдельной методики, с задачей автора", () => {
  const brief = { topic: "Перенос у Фрейда", audience: "коллеги", durationMin: 90, documentIds: [], focus: ["clinical" as const], mustInclude: "случай Доры" };
  const plan = planPrompt(brief, "Перенос", 6);
  expect(plan).toContain("Тема лекции: Перенос. Замысел автора: Перенос у Фрейда. Хронометраж: 90 минут.");
  expect(plan).toContain("Акцент: клинический.");
  expect(plan).toContain("Обязательно включи: случай Доры");
  expect(plan).toContain("сохраняй предмет, соотносимые понятия");
  expect(plan).toContain('"outOfScope"');
  // Прежняя методика ушла целиком.
  expect(plan).not.toContain("PEP-Web");
  expect(plan).not.toContain("ТРЕБОВАНИЯ К КАЧЕСТВУ");
  expect(plan.split("\n").length).toBeLessThan(25);
});

test("аудитория и акцент необязательны: пусто - строки нет", () => {
  const plan = planPrompt({ topic: "Сны", audience: "", durationMin: 90, documentIds: [] }, "Сны", 6);
  expect(plan).not.toContain("Аудитория:");
  expect(plan).not.toContain("Акцент:");
  expect(plan).toContain("6 смысловых блоков.");
});

test("уровень изложения - профессиональный, если аудитория не указана иначе", () => {
  const plan = planPrompt({ topic: "Сны", audience: "", durationMin: 90, documentIds: [] }, "Сны", 6);
  expect(plan).toContain("Уровень - профессиональный");
  expect(plan).toContain("Без общих мест,\nупрощений");
});

test("planSections: одно правило для плана модели и правки автора", () => {
  expect(
    planSections([
      { heading: "  Перенос ", abstract: " тезис ", concepts: ["Фрейд", "", 3, " Клейн "], hook: " вопрос " },
      { heading: "   ", abstract: "без названия" },
      "мусор",
    ]),
  ).toEqual([{ heading: "Перенос", abstract: "тезис", concepts: ["Фрейд", "Клейн"], hook: "вопрос" }]);
  expect(planSections(null)).toEqual([]);
});
