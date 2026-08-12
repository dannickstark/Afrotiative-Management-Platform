import { describe, expect, test } from "bun:test";
import { isSessionUsable } from "@/lib/session";

describe("isSessionUsable", () => {
  test("returns false for a null user", () => {
    expect(isSessionUsable(null)).toBe(false);
  });

  test("returns false for a banned user", () => {
    expect(isSessionUsable({ banned: true })).toBe(false);
  });

  test("returns true for a non-banned user", () => {
    expect(isSessionUsable({ banned: false })).toBe(true);
  });
});
