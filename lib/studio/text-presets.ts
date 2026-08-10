// lib/studio/text-presets.ts — Tâche 3 (U1, spec §3/§4) : les trois préréglages typographiques
// affichés dans la section « Styles » du panneau Texte, et réutilisés par « Texte dynamique »
// (dynamic-text.ts) pour styler un calque déjà lié à un jeton. UNE seule source de vérité pour
// taille/graisse : ni le panneau ni dynamic-text.ts ne redéfinissent ces chiffres localement.
export type TextPresetId = "titre" | "sous_titre" | "corps";

export const TEXT_PRESETS: Record<TextPresetId, { label: string; size: number; weight: number }> = {
  titre: { label: "Titre", size: 64, weight: 700 },
  sous_titre: { label: "Sous-titre", size: 40, weight: 600 },
  corps: { label: "Corps", size: 28, weight: 400 },
};

export const TEXT_PRESET_IDS = Object.keys(TEXT_PRESETS) as TextPresetId[];
