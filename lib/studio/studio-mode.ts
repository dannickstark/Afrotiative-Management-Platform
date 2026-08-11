// lib/studio/studio-mode.ts — Tâche 5 (U1, spec §5) : les DEUX modes de l'éditeur — « Montage » (le
// rail + panneau accosté + canevas + colonne propriétés des Tâches 1-4) et « Rendu réel » (le rendu
// prend tout l'espace, voir components/studio/render-mode.tsx). PUR : aucun accès à `window`/DOM ni
// import React ici — même discipline que lib/studio/editor-prefs.ts (Tâche 1).
//
// Deux familles de fonctions cohabitent dans ce fichier :
//   1. StudioMode / toggleMode / PreservedView / preserveView — le VOCABULAIRE partagé entre
//      components/studio/mode-switch.tsx et components/studio/render-mode.tsx.
//   2. isModeToggleShortcut — le PRÉDICAT du raccourci clavier « R » (spec §5), extrait en fonction
//      pure plutôt que codé en dur dans un `useEffect` comme la Tâche 1 l'avait fait pour ⌘/ (voir
//      le correctif documenté dans editor-shell.tsx:COLLAPSE_PANEL_KEY et le rapport de la Tâche 1 :
//      la revue avait relevé que ce prédicat ne dépend d'AUCUNE API DOM réelle — seulement de
//      quelques champs primitifs d'un événement clavier — et qu'il pouvait donc être testé avec de
//      simples littéraux d'objet, sans harnais DOM).

export type StudioMode = "montage" | "rendu";

export function toggleMode(m: StudioMode): StudioMode {
  return m === "montage" ? "rendu" : "montage";
}

// ─────────────────────────────────────────────────────────────────────────────
// PreservedView — l'état de « vue » qui doit survivre un aller-retour de mode (spec §5 : « Selection,
// zoom et scroll survivent à l'aller-retour dans les deux sens »). Une SEULE forme partagée entre les
// deux modes plutôt que deux états parallèles qui pourraient diverger :
//   - en Montage, ces trois champs n'ont PAS encore de porteur dans l'UI (le canevas est aujourd'hui
//     toujours mis à l'échelle automatiquement, Tâche 9 ; la sélection de calque vit dans le
//     réducteur de l'éditeur, lib/studio/editor-state.ts, et survit DÉJÀ au changement de mode par
//     construction — ce n'est PAS ce que ce type porte) ;
//   - en Rendu réel (components/studio/render-mode.tsx), `selectedId` porte le FORMAT actuellement
//     promu dans la grande case (un FormatKey, ou `null` pour « le format natif du gabarit »),
//     `zoom`/`scrollX`/`scrollY` portent le niveau de zoom (« fit » ou une fraction jusqu'à 1 = 100 %,
//     spec §5 : « zoomable à 100 % ») et le défilement de la case large.
//
// `preserveView` est l'IDENTITÉ, par contrat (voir l'interface de la Tâche : « identity by contract —
// the test below is what makes it load-bearing »). Ce n'est PAS un oubli : il n'y a rien à
// transformer entre les deux modes, puisque c'est la MÊME forme des deux côtés — la fonction existe
// comme point de couture explicite et NOMMÉ à la frontière du changement de mode (appelée par
// EditorShellInner au moment du bascule, components/studio/editor-shell.tsx), plutôt que de copier
// silencieusement l'état d'un côté à l'autre sans qu'aucun symbole ne documente cette garantie. Un
// futur correctif (ex. re-clamper le zoom si les bornes changent) n'aurait qu'un seul endroit à
// modifier.
//
// AVERTISSEMENT DE REVUE (auto-relecture, Tâche 5) : un test qui se contenterait de
// `expect(preserveView(preserveView(v))).toEqual(v)` passerait trivialement pour `x => x` — il ne
// prouverait RIEN de spécifique à cette fonction. Voir tests/studio-mode.test.ts pour le test
// corrigé (une comparaison CHAMP PAR CHAMP contre un `v` aux valeurs distinctes, qui détecterait un
// sabotage qui oublierait un champ, ex. réinitialiser `scrollY` à 0) — et le rapport de la Tâche 5
// pour la discussion complète : la partie PURE est bel et bien triviale ; la propriété RÉELLE (« la
// sélection de calque et le format promu survivent vraiment à l'aller-retour ») est démontrée au
// niveau du COMPOSANT (EditorShellInner ne démonte JAMAIS son état de vue au changement de mode —
// `mode` ne pilote qu'un rendu conditionnel, jamais une `key` qui remonterait quoi que ce soit).
export type PreservedView = {
  selectedId: string | null;
  zoom: number | "fit";
  scrollX: number;
  scrollY: number;
};

export function preserveView(v: PreservedView): PreservedView {
  return { selectedId: v.selectedId, zoom: v.zoom, scrollX: v.scrollX, scrollY: v.scrollY };
}

// ─────────────────────────────────────────────────────────────────────────────
// isModeToggleShortcut — prédicat PUR du raccourci « R » (spec §5). Ne prend que des primitifs (un
// littéral d'objet reproduisant les seuls champs de KeyboardEvent dont on a besoin), jamais un vrai
// KeyboardEvent — c'est ce qui le rend testable avec de simples littéraux, sans jsdom (cette suite
// n'a pas de harnais DOM). Le composant (mode-switch.tsx) ne fait que traduire l'événement RÉEL du
// navigateur en ce littéral avant de lui poser la question ; toute la DÉCISION vit ici.
//
// Règles (chacune vérifiée par un cas dédié, tests/studio-mode.test.ts) :
//   - seule la lettre « r » (ou « R », la casse du Shift ne doit pas changer le sens du raccourci) ;
//   - JAMAIS avec un modificateur (Cmd/Ctrl/Alt) : sinon Cmd+R (recharger la page, un raccourci
//     navigateur bien plus important) serait intercepté ;
//   - JAMAIS quand le focus est dans un champ de saisie — un <input>, un <textarea> (le contenu d'un
//     calque texte s'édite dans un <Textarea>, components/studio/property-panel.tsx) ou un élément
//     `contentEditable` — sans quoi taper « r » dans le texte d'un calque basculerait le mode au lieu
//     d'insérer la lettre (le défaut exact que la Tâche 1 avait laissé passer pour ⌘/, où le risque
//     de collision avec la frappe était moindre car « / » seul ne fait rien sans modificateur).
export interface ModeShortcutTarget {
  tagName: string;
  isContentEditable?: boolean;
}

export interface ModeShortcutEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  target: ModeShortcutTarget | null;
}

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function isModeToggleShortcut(e: ModeShortcutEvent): boolean {
  if (e.key.toLowerCase() !== "r") return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const tagName = e.target?.tagName?.toUpperCase() ?? "";
  if (TYPING_TAGS.has(tagName)) return false;
  if (e.target?.isContentEditable) return false;
  return true;
}
