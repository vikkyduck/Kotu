import { describe, expect, test, vi } from "vitest";
import { cleanBody, cleanDeep, cleanRequestBody, cleanText } from "./clean-text";

describe("cleanText: из текста уходит HTML, обычный текст остаётся", () => {
  test("скрипт - вместе с содержимым", () => {
    expect(cleanText('Привет<script>alert("x")</script>, мир')).toBe("Привет, мир");
    expect(cleanText("до <SCRIPT type=\"text/javascript\">steal()</SCRIPT > после")).toBe("до  после");
  });

  test("незакрытый скрипт - тег уходит, остаток становится обычным текстом", () => {
    expect(cleanText("текст <script>alert(1)")).toBe("текст alert(1)");
  });

  test("теги с обработчиками и ссылками на javascript", () => {
    expect(cleanText('<img src=x onerror="alert(1)">Фото')).toBe("Фото");
    expect(cleanText('<a href="javascript:alert(1)">ссылка</a>')).toBe("ссылка");
    expect(cleanText("<iframe src=\"https://evil\"></iframe>кадр")).toBe("кадр");
    expect(cleanText("<svg onload=alert(1)><circle/></svg>круг")).toBe("круг");
  });

  test("обычная разметка снимается, текст внутри остаётся", () => {
    expect(cleanText("<b>Перенос</b> и <i>контрперенос</i><br/>")).toBe("Перенос и контрперенос");
    expect(cleanText("<p>Абзац</p>\n<div class=\"x\">блок</div>")).toBe("Абзац\nблок");
  });

  test("вложенные обходы не собираются в новый тег", () => {
    expect(cleanText("<scr<script>x</script>ipt>alert(1)</script>")).not.toMatch(/<script/i);
  });

  test("комментарии и объявления", () => {
    expect(cleanText("а<!-- скрыто -->б<!DOCTYPE html>в<?xml version=\"1.0\"?>г")).toBe("абвг");
  });

  test("сравнения и кавычки-ёлочки - не теги", () => {
    expect(cleanText("если x < y и y > z")).toBe("если x < y и y > z");
    expect(cleanText("x<y и y>z")).toBe("x<y и y>z");
    expect(cleanText("<<Толкование сновидений>>")).toBe("<<Толкование сновидений>>");
    expect(cleanText("3 < 5 > 2")).toBe("3 < 5 > 2");
  });

  test("SQL-слова - это обычные слова, текст не портится", () => {
    const text = "SELECT * FROM users; DROP TABLE lectures; -- и ' OR 1=1";
    expect(cleanText(text)).toBe(text);
  });

  test("управляющие символы уходят, переводы строк и табуляция остаются", () => {
    expect(cleanText("а\u0000б\u0007в\r\nг\tд")).toBe("абв\nг\tд");
  });

  test("незакрытый комментарий не съедает остаток текста", () => {
    expect(cleanText("до <!-- после")).toBe("до  после");
    expect(cleanText("а <!-- x --> б <!-- в <!-- г")).toBe("а  б  в  г");
  });

  test("вопрос в угловых скобках - не объявление", () => {
    expect(cleanText("Что дальше <?> и потом")).toBe("Что дальше <?> и потом");
  });

  test("длинный текст с незакрытыми тегами не вешает очистку", () => {
    const cases = [
      "<script ".repeat(2000) + "слово ".repeat(200_000),
      "<script>".repeat(300_000),
      "<script></script>".repeat(200_000),
      "<!--".repeat(500_000),
      "<b".repeat(500_000),
    ];
    for (const big of cases) {
      const started = Date.now();
      const out = cleanText(big);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(out).not.toMatch(/<script>/i);
    }
  });
});

describe("cleanBody, cleanDeep и middleware", () => {
  test("строки на любой глубине очищаются, пароли и ключи верхнего уровня - нет", () => {
    const body = {
      email: "<b>u@example.ru</b>",
      password: "p<a>ss<script>word",
      current: "<i>старый</i>",
      next: "<i>новый</i>",
      token: "abc<def>",
      segments: [{ who: "<b>Speaker 1</b>", text: "текст<script>x</script>" }],
      plan: [{ title: "<i>Блок</i>", password: "<b>не секрет</b>" }],
      count: 3,
      flag: true,
      empty: null,
    };
    expect(cleanBody(body)).toEqual({
      email: "u@example.ru",
      password: "p<a>ss<script>word",
      current: "<i>старый</i>",
      next: "<i>новый</i>",
      token: "abc<def>",
      segments: [{ who: "Speaker 1", text: "текст" }],
      plan: [{ title: "Блок", password: "не секрет" }],
      count: 3,
      flag: true,
      empty: null,
    });
  });

  test("секретное имя у не-строки не спасает от очистки", () => {
    expect(cleanBody({ next: { text: "<b>x</b>" } })).toEqual({ next: { text: "x" } });
  });

  test("cleanDeep чистит массивы и вложенные объекты", () => {
    expect(cleanDeep(["<b>a</b>", { b: ["<i>c</i>"] }, 1])).toEqual(["a", { b: ["c"] }, 1]);
  });

  test("middleware чистит тело запроса и передаёт дальше", () => {
    const req = { body: { topic: "<script>x</script>Сны" } } as never;
    const next = vi.fn();
    cleanRequestBody(req, {} as never, next);
    expect((req as { body: { topic: string } }).body.topic).toBe("Сны");
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("запрос без тела - просто дальше", () => {
    const next = vi.fn();
    cleanRequestBody({ body: undefined } as never, {} as never, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
