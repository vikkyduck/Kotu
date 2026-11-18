import { expect, test } from "vitest";
import { hideLabels } from "./name-labels";

test("hideLabels: метки старых копий в выдаче — «имя скрыто», «место скрыто»", () => {
  expect(hideLabels("[[PER1]] из [[LOC12]] говорит с [[PER2]]")).toBe(
    "имя скрыто из место скрыто говорит с имя скрыто",
  );
});
