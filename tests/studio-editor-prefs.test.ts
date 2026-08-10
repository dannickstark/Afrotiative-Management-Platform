import { describe, expect, it } from "bun:test";
import { parsePrefs, serializePrefs, DEFAULT_PREFS, RAIL_CATEGORIES, RAIL_LABELS } from "@/lib/studio/editor-prefs";

describe("editor prefs — pure, never throws", () => {
  it("returns defaults for null, empty, corrupt JSON and wrong-shaped JSON", () => {
    for (const raw of [null, "", "{", "[]", '{"openPanel":42}', '{"zoom":"enormous"}', '{"recentShapes":"rect"}', '{"recentShapes":42}']) {
      expect(parsePrefs(raw)).toEqual(DEFAULT_PREFS);
    }
  });

  it("round-trips a full prefs object", () => {
    const p = {
      openPanel: "texte" as const, rulers: true, grid: true, safeAreas: false, zoom: 0.5,
      sectionsOpen: { "text.ombre": false }, recentShapes: ["qr", "rect"],
    };
    expect(parsePrefs(serializePrefs(p))).toEqual(p);
  });

  it("a corrupt recentShapes falls back to [] rather than throwing, and filters non-string entries", () => {
    // Tâche 4 (U1, spec §3) : même discipline « par champ » que sectionsOpen — une valeur qui n'est
    // pas un tableau retombe sur le défaut du champ ([]) ; un tableau dont certaines entrées ne sont
    // pas des chaînes garde les entrées valides plutôt que de faire tomber tout le champ.
    expect(parsePrefs('{"recentShapes":"nope"}').recentShapes).toEqual([]);
    expect(parsePrefs('{"recentShapes":null}').recentShapes).toEqual([]);
    expect(parsePrefs('{"recentShapes":{"a":1}}').recentShapes).toEqual([]);
    expect(parsePrefs('{"recentShapes":["rect",42,null,"qr"]}').recentShapes).toEqual(["rect", "qr"]);
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
