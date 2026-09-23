import { test, expect } from "vitest";
import { documentFileHeaders } from "./file-headers";

const nameOf = (h: Record<string, string>) => decodeURIComponent(h["Content-Disposition"]!.split("''")[1]!);

test("книга без имени файла в задаче: PDF по mime открывается во вкладке", () => {
  const h = documentFileHeaders({ title: "Фрейд. Толкование", mime: "application/pdf" }, undefined);
  expect(h["Content-Type"]).toBe("application/pdf");
  expect(h["Content-Disposition"]).toMatch(/^inline;/);
  expect(nameOf(h)).toBe("Фрейд. Толкование.pdf");
});

test("имя файла из задачи важнее присланного типа", () => {
  const h = documentFileHeaders({ title: "Заметки", mime: "application/octet-stream" }, "заметки.md");
  expect(h["Content-Type"]).toBe("text/plain; charset=utf-8");
  expect(h["Content-Disposition"]).toMatch(/^inline;/);
  expect(nameOf(h)).toBe("Заметки.md");
});

test("HTML и docx скачиваются, даже если тип прислан как text/html", () => {
  for (const [mime, ext] of [["text/html", "html"], ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"]]) {
    const h = documentFileHeaders({ title: "Статья", mime: mime! }, undefined);
    expect(h["Content-Type"]).toBe("application/octet-stream");
    expect(h["Content-Disposition"]).toMatch(/^attachment;/);
    expect(nameOf(h)).toBe(`Статья.${ext}`);
  }
});

test("неизвестный тип без имени — скачать под названием книги", () => {
  const h = documentFileHeaders({ title: "Книга", mime: "application/octet-stream" }, undefined);
  expect(h["Content-Type"]).toBe("application/octet-stream");
  expect(h["Content-Disposition"]).toMatch(/^attachment;/);
  expect(nameOf(h)).toBe("Книга");
});
