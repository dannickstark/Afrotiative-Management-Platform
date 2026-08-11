import { describe, expect, it } from "bun:test";
import {
  parsePrefs, serializePrefs, DEFAULT_PREFS, RAIL_CATEGORIES, RAIL_LABELS,
  toggleCollapse, openModelesIfEmpty,
} from "@/lib/studio/editor-prefs";

describe("editor prefs — pure, never throws", () => {
  it("returns defaults for null, empty, corrupt JSON and wrong-shaped JSON", () => {
    for (const raw of [
      null, "", "{", "[]", '{"openPanel":42}', '{"zoom":"enormous"}',
      '{"recentShapes":"rect"}', '{"recentShapes":42}', '{"lastOpenPanel":42}', '{"lastOpenPanel":"pas-une-categorie"}',
    ]) {
      expect(parsePrefs(raw)).toEqual(DEFAULT_PREFS);
    }
  });

  it("round-trips a full prefs object", () => {
    const p = {
      openPanel: "texte" as const, lastOpenPanel: "images" as const, rulers: true, grid: true, safeAreas: false,
      zoom: 0.5, sectionsOpen: { "text.ombre": false }, recentShapes: ["qr", "rect"],
    };
    expect(parsePrefs(serializePrefs(p))).toEqual(p);
  });

  // Correctif revue finale — Important 1 : `lastOpenPanel` suit la MÊME discipline « par champ,
  // jamais en bloc » que les autres champs (voir la docstring de parsePrefs) — une valeur corrompue
  // sur CE SEUL champ retombe sur son propre défaut ("calques"), sans faire tomber le reste d'un
  // objet par ailleurs valide.
  it("a corrupt lastOpenPanel falls back to its own default (\"calques\"), not to the whole DEFAULT_PREFS", () => {
    const raw = JSON.stringify({ openPanel: "texte", lastOpenPanel: "pas-une-categorie", rulers: true });
    const parsed = parsePrefs(raw);
    expect(parsed.lastOpenPanel).toBe("calques");
    expect(parsed.openPanel).toBe("texte"); // le reste de l'objet survit intact
    expect(parsed.rulers).toBe(true);
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

// Correctif revue finale — Important 1 : ⌘/ était un aller SANS retour (editor-shell.tsx appelait
// `nextOpenPanel(p.openPanel, p.openPanel)`, toujours `null`, sous un garde qui ne faisait déjà rien
// quand `openPanel` valait `null`). `toggleCollapse` est la décision extraite en fonction PURE — ce
// que la revue demande explicitement plutôt qu'un prédicat inline dans un `useEffect`.
describe("toggleCollapse — ⌘/ est un VRAI aller-retour (Important 1, revue finale)", () => {
  it("un panneau ouvert -> le replie (openPanel devient null) ET mémorise lequel dans lastOpenPanel", () => {
    const prefs = { ...DEFAULT_PREFS, openPanel: "texte" as const, lastOpenPanel: "calques" as const };
    const next = toggleCollapse(prefs);
    expect(next.openPanel).toBeNull();
    expect(next.lastOpenPanel).toBe("texte");
  });

  it("aucun panneau ouvert -> réaffiche lastOpenPanel", () => {
    const prefs = { ...DEFAULT_PREFS, openPanel: null, lastOpenPanel: "images" as const };
    const next = toggleCollapse(prefs);
    expect(next.openPanel).toBe("images");
  });

  it("round-trip complet : fermer PUIS rouvrir restaure EXACTEMENT le panneau initial — la propriété que la revue reprochait de ne jamais tester", () => {
    const opened = { ...DEFAULT_PREFS, openPanel: "marque" as const, lastOpenPanel: "calques" as const };
    const closed = toggleCollapse(opened);
    expect(closed.openPanel).toBeNull();
    const reopened = toggleCollapse(closed);
    expect(reopened.openPanel).toBe("marque");
  });

  it("ne touche à AUCUN autre champ des préférences", () => {
    const prefs = { ...DEFAULT_PREFS, openPanel: "elements" as const, rulers: true, grid: true, safeAreas: false, zoom: 0.5 as const };
    const next = toggleCollapse(prefs);
    expect(next.rulers).toBe(true);
    expect(next.grid).toBe(true);
    expect(next.safeAreas).toBe(false);
    expect(next.zoom).toBe(0.5);
  });
});

// Correctif revue finale — amendement de spec §3 fait par le produit : un gabarit sans AUCUN calque
// (tout juste créé) ouvre sur Modèles ; un gabarit ordinaire (déjà des calques) n'est jamais bousculé.
describe("openModelesIfEmpty — un gabarit sans calque ouvre sur Modèles, sans jamais bousculer un panneau déjà choisi (amendement spec §3)", () => {
  it("scène SANS calque, aucun panneau ouvert -> force l'ouverture de Modèles", () => {
    expect(openModelesIfEmpty(DEFAULT_PREFS, false).openPanel).toBe("modeles");
  });

  it("scène AVEC des calques -> ne force rien, openPanel reste tel quel (le défaut persistant null, spec §9)", () => {
    expect(openModelesIfEmpty(DEFAULT_PREFS, true)).toEqual(DEFAULT_PREFS);
  });

  it("scène SANS calque MAIS un panneau déjà ouvert (préférence d'un autre gabarit, persistée par navigateur) -> ne le remplace PAS par Modèles", () => {
    const prefs = { ...DEFAULT_PREFS, openPanel: "calques" as const };
    expect(openModelesIfEmpty(prefs, false)).toEqual(prefs);
  });

  it("ne touche à AUCUN autre champ quand elle ouvre Modèles", () => {
    const prefs = { ...DEFAULT_PREFS, rulers: true, zoom: 0.5 as const };
    const next = openModelesIfEmpty(prefs, false);
    expect(next.rulers).toBe(true);
    expect(next.zoom).toBe(0.5);
  });
});
