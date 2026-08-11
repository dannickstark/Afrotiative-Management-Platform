// lib/studio/text-presets.ts — Tâche 3 (U1, spec §3/§4) : les trois préréglages typographiques
// affichés dans la section « Styles » du panneau Texte, et réutilisés par « Texte dynamique »
// (dynamic-text.ts) pour styler un calque déjà lié à un jeton. UNE seule source de vérité pour
// taille/graisse : ni le panneau ni dynamic-text.ts ne redéfinissent ces chiffres localement.
import { textFrameFor } from "./layer-geometry";
import type { TextLayer } from "./scene";

export type TextPresetId = "titre" | "sous_titre" | "corps";

export const TEXT_PRESETS: Record<TextPresetId, { label: string; size: number; weight: number }> = {
  titre: { label: "Titre", size: 64, weight: 700 },
  sous_titre: { label: "Sous-titre", size: 40, weight: 600 },
  corps: { label: "Corps", size: 28, weight: 400 },
};

export const TEXT_PRESET_IDS = Object.keys(TEXT_PRESETS) as TextPresetId[];

// Correctif revue finale — Important 4 : « Styles » rendait ses trois lignes comme de simples
// `<li>`, avec le même bord/rayon/padding que les quatorze lignes VRAIMENT cliquables de « Texte
// dynamique » juste en dessous — visuellement indiscernables d'un contrôle, sans en être un. PURE —
// le calque qu'un clic sur une ligne « Styles » insère : un TextLayer NORMAL, SANS jeton (à la
// différence de dynamic-text.ts#buildDynamicTextLayer, qui LIE le contenu à un jeton) — le contenu
// par défaut reprend le libellé du préréglage, un point de départ visible et éditable plutôt qu'une
// chaîne vide qu'un designer ne verrait pas atterrir sur le canevas. Réutilise `textFrameFor`
// (lib/studio/layer-geometry.ts) — la MÊME formule de cadrage que « Texte dynamique », plutôt que
// d'en écrire une seconde géométrie pour un troisième chemin d'insertion.
export function buildPresetTextLayer(id: TextPresetId, canvas: { width: number; height: number }): TextLayer {
  const preset = TEXT_PRESETS[id];
  return {
    id: crypto.randomUUID(),
    name: preset.label,
    visible: true,
    locked: false,
    frame: textFrameFor(canvas, preset.size),
    type: "text",
    content: preset.label,
    font: { family: "Noto Sans", size: preset.size, weight: preset.weight },
    color: "#FFFFFF",
    align: "left",
    vAlign: "top",
    lineHeight: 1.2,
  };
}
