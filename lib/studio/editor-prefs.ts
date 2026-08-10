// lib/studio/editor-prefs.ts — Tâche 1 (U1, spec §3) : préférences d'éditeur, PURES. Aucun accès à
// `window`/`localStorage` ici (voir hooks/use-editor-prefs.ts pour le pont navigateur) et aucun
// import React — ce module doit rester testable sans DOM ni base de données.

export type RailCategory = "modeles" | "elements" | "texte" | "images" | "marque" | "calques";

export const RAIL_CATEGORIES: readonly RailCategory[] = [
  "modeles", "elements", "texte", "images", "marque", "calques",
];

export const RAIL_LABELS: Record<RailCategory, string> = {
  modeles: "Modèles",
  elements: "Éléments",
  texte: "Texte",
  images: "Images",
  marque: "Marque",
  calques: "Calques",
};

export type EditorPrefs = {
  openPanel: RailCategory | null; // null = collapsed
  rulers: boolean; // default false
  grid: boolean; // default false
  safeAreas: boolean; // default true
  zoom: number | "fit"; // default "fit"
  sectionsOpen: Record<string, boolean>; // key: `${layerType}.${sectionId}`
};

export const DEFAULT_PREFS: EditorPrefs = {
  openPanel: null,
  rulers: false,
  grid: false,
  safeAreas: true,
  zoom: "fit",
  sectionsOpen: {},
};

const RAIL_CATEGORY_SET = new Set<string>(RAIL_CATEGORIES);

function isRailCategory(value: unknown): value is RailCategory {
  return typeof value === "string" && RAIL_CATEGORY_SET.has(value);
}

// Chaque parseur de champ retombe sur LE DÉFAUT DE CE CHAMP quand la valeur est absente ou du
// mauvais type — jamais sur `DEFAULT_PREFS` en bloc, sans quoi un objet par ailleurs valide avec
// un seul champ corrompu perdrait aussi ses autres champs valides.
function parseOpenPanel(value: unknown): RailCategory | null {
  if (value === null) return null;
  return isRailCategory(value) ? value : DEFAULT_PREFS.openPanel;
}

function parseBooleanField(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseZoom(value: unknown): number | "fit" {
  if (value === "fit") return "fit";
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return DEFAULT_PREFS.zoom;
}

function parseSectionsOpen(value: unknown): Record<string, boolean> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "boolean") out[key] = entry;
  }
  return out;
}

// Ne lève JAMAIS : une entrée `null`, vide, du JSON syntaxiquement invalide, un tableau ou un objet
// dont chaque champ est du mauvais type retombent tous sur DEFAULT_PREFS (en bloc pour les deux
// premiers cas, champ par champ pour le dernier — les deux convergent vers le même résultat quand
// l'objet source ne contient qu'un seul champ, valide ou non).
export function parsePrefs(raw: string | null): EditorPrefs {
  if (raw === null || raw === "") return DEFAULT_PREFS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFS;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return DEFAULT_PREFS;
  }

  const obj = parsed as Record<string, unknown>;
  return {
    openPanel: parseOpenPanel(obj.openPanel),
    rulers: parseBooleanField(obj.rulers, DEFAULT_PREFS.rulers),
    grid: parseBooleanField(obj.grid, DEFAULT_PREFS.grid),
    safeAreas: parseBooleanField(obj.safeAreas, DEFAULT_PREFS.safeAreas),
    zoom: parseZoom(obj.zoom),
    sectionsOpen: parseSectionsOpen(obj.sectionsOpen),
  };
}

export function serializePrefs(p: EditorPrefs): string {
  return JSON.stringify(p);
}

// La sémantique de sélection du rail (spec §9) : cliquer une catégorie FERMÉE l'ouvre ; cliquer une
// catégorie DIFFÉRENTE de celle déjà ouverte bascule sans jamais repasser par l'état replié ; cliquer
// la catégorie DÉJÀ OUVERTE la referme. `panel-host.tsx` réutilise cette même fonction pour le
// chevron de bord en lui passant deux fois la catégorie ouverte (nextOpenPanel(open, open) vaut donc
// toujours `null`), plutôt que de dupliquer la règle de fermeture ailleurs.
export function nextOpenPanel(current: RailCategory | null, clicked: RailCategory): RailCategory | null {
  return current === clicked ? null : clicked;
}
