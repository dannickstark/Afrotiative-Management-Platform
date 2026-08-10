// lib/studio/dynamic-text.ts — Tâche 3 (U1, spec §4) : « Texte dynamique », PURE.
//
// Canva propose du contenu de stock ; ici on propose des JETONS. Ce module ne fait que DÉRIVER,
// pour un contexte de gabarit donné, la liste des lignes affichables dans la section « Texte
// dynamique » du panneau Texte — puis construire le calque texte qu'un clic sur une ligne insère.
//
// La légalité d'un jeton dans un contexte est déjà tranchée par tokens.ts (CONTEXT_TOKENS) : ce
// module se contente de LIRE cette carte pour griser une ligne, jamais de la redéfinir. C'est
// délibérément la même discipline que components/studio/token-picker.tsx (tokensFor) et
// components/studio/panels/images-panel.tsx (imageSlotsFor) — trois lectures indépendantes de la
// même carte plutôt que trois listes recopiées qui pourraient diverger.
//
// Portée U1 (spec §4, « ce que cette tâche NE fait PAS ») : U4 possède le sélecteur de jeton À
// L'INTÉRIEUR des champs de propriété, et fera un jour rapporter à parseScene la totalité des
// erreurs Zod plutôt que la première. Ici, on lit seulement CONTEXT_TOKENS pour griser une ligne —
// aucune des deux n'est touchée.
import { CONTEXT_TOKENS, TOKEN_IDS, TOKEN_KINDS, type TemplateContext, type TokenId } from "./tokens";
import { TEXT_PRESETS, type TextPresetId } from "./text-presets";
import type { TextLayer } from "./scene";

export type DynamicTextRow = {
  tokenId: string; // un TokenId réel de tokens.ts (ex. "article.title") — jamais une forme raccourcie
  label: string; // French, e.g. "Titre de l'article"
  preset: TextPresetId;
  available: boolean; // false when the token is illegal in this context
  reason?: string; // French, present iff !available
};

// Étiquette + préréglage propres à CETTE section (spec §4, tableau). Distincte de
// components/studio/token-picker.tsx (TOKEN_LABELS) : celle-là nomme un jeton pour n'importe quel
// champ de propriété («Extrait de l'article»), celle-ci nomme une LIGNE du panneau Texte, au
// vocabulaire du tableau §4 quand il en donne un (« Chapô », « Rubrique », « Signature », « Date »)
// — deux vocabulaires légitimement différents pour deux usages différents, pas une duplication à
// fusionner. Couvre la totalité des jetons de type "text" de TOKEN_KINDS : un jeton texte ajouté à
// tokens.ts sans entrée ici lève au chargement du module plutôt que d'afficher un {{jeton.brut}} en
// guise d'étiquette (voir la boucle de vérification juste après TEXT_TOKEN_IDS plus bas).
const DYNAMIC_TEXT_LABELS: Record<string, { label: string; preset: TextPresetId }> = {
  "article.title": { label: "Titre de l'article", preset: "titre" },
  "article.excerpt": { label: "Chapô", preset: "corps" },
  "article.date": { label: "Date", preset: "corps" },
  "article.byline": { label: "Signature", preset: "corps" },
  "category.name": { label: "Rubrique", preset: "sous_titre" },
  "source.names": { label: "Sources", preset: "corps" },
  "quote.text": { label: "Texte de la citation", preset: "titre" },
  "quote.attribution": { label: "Attribution de la citation", preset: "corps" },
  "edition.title": { label: "Titre de l'édition", preset: "titre" },
  "edition.date": { label: "Date de l'édition", preset: "corps" },
  "recap.title": { label: "Titre du récap", preset: "titre" },
  "recap.item1": { label: "Élément 1 du récap", preset: "corps" },
  "recap.item2": { label: "Élément 2 du récap", preset: "corps" },
  "recap.item3": { label: "Élément 3 du récap", preset: "corps" },
};

// Libellé français du contexte, pour la phrase de raison d'une ligne indisponible. Même liste que
// components/studio/templates-table.tsx / editor-shell.tsx / manual-generate.tsx (CONTEXT_LABEL) —
// dupliquée ici plutôt qu'importée pour la même raison que tokens.ts documente déjà pour
// CHANNEL_LABELS : ces trois fichiers sont "use client" et lourds (templates-table.tsx entraîne des
// Server Actions), alors que ce module doit rester un module PUR, importable depuis n'importe où
// sans traîner de dépendance côté client.
const CONTEXT_LABEL: Record<TemplateContext, string> = {
  article_image: "Image à la une",
  social_post: "Publication sociale",
  quote_card: "Carte citation",
  newsletter_header: "Bandeau newsletter",
  recap_card: "Carte récap",
};

