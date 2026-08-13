// lib/studio/overlay-theme.ts — SOURCE UNIQUE des couleurs de surcouches du canevas (chrome, pas moteur).
// Cohérées à la marque éditoriale MAIS chaque rôle reste VISUELLEMENT DISTINCT (leçon d'usage U2/U4 :
// une sélection n'est pas un guide n'est pas une liaison n'est pas une zone sûre). Module pur, sans import.
export const OVERLAY = Object.freeze({
  selection: "#2f5fe0",        // bleu encre — reste FROID, distinct du chaud de la marque
  handleFill: "#ffffff",       // poignées : pastille blanche bordée `selection`
  snapGuide: "#d1472f",        // terracotta — rapproché de --accent-brand (guide = repère de marque)
  binding: "#7c3aed",          // violet — distinct des trois autres
  bindingLabelFg: "#ffffff",
  safeTint: "rgba(245,158,11,0.14)", // ambre translucide (zone sûre)
  safeLine: "1px dashed rgba(245,158,11,0.85)",
  safeLabelFg: "rgba(245,158,11,0.95)", // même ambre, opacité pleine pour le texte des étiquettes de bande
  lockedOutline: "#9ca3af",    // gris — bordure d'un calque VERROUILLÉ, distinct des 4 rôles actifs
                                // ci-dessus (sélection/poignée/guide/liaison) : un calque verrouillé
                                // n'est ni sélectionné ni en cours de manipulation, sa surcouche doit
                                // rester visuellement neutre.
});

export const SELECTION = OVERLAY.selection;
export const HANDLE_FILL = OVERLAY.handleFill;
export const SNAP_GUIDE = OVERLAY.snapGuide;
export const BINDING = OVERLAY.binding;
export const SAFE_TINT = OVERLAY.safeTint;
export const SAFE_LINE = OVERLAY.safeLine;
export const SAFE_LABEL_FG = OVERLAY.safeLabelFg;
export const LOCKED_OUTLINE = OVERLAY.lockedOutline;
