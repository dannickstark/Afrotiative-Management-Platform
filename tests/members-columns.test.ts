import { describe, expect, test } from "bun:test";
import { memberLastLoginSortValue } from "@/components/settings/members-columns";

// B6: the members DataTable sorts its "Dernière connexion" column off this pure ms accessor (the
// cell itself still DISPLAYS lib/format.ts's existing formatDate string, unchanged from the old
// hand-rolled table — that formatter is reused as-is and isn't re-tested here). This test only
// covers the one bit of new logic: the numeric sort key, including the "never logged in" case
// where there's no lastLoginAt yet.
describe("memberLastLoginSortValue", () => {
  test("returns the timestamp in ms for a member who has logged in", () => {
    const d = "2026-08-12T08:00:01.500Z";
    expect(memberLastLoginSortValue(d)).toBe(new Date(d).getTime());
  });

  test("accepts Date objects, not just ISO strings", () => {
    const d = new Date("2026-08-12T08:00:05Z");
    expect(memberLastLoginSortValue(d)).toBe(d.getTime());
  });

  test("sorts a never-logged-in member as the oldest, not zero/NaN", () => {
    expect(memberLastLoginSortValue(null)).toBe(Number.NEGATIVE_INFINITY);
  });

  test("a never-logged-in member sorts before any real timestamp", () => {
    const never = memberLastLoginSortValue(null);
    const loggedIn = memberLastLoginSortValue("2026-08-12T08:00:00Z");
    expect(never).toBeLessThan(loggedIn);
  });
});
