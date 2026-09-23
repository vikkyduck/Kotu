import { test, describe, expect } from "vitest";
import { resolveInsideDir } from "./uploads";

const DIR = "/opt/kotu/uploads";

describe("resolveInsideDir", () => {
  test("путь внутри каталога нормализуется", () => {
    expect(resolveInsideDir(DIR, `${DIR}/a/../b`)).toBe(`${DIR}/b`);
    expect(resolveInsideDir(DIR, "abc")).toBe(`${DIR}/abc`);
  });

  test("выход за каталог, сам каталог и мусор отбрасываются", () => {
    expect(resolveInsideDir(DIR, `${DIR}/../library/book.pdf`)).toBeNull();
    expect(resolveInsideDir(DIR, "/etc/passwd")).toBeNull();
    expect(resolveInsideDir(DIR, `${DIR}-evil/x`)).toBeNull();
    expect(resolveInsideDir(DIR, DIR)).toBeNull();
    expect(resolveInsideDir(DIR, "")).toBeNull();
    expect(resolveInsideDir(DIR, undefined)).toBeNull();
    expect(resolveInsideDir(DIR, 42)).toBeNull();
  });

  test("имя файла, начинающееся с точек, — не выход за каталог", () => {
    expect(resolveInsideDir(DIR, `${DIR}/..hidden`)).toBe(`${DIR}/..hidden`);
  });
});
