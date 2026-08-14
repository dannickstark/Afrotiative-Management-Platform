import { describe, expect, test } from "bun:test";
import { taxonomyWpIdSortValue } from "@/components/settings/taxonomy-columns";

// B7: the taxonomy DataTable (both the "Catégories" and "Tags" instances, taxonomy-tables.tsx)
// sorts its "ID WordPress" column off this pure numeric accessor (the cell itself still DISPLAYS
// the raw wpId, or "—" when absent, unchanged from the old hand-rolled table). wp_categories.wp_id
// / wp_tags.wp_id are nullable integer columns (db/schema.ts) — a row synced before WordPress
// assigned it an id (or never synced) has no real wpId yet; sort it to Number.NEGATIVE_INFINITY so
// it consistently groups at the "lowest" end regardless of sort direction, mirroring
// feedLastFetchSortValue's (components/settings/feeds-columns.tsx) treatment of a never-fetched
// feed's null timestamp.
describe("taxonomyWpIdSortValue", () => {
  test("returns the wpId as-is when present", () => {
    expect(taxonomyWpIdSortValue(42)).toBe(42);
  });

  test("returns zero as-is (falsy but not absent)", () => {
    expect(taxonomyWpIdSortValue(0)).toBe(0);
  });

  test("sorts a row with no wpId as the lowest, not zero/NaN", () => {
    expect(taxonomyWpIdSortValue(null)).toBe(Number.NEGATIVE_INFINITY);
  });

  test("a row with no wpId sorts before any real wpId, including zero", () => {
    const missing = taxonomyWpIdSortValue(null);
    expect(missing).toBeLessThan(taxonomyWpIdSortValue(0));
  });
});
