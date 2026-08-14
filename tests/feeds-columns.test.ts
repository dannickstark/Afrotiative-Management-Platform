import { describe, expect, test } from "bun:test";
import { feedLastFetchSortValue } from "@/components/settings/feeds-columns";

// B5: the feeds DataTable sorts its "Dernière lecture" column off this pure ms accessor (the cell
// itself still DISPLAYS lib/format.ts's existing relativeDate string, unchanged from the old
// hand-rolled table — that formatter is reused as-is and isn't re-tested here). This test only
// covers the one bit of new logic: the numeric sort key, including the "never fetched" case where
// there's no lastFetchAt yet.
describe("feedLastFetchSortValue", () => {
  test("returns the timestamp in ms for a fetched feed", () => {
    const d = "2026-08-12T08:00:01.500Z";
    expect(feedLastFetchSortValue(d)).toBe(new Date(d).getTime());
  });

  test("accepts Date objects, not just ISO strings", () => {
    const d = new Date("2026-08-12T08:00:05Z");
    expect(feedLastFetchSortValue(d)).toBe(d.getTime());
  });

  test("sorts a never-fetched feed as the oldest, not zero/NaN", () => {
    expect(feedLastFetchSortValue(null)).toBe(Number.NEGATIVE_INFINITY);
  });

  test("a never-fetched feed sorts before any real timestamp", () => {
    const never = feedLastFetchSortValue(null);
    const fetched = feedLastFetchSortValue("2026-08-12T08:00:00Z");
    expect(never).toBeLessThan(fetched);
  });
});
