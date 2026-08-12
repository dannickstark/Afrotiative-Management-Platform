// lib/studio/templates-view-pref.ts — Chantier A, Tâche 5 (spec §4) : la préférence grille⇄tableau
// de la liste des gabarits (/studio). Même idiome PUR que lib/studio/editor-prefs.ts (aucun accès à
// `window`/`localStorage` ici — voir hooks/use-templates-view.ts pour le pont navigateur) : ce
// module doit rester testable sans DOM.
//
// Par défaut GRILLE (brief Tâche 5 : « a grid⇄table toggle defaulting to grid ») — la table restait
// le SEUL rendu possible avant cette tâche (components/studio/templates-table.tsx), donc un
// utilisateur qui n'a ENCORE jamais choisi voit désormais la galerie visuelle, pas le texte-tableur
// d'hier.
export type TemplatesView = "grid" | "table";

export const DEFAULT_TEMPLATES_VIEW: TemplatesView = "grid";

function isTemplatesView(value: unknown): value is TemplatesView {
  return value === "grid" || value === "table";
}

// Ne lève JAMAIS — même discipline que parsePrefs (editor-prefs.ts) : `null`/vide/JSON invalide/une
// valeur qui n'est ni "grid" ni "table" retombent tous sur DEFAULT_TEMPLATES_VIEW plutôt que de
// faire planter la page ou de coincer l'utilisateur sur un état halte.
export function parseTemplatesView(raw: string | null): TemplatesView {
  if (raw === null || raw === "") return DEFAULT_TEMPLATES_VIEW;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_TEMPLATES_VIEW;
  }
  return isTemplatesView(parsed) ? parsed : DEFAULT_TEMPLATES_VIEW;
}

export function serializeTemplatesView(view: TemplatesView): string {
  return JSON.stringify(view);
}
