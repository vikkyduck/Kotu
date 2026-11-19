import { afterEach, expect, test, vi } from "vitest";
import { payloadFor, pickEffort } from "./codex";

/** Глубина рассуждения: лекции просят high, без неё Codex думает на medium. */

afterEach(() => vi.unstubAllEnvs());

test("pickEffort: из .env, неизвестное слово или пусто - запасное значение", () => {
  vi.stubEnv("EFFORT_LECTURE", "");
  expect(pickEffort("EFFORT_LECTURE", "high")).toBe("high");
  vi.stubEnv("EFFORT_LECTURE", " Medium ");
  expect(pickEffort("EFFORT_LECTURE", "high")).toBe("medium");
  vi.stubEnv("EFFORT_LECTURE", "xhigh");
  expect(pickEffort("EFFORT_LECTURE", "high")).toBe("xhigh");
  vi.stubEnv("EFFORT_LECTURE", "max");
  expect(pickEffort("EFFORT_LECTURE", "high")).toBe("max");
  // Чего нет в лестнице Codex - запасное значение.
  vi.stubEnv("EFFORT_LECTURE", "ultra");
  expect(pickEffort("EFFORT_LECTURE", "high")).toBe("high");
});

test("payloadFor: reasoning только когда глубина задана", () => {
  const base = { model: "gpt-6.1-sol", system: "s", user: "u" };
  expect(payloadFor({ ...base, effort: "high" }, [])["reasoning"]).toEqual({ effort: "high" });
  expect(payloadFor(base, [])).not.toHaveProperty("reasoning");
});

test("payloadFor: подробность ответа уходит в text.verbosity, только когда задана", () => {
  const base = { model: "gpt-6.1-sol", system: "s", user: "u" };
  expect(payloadFor({ ...base, verbosity: "high" }, [])["text"]).toEqual({ verbosity: "high" });
  expect(payloadFor(base, [])).not.toHaveProperty("text");
});

test("payloadFor: веб-поиск - глубокий (search_context_size high) и обязательный", () => {
  const p = payloadFor({ model: "gpt-6.1-sol", system: "s", user: "u", webSearch: true }, []);
  expect(p["tools"]).toEqual([{ type: "web_search", search_context_size: "high" }]);
  expect(p["tool_choice"]).toBe("required");
});
