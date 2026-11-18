import { afterEach, expect, test, vi } from "vitest";
import { payloadFor, pickEffort } from "./codex";

/** Глубина рассуждения: лекции просят high, без неё Codex думает на medium. */

afterEach(() => vi.unstubAllEnvs());

test("pickEffort: из .env, неизвестное слово или пусто - запасное значение", () => {
  vi.stubEnv("EFFORT_LECTURE", "");
  expect(pickEffort("EFFORT_LECTURE", "high")).toBe("high");
  vi.stubEnv("EFFORT_LECTURE", " Medium ");
  expect(pickEffort("EFFORT_LECTURE", "high")).toBe("medium");
  // xhigh и max мост платформы не пропускает - берём запасное.
  vi.stubEnv("EFFORT_LECTURE", "max");
  expect(pickEffort("EFFORT_LECTURE", "high")).toBe("high");
});

test("payloadFor: reasoning только когда глубина задана", () => {
  const base = { model: "gpt-6.1-sol", system: "s", user: "u" };
  expect(payloadFor({ ...base, effort: "high" }, [])["reasoning"]).toEqual({ effort: "high" });
  expect(payloadFor(base, [])).not.toHaveProperty("reasoning");
});