// L'univers COMPLET des jetons de type "text", dans l'ordre de TOKEN_KINDS (tokens.ts) — un ordre
// stable, indépendant du contexte affiché. Lève au chargement si un jeton texte de tokens.ts n'a
// pas d'entrée ci-dessus : mieux vaut un crash immédiat et explicite au démarrage des tests qu'une
// ligne affichée sous sa forme technique brute en production.
const TEXT_TOKEN_IDS: TokenId[] = TOKEN_IDS.filter((id) => TOKEN_KINDS[id] === "text");
for (const id of TEXT_TOKEN_IDS) {
  if (!DYNAMIC_TEXT_LABELS[id]) {
    throw new Error(`dynamic-text.ts : jeton texte « ${id} » sans étiquette « Texte dynamique ».`);
  }
}

// PURE — la règle testée par tests/studio-dynamic-text.test.ts. Une ligne par jeton texte de
// l'univers COMPLET, jamais seulement ceux légaux ici : un jeton illégal dans ce contexte reste
// visible, gréé (spec §4 : « Tokens illegal in this template's context appear disabled with the
// reason »), plutôt que d'être simplement absent de la liste — c'est ce qui rend la contrainte
// DÉCOUVRABLE plutôt que silencieuse.
export function dynamicTextRowsFor(context: TemplateContext): DynamicTextRow[] {
  const legal = new Set<string>(CONTEXT_TOKENS[context]);
  return TEXT_TOKEN_IDS.map((tokenId) => {
    const meta = DYNAMIC_TEXT_LABELS[tokenId];
    const available = legal.has(tokenId);
    return {
      tokenId,
      label: meta.label,
      preset: meta.preset,
      available,
      reason: available
        ? undefined
        : `Indisponible pour ce type de gabarit (« ${CONTEXT_LABEL[context]} »).`,
    };
  });
}

// Marge horizontale/verticale relative au canevas, et nombre de lignes de hauteur allouées à la
// boîte — un calque texte reste redimensionnable ensuite depuis la bande de propriétés (spec §4 :
// « un designer peut le redimensionner... exactement comme aujourd'hui »), cette boîte n'a donc
// besoin que d'atterrir DANS le canevas, pas d'épouser exactement le texte final.
const MARGIN_RATIO = 0.08;
const LINE_ALLOWANCE = 2;

function frameFor(canvas: { width: number; height: number }, fontSize: number): TextLayer["frame"] {
  const desiredW = canvas.width * (1 - 2 * MARGIN_RATIO);
  const desiredH = fontSize * 1.2 * LINE_ALLOWANCE;
  // Bornée AUX dimensions du canevas d'abord (jamais plus grande que lui), puis centrée et reclampée
  // — garantit x/y >= 0 et x+w/y+h <= canevas quel que soit le format, y compris un format vertical
  // étroit (story 1080×1920) où une boîte pensée pour un format large déborderait sans ce clamp final.
  const w = Math.min(Math.max(desiredW, 1), canvas.width);
  const h = Math.min(Math.max(desiredH, 1), canvas.height);
  const x = Math.min(Math.max(Math.round((canvas.width - w) / 2), 0), canvas.width - w);
  const y = Math.min(Math.max(Math.round((canvas.height - h) / 2), 0), canvas.height - h);
  return { x, y, w, h };
}

// PURE — le calque qu'un clic sur une ligne DISPONIBLE insère : un TextLayer NORMAL, sans statut
// spécial, dont le seul contenu est le jeton brut « {{jeton}} » — EXACTEMENT le mécanisme de
// liaison déjà lu par tokens.ts (usesInLayer) et déjà éditable depuis le panneau de propriétés
// (TokenPicker, property-panel.tsx). Un designer peut donc le relier à un autre jeton ou le délier
// ensuite exactement comme n'importe quel calque texte créé autrement (spec §4).
export function buildDynamicTextLayer(
  row: DynamicTextRow,
  canvas: { width: number; height: number },
): TextLayer {
  const preset = TEXT_PRESETS[row.preset];
  return {
    id: crypto.randomUUID(),
    name: row.label,
    visible: true,
    locked: false,
    frame: frameFor(canvas, preset.size),
    type: "text",
    content: `{{${row.tokenId}}}`,
    font: { family: "Noto Sans", size: preset.size, weight: preset.weight },
    color: "#FFFFFF",
    align: "left",
    vAlign: "top",
    lineHeight: 1.2,
  };
}
