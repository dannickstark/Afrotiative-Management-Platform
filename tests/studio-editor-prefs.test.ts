import { describe, expect, it } from "bun:test";
import { parsePrefs, serializePrefs, DEFAULT_PREFS, RAIL_CATEGORIES, RAIL_LABELS } from "@/lib/studio/editor-prefs";

describe("editor prefs — pure, never throws", () => {
  it("returns defaults for null, empty, corrupt JSON and wrong-shaped JSON", () => {
    for (const raw of [null, "", "{", "[]", '{"openPanel":42}', '{"zoom":"enormous"}']) {
      expect(parsePrefs(raw)).toEqual(DEFAULT_PREFS);
    }
  });

  it("round-trips a full prefs object", () => {
    const p = { openPanel: "texte" as const, rulers: true, grid: true, safeAreas: false, zoom: 0.5, sectionsOpen: { "text.ombre": false } };
    expect(parsePrefs(serializePrefs(p))).toEqual(p);
  });

  it("defaults: no panel forced open, rulers and grid OFF, safe areas ON, zoom fit", () => {
    expect(DEFAULT_PREFS.rulers).toBe(false);
    expect(DEFAULT_PREFS.grid).toBe(false);
    expect(DEFAULT_PREFS.safeAreas).toBe(true);
    expect(DEFAULT_PREFS.zoom).toBe("fit");
  });

  it("keeps an unknown sectionsOpen key rather than dropping it", () => {
    // a section id added by a later task must survive a round trip through an older client
    const p = { ...DEFAULT_PREFS, sectionsOpen: { "shape.forme": false } };
    expect(parsePrefs(serializePrefs(p)).sectionsOpen["shape.forme"]).toBe(false);
  });

  it("every rail category has a French label", () => {
    for (const c of RAIL_CATEGORIES) {
      expect(RAIL_LABELS[c]).toBeTruthy();
      expect(RAIL_LABELS[c]).not.toMatch(/^[a-z_]+$/); // not the raw key
    }
  });
});
