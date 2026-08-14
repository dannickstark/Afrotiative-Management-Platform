import { describe, expect, test } from "bun:test";
import { scopeLabel, templateUpdatedAtSortValue } from "@/components/studio/templates-columns";

// B8: the templates list-view DataTable (templates-table.tsx) renders this combined "Portée" cell
// — moved verbatim (same fallback/join logic) from the old hand-rolled per-context table row. Two
// optional inputs (channel, categoryName) plus a French join and a "Défaut" fallback when neither
// restricts the template: non-trivial enough to extract and test on its own, unlike the other new
// cells in templates-columns.tsx, which either pass an accessor straight through or reuse existing
// tested helpers from components/studio/templates-shared.tsx (CONTEXT_LABEL/formatLabel/
// dateFormatter/StateBadge).
describe("scopeLabel", () => {
  test("channel and category both set: joined with a middle dot", () => {
    expect(scopeLabel({ channel: "instagram", categoryName: "Actualités" })).toBe("Instagram · Actualités");
  });

  test("channel only: no dot, just the channel label", () => {
    expect(scopeLabel({ channel: "facebook", categoryName: null })).toBe("Facebook");
  });

  test("category only: no dot, just the category name", () => {
    expect(scopeLabel({ channel: null, categoryName: "Sport" })).toBe("Sport");
  });

  test("neither set: falls back to Défaut", () => {
    expect(scopeLabel({ channel: null, categoryName: null })).toBe("Défaut");
  });

  test("an unknown channel value (e.g. a synthetic test channel) renders as-is, not swallowed", () => {
    expect(scopeLabel({ channel: "test-some-channel", categoryName: null })).toBe("test-some-channel");
  });
});

// B8: the "Modifié" column sorts numerically off this pure ms accessor while the cell still
// DISPLAYS templates-shared.tsx's existing dateFormatter, unchanged from the old table. Minimal
// test per the TDD note — TemplateRow.updatedAt (lib/queries/studio.ts) is never null, so there's
// no absent-value case to cover here, unlike feedLastFetchSortValue/runDurationMs.
describe("templateUpdatedAtSortValue", () => {
  test("returns the timestamp in ms", () => {
    const d = "2026-08-12T08:00:01.500Z";
    expect(templateUpdatedAtSortValue(d)).toBe(new Date(d).getTime());
  });

  test("accepts Date objects, not just ISO strings", () => {
    const d = new Date("2026-08-12T08:00:05Z");
    expect(templateUpdatedAtSortValue(d)).toBe(d.getTime());
  });
});
