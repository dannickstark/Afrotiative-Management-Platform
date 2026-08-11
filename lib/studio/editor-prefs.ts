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
  // Correctif revue finale — Important 1 : le panneau que ⌘/ doit RÉOUVRIR quand `openPanel` est
  // `null` (toggleCollapse, plus bas). Sans ce champ, une fermeture perdait la trace de "quel
  // panneau" et ⌘/ ne pouvait que replier, jamais réafficher — un aller SANS retour, contraire à
  // spec §3/§9 (« ⌘/ toggles »). Default "calques" : le premier panneau historique du rail (Tâche 1),
  // un choix aussi raisonnable qu'un autre pour un utilisateur qui n'a encore jamais rien ouvert ni
  // replié.
  lastOpenPanel: RailCategory;
  rulers: boolean; // default false
  grid: boolean; // default false
  safeAreas: boolean; // default true
  zoom: number | "fit"; // default "fit"
  sectionsOpen: Record<string, boolean>; // key: `${layerType}.${sectionId}`
  // Tâche 4 (U1, spec §3) : ids de lib/studio/shape-gallery.ts#ShapeTile récemment insérés depuis le
  // panneau Éléments, LA PLUS RÉCENTE EN TÊTE. Ce module reste ignorant du catalogue de tuiles lui-
  // même (aucun import de shape-gallery.ts ici, pour ne pas faire dépendre ce module PUR et générique
  // d'un autre module métier) : il ne fait que transporter et valider la FORME (un tableau de
  // chaînes), tandis que shape-gallery.ts#recentTilesFor résout ces ids en tuiles réelles et ignore
  // ceux qui ne correspondent plus à rien.
  recentShapes: string[];
};

export const DEFAULT_PREFS: EditorPrefs = {
  openPanel: null,
  lastOpenPanel: "calques",
  rulers: false,
  grid: false,
  safeAreas: true,
  zoom: "fit",
  sectionsOpen: {},
  recentShapes: [],
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

// Même discipline « par champ » que parseOpenPanel ci-dessus — mais SANS le cas `null` : contrairement
// à `openPanel`, `null` n'a jamais été une valeur légale de `lastOpenPanel` (c'est justement le champ
// qui garantit qu'on retombe TOUJOURS sur UNE catégorie concrète, jamais sur « rien »).
function parseLastOpenPanel(value: unknown): RailCategory {
  return isRailCategory(value) ? value : DEFAULT_PREFS.lastOpenPanel;
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

// Pas un `[]` du tout, ou un tableau dont certaines entrées ne sont pas des chaînes (corruption
// partielle) -> les entrées non-chaînes sont filtrées plutôt que de faire tomber tout le champ,
// même discipline « par champ, jamais en bloc » que le reste de ce module ; une valeur qui n'est
// même pas un tableau retombe sur le défaut du champ ([]).
function parseRecentShapes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
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
    lastOpenPanel: parseLastOpenPanel(obj.lastOpenPanel),
    rulers: parseBooleanField(obj.rulers, DEFAULT_PREFS.rulers),
    grid: parseBooleanField(obj.grid, DEFAULT_PREFS.grid),
    safeAreas: parseBooleanField(obj.safeAreas, DEFAULT_PREFS.safeAreas),
    zoom: parseZoom(obj.zoom),
    sectionsOpen: parseSectionsOpen(obj.sectionsOpen),
    recentShapes: parseRecentShapes(obj.recentShapes),
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

// Correctif revue finale (Minor, second passage) — Close 1 : la portée « limitée à ⌘/ » ci-dessous
// décrite pour la première version de `toggleCollapse` était TROP étroite en pratique : `lastOpenPanel`
// n'était écrit QUE par `toggleCollapse`, donc un panneau ouvert par le rail puis fermé par le RAIL
// (re-clic sur la même catégorie) ou par le CHEVRON de panel-host.tsx laissait `lastOpenPanel`
// périmé — scénario concret signalé en revue : ouvrir Images depuis le rail, le replier au chevron,
// presser ⌘/ -> restaurait Calques (le défaut), pas Images. `setOpenPanel` est désormais LE seul
// point d'écriture de `openPanel`, quel que soit le geste : il mémorise `lastOpenPanel` à CHAQUE
// fermeture RÉELLE (une transition non-null -> null), jamais à l'ouverture ni quand rien n'était
// ouvert pour commencer (rien à mémoriser). `nextOpenPanel` (la règle rail/chevron : cliquer la
// catégorie déjà ouverte la referme) reste la fonction qui décide QUEL `next` passer — celle-ci
// décide seulement CE QUI ACCOMPAGNE un `next` donné.
export function setOpenPanel(prefs: EditorPrefs, next: RailCategory | null): EditorPrefs {
  if (next === null && prefs.openPanel !== null) {
    return { ...prefs, openPanel: null, lastOpenPanel: prefs.openPanel };
  }
  return { ...prefs, openPanel: next };
}

// ⌘/ (spec §3/§9) : un VRAI aller-retour, plutôt que l'ancien `nextOpenPanel(p.openPanel,
// p.openPanel)` sous garde (toujours `null`, et un no-op une fois déjà replié — aucune pression
// suivante ne pouvait rien rouvrir). DÉCISION extraite en fonction PURE (comme demandé par la revue :
// « this sub-project's reviews have twice faulted inline predicates that were pure all along ») :
//   - un panneau est ouvert -> le replier via `setOpenPanel` (qui mémorise lequel) ;
//   - aucun panneau n'est ouvert -> réafficher `lastOpenPanel`, celui mémorisé par la DERNIÈRE
//     fermeture réelle — quel qu'en ait été le geste (rail, chevron ou ⌘/ lui-même), puisque les
//     trois passent maintenant par `setOpenPanel`.
export function toggleCollapse(prefs: EditorPrefs): EditorPrefs {
  return prefs.openPanel ? setOpenPanel(prefs, null) : setOpenPanel(prefs, prefs.lastOpenPanel);
}

// Correctif revue finale — amendement de spec §3 (« This is what a newly created template opens
// onto ») fait par le produit : DEFAULT_PREFS.openPanel reste `null` (le plan de la Tâche 1 a raison
// de ne forcer AUCUN panneau pour un gabarit ordinaire), mais un gabarit dont la scène ne porte
// ENCORE AUCUN calque — un gabarit tout juste créé — doit ouvrir sur Modèles, pour que « dupliquer un
// gabarit existant » (spec §3, colonne Sections de Modèles) reste découvrable sans devoir déjà
// connaître le rail. PURE — hooks/use-editor-prefs.ts l'applique une fois, juste après avoir résolu
// les préférences persistées (par défaut ou depuis localStorage), au montage de CHAQUE gabarit (ce
// hook est ré-instancié à chaque navigation vers un gabarit différent, donc `hasLayers` y est
// réellement réévalué par gabarit, pas une seule fois par navigateur comme `defaultSafeAreas`).
//
// Ne bouscule JAMAIS un panneau déjà ouvert (« without forcing the panel on returning users », la
// ruling) : si les préférences persistées portent déjà une catégorie (l'utilisateur en a
// délibérément laissé une ouverte, y compris sur un AUTRE gabarit — ces préférences sont partagées
// par navigateur, pas par gabarit), ce panneau reste affiché tel quel plutôt que d'être remplacé par
// Modèles.
export function openModelesIfEmpty(prefs: EditorPrefs, hasLayers: boolean): EditorPrefs {
  if (hasLayers || prefs.openPanel !== null) return prefs;
  return { ...prefs, openPanel: "modeles" };
}
