// lib/studio/keymap.ts — Chantier B, Tâche 1 : le KEYMAP CENTRAL de l'éditeur, en PURE.
//
// Un module FEUILLE (aucun import de valeur — voir align.ts pour le même motif) : `resolveShortcut`
// ne prend que des primitifs (un littéral reproduisant les seuls champs de KeyboardEvent dont on a
// besoin, comme `isModeToggleShortcut` de studio-mode.ts avant lui) et renvoie un `EditorCommand |
// null`, jamais un effet. Toute la DÉCISION « quelle touche fait quoi » vit ici ; le câblage réel
// (hooks/use-editor-keymap.ts) ne fait que traduire l'événement DOM réel en littéral avant de lui
// poser la question, puis traduire la commande obtenue en action du réducteur.
//
// EXTENSIBLE (le plan le demande) : `EditorCommand` est une union DISCRIMINÉE par `kind`, sur le
// modèle d'`EditorAction` (editor-state.ts) — les tâches suivantes du chantier B y ajouteront
// copier/coller/dupliquer/zoom/grouper sans toucher aux cas déjà câblés.
//
// ── LA GARDE DE FOCUS EST PORTEUSE (spec du brief) ─────────────────────────────────────────────────
// `ctx.isEditingText` coupe TOUT raccourci géré ici — pas seulement Suppr/flèches/⌘A, mais aussi
// ⌘Z/⌘⇧Z. Choix délibéré, documenté plutôt que laissé à deviner : un champ de saisie (le contenu d'un
// calque texte, un champ numérique du panneau de propriétés) a SA PROPRE pile d'annulation native du
// navigateur — la lui voler pour annuler un geste de l'éditeur pendant que l'utilisateur tape serait
// la même surprise que « taper R bascule le mode » que studio-mode.ts avait déjà tranchée pour un
// AUTRE raccourci. La garde est donc UNIFORME : aucune exception chord par chord, pour qu'un futur
// ajout à cette union n'ait pas à se souvenir laquelle des deux familles s'applique.
export type EditorCommand =
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "selectAll" }
  | { kind: "deselect" }
  | { kind: "delete" }
  | { kind: "nudge"; dx: number; dy: number };

export interface ShortcutEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

export interface ShortcutContext {
  /** Une sélection non vide — SUFFIT pour Suppr/flèches (le hook, lui, doit encore résoudre l'id
   * unique et son verrou avant de dispatcher : voir hooks/use-editor-keymap.ts). Sans sélection,
   * Suppr/flèches n'ont rien à faire — `resolveShortcut` renvoie `null` plutôt qu'une commande que le
   * hook devrait de toute façon ignorer, pour que « ce raccourci fait quelque chose » reste une
   * question tranchée ICI, pas dispersée entre ce module et son appelant. */
  hasSelection: boolean;
  isEditingText: boolean;
}

// Mêmes valeurs que `NUDGE_STEP`/`NUDGE_STEP_SHIFT` de hooks/use-layer-drag.ts#nudgeDelta —
// délibérément DUPLIQUÉES plutôt qu'importées : ce module reste une FEUILLE sans import de valeur
// (voir l'en-tête), et hooks/use-layer-drag.ts est un fichier "use client" qui tire React à son tour —
// l'importer ICI inverserait la direction de dépendance (lib/studio ne dépend jamais de hooks/).
// tests/studio-keymap.test.ts épingle l'accord des deux jeux de constantes.
const NUDGE_STEP = 1;
const NUDGE_STEP_SHIFT = 10;

function nudgeFor(key: string, shift: boolean): { dx: number; dy: number } | null {
  const step = shift ? NUDGE_STEP_SHIFT : NUDGE_STEP;
  switch (key) {
    case "ArrowLeft": return { dx: -step, dy: 0 };
    case "ArrowRight": return { dx: step, dy: 0 };
    case "ArrowUp": return { dx: 0, dy: -step };
    case "ArrowDown": return { dx: 0, dy: step };
    default: return null;
  }
}

// Le routeur central. Ordre des branches SANS conséquence sur le résultat (les chords sont
// mutuellement exclusifs — jamais deux `case` vrais pour le même événement), mais gardé lisible dans
// l'ordre où le brief les énumère.
export function resolveShortcut(e: ShortcutEvent, ctx: ShortcutContext): EditorCommand | null {
  if (ctx.isEditingText) return null; // la garde de focus — voir l'en-tête de module.

  const mod = e.metaKey === true || e.ctrlKey === true;
  const key = e.key;

  if (mod && key.toLowerCase() === "z") {
    return e.shiftKey ? { kind: "redo" } : { kind: "undo" };
  }
  if (mod && key.toLowerCase() === "a") {
    return { kind: "selectAll" };
  }
  if (!mod && key === "Escape") {
    return { kind: "deselect" };
  }
  if (!mod && (key === "Delete" || key === "Backspace")) {
    return ctx.hasSelection ? { kind: "delete" } : null;
  }
  if (!mod) {
    const nudge = nudgeFor(key, e.shiftKey === true);
    if (nudge) return ctx.hasSelection ? { kind: "nudge", ...nudge } : null;
  }
  return null;
}

// Le prédicat de garde lui-même — `EventTarget | null` (le type du VRAI `KeyboardEvent.target` du
// navigateur), jamais un DOM complet : duck-typé sur les deux seuls champs qui comptent, comme
// `ModeShortcutTarget` (studio-mode.ts) avant lui. `isContentEditable` reflète, par la plateforme
// elle-même, aussi bien l'élément que ses ANCÊTRES contenteditable — inutile de remonter l'arbre à la
// main ici.
const EDITING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function isEditingText(target: EventTarget | null): boolean {
  if (!target) return false;
  const el = target as unknown as { tagName?: string; isContentEditable?: boolean };
  const tagName = el.tagName?.toUpperCase() ?? "";
  if (EDITING_TAGS.has(tagName)) return true;
  return el.isContentEditable === true;
}
