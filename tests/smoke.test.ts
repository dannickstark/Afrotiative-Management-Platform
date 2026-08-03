import { expect, test } from "bun:test";

test("environment is wired", () => {
  expect(1 + 1).toBe(2);
});
