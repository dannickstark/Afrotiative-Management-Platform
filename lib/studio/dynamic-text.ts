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
import { textFrameFor } from "./layer-geometry";
import type { TextLayer } from "./scene";

export type DynamicTextRow = {
  tokenId: string; // un TokenId réel de tokens.ts (ex. "article.title") — jamais une forme raccourcie
  label: string; // French, e.g. "Titre de l'article"
  preset: TextPresetId;
  available: boolean; // false when the token is illegal in this context
  reason?: string; // French, present iff !available
};

// Correctif revue finale (Minor) : `TextTokenId` type l'exact sous-ensemble de `TokenId` dont le
// TOKEN_KINDS correspondant vaut "text" — `TOKEN_KINDS` est `as const satisfies Record<string,
// TokenKind>` (tokens.ts), donc ce type conditionnel mappé se recalcule automatiquement si un jeton
// change de nature. `DYNAMIC_TEXT_LABELS` ci-dessous, typé `Record<TextTokenId, …>`, EXIGE alors
// une entrée pour CHAQUE jeton texte (clé manquante = erreur de compilation) et REFUSE toute clé qui
// n'en serait pas un (jeton mal orthographié, ou un jeton texte retiré de tokens.ts = erreur de
// compilation aussi) — TypeScript remplace ainsi la vérification que faisait auparavant un `throw`
// au chargement du module. Ce `throw` s'exécutait dans le bundle CLIENT (ce module est importé par
// components/studio/panels/texte-panel.tsx, "use client") : une divergence entre tokens.ts et cette
// carte aurait fait planter `/studio` tout entier (écran blanc) plutôt qu'être détectée par `tsc`
// avant même de committer.
type TextTokenId = { [K in TokenId]: (typeof TOKEN_KINDS)[K] extends "text" ? K : never }[TokenId];

// Étiquette + préréglage propres à CETTE section (spec §4, tableau). Distincte de
// components/studio/token-picker.tsx (TOKEN_LABELS) : celle-là nomme un jeton pour n'importe quel
// champ de propriété («Extrait de l'article»), celle-ci nomme une LIGNE du panneau Texte, au
// vocabulaire du tableau §4 quand il en donne un (« Chapô », « Rubrique », « Signature », « Date »)
// — deux vocabulaires légitimement différents pour deux usages différents, pas une duplication à
// fusionner. Couvre la totalité des jetons de type "text" de TOKEN_KINDS — voir `TextTokenId`
// ci-dessus pour la garantie de complétude, désormais vérifiée à la compilation.
const DYNAMIC_TEXT_LABELS: Record<TextTokenId, { label: string; preset: TextPresetId }> = {
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
// stable, indépendant du contexte affiché.
const TEXT_TOKEN_IDS: TokenId[] = TOKEN_IDS.filter((id) => TOKEN_KINDS[id] === "text");

// Amendement de spec §4 (revue finale, décision produit) : les CINQ jetons nommés par le tableau §4
// — SEULS candidats à une ligne GRISÉE quand ils sont illégaux dans ce contexte. Avant cet
// amendement, `dynamicTextRowsFor` grisait l'univers "text" COMPLET (14 jetons) dans TOUS les
// contextes — jusqu'à 12 lignes grisées contre 2 utilisables pour `newsletter_header`, quand
// `quote.text`/`recap.item3` n'appartiennent même pas à ce type de gabarit. Les neuf autres jetons
// "text" (récap, citation, édition, sources) n'apparaissent DÉSORMAIS que là où ils sont utilisables
// — jamais grisés, jamais listés ailleurs. Garde TYPÉE (Set<TextTokenId>, pas une chaîne recopiée) :
// un jeton retiré de tokens.ts ferait échouer la compilation ici, pas silencieusement disparaître.
const TABLE_TOKEN_IDS: readonly TextTokenId[] = [
  "article.title", "article.excerpt", "category.name", "article.byline", "article.date",
];
const TABLE_TOKEN_SET = new Set<TextTokenId>(TABLE_TOKEN_IDS);

// PURE — la règle testée par tests/studio-dynamic-text.test.ts. Pour chaque jeton "text" : (a) légal
// ici -> ligne disponible ; (b) illégal ici MAIS l'un des cinq du tableau §4 -> ligne grisée, avec sa
// raison (spec §4 : « Tokens illegal in this template's context appear disabled with the reason ») ;
// (c) illégal ici et hors du tableau §4 -> OMISE entièrement, jamais listée.
export function dynamicTextRowsFor(context: TemplateContext): DynamicTextRow[] {
  const legal = new Set<string>(CONTEXT_TOKENS[context]);
  const rows: DynamicTextRow[] = [];
  for (const tokenId of TEXT_TOKEN_IDS) {
    const available = legal.has(tokenId);
    if (!available && !TABLE_TOKEN_SET.has(tokenId as TextTokenId)) continue;
    const meta = DYNAMIC_TEXT_LABELS[tokenId as TextTokenId];
    rows.push({
      tokenId,
      label: meta.label,
      preset: meta.preset,
      available,
      reason: available
        ? undefined
        : `Indisponible pour ce type de gabarit (« ${CONTEXT_LABEL[context]} »).`,
    });
  }
  return rows;
}

// PURE — le calque qu'un clic sur une ligne DISPONIBLE insère : un TextLayer NORMAL, sans statut
// spécial, dont le seul contenu est le jeton brut « {{jeton}} » — EXACTEMENT le mécanisme de
// liaison déjà lu par tokens.ts (usesInLayer) et déjà éditable depuis le panneau de propriétés
// (TokenPicker, property-panel.tsx). Un designer peut donc le relier à un autre jeton ou le délier
// ensuite exactement comme n'importe quel calque texte créé autrement (spec §4). Le cadre vient de
// `textFrameFor` (lib/studio/layer-geometry.ts, Correctif revue finale — Minor) : shape-gallery.ts
// en portait auparavant une copie quasi identique.
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
    frame: textFrameFor(canvas, preset.size),
    type: "text",
    content: `{{${row.tokenId}}}`,
    font: { family: "Noto Sans", size: preset.size, weight: preset.weight },
    color: "#FFFFFF",
    align: "left",
    vAlign: "top",
    lineHeight: 1.2,
  };
}

// PURE — ce qu'un clic sur une ligne de « Texte dynamique » doit RÉELLEMENT produire (spec §9 :
// « a token illegal in the context is disabled and clicking it inserts nothing »), extrait en
// fonction testable plutôt qu'un `if` inline dans le composant (leçon répétée de ce sous-projet : un
// prédicat inline resté pur et jamais testé directement). `null` pour une ligne indisponible — le
// composant (texte-panel.tsx) ne dispatch alors rien du tout.
export function insertDynamicTextLayer(
  row: DynamicTextRow,
  canvas: { width: number; height: number },
): TextLayer | null {
  return row.available ? buildDynamicTextLayer(row, canvas) : null;
}
