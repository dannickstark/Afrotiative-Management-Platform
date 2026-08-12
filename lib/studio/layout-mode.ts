// lib/studio/layout-mode.ts — Chantier A Tâche 4 (spec §2/§9) : responsive — la coque de l'éditeur
// (components/studio/editor-shell.tsx) doit RESTER utilisable sous 1280px sans jamais écraser le
// canevas ni faire chevaucher la barre supérieure (l'audit relève une collision à 1024px entre la
// barre d'outils et les pastilles flottantes de CanvasChrome). PURE — aucun accès à `window` ici (voir
// hooks/use-editor-layout.ts pour le pont navigateur, même découpage que lib/studio/editor-prefs.ts
// / hooks/use-editor-prefs.ts) : ce module doit rester testable sans DOM ni ResizeObserver.
//
// Quatre paliers, PAS trois : au-delà d'« éditeur complet » vs « replié », l'audit distingue
// spécifiquement la largeur où SEUL l'inspecteur manque de place (1024–1279 : rail + panneau accosté
// + canevas tiennent encore côte à côte) de celle où plus RIEN ne tient en colonnes (768–1023 : même
// le panneau accosté doit devenir un tiroir) — d'où `inspector-drawer` séparé d'`all-drawers` plutôt
// qu'un seul palier « compact ».
export type EditorLayoutMode = "full" | "inspector-drawer" | "all-drawers" | "too-small";

// Bornes EXACTES (brief Tâche 4) : `>=1280` → `full` ; `1024..1279` → `inspector-drawer` ;
// `768..1023` → `all-drawers` ; `<768` → `too-small`. Comparaisons en cascade du plus large au plus
// étroit — chaque `if` ne teste QUE sa propre borne basse, la borne haute de chaque palier est
// implicitement la borne basse du palier précédent (`1279` n'apparaît nulle part dans ce code : c'est
// `< 1280`, exactement équivalent et sans risque de désaccord entre une borne haute écrite à la main
// et la borne basse du palier suivant).
export function editorLayoutMode(width: number): EditorLayoutMode {
  if (width >= 1280) return "full";
  if (width >= 1024) return "inspector-drawer";
  if (width >= 768) return "all-drawers";
  return "too-small";
}
