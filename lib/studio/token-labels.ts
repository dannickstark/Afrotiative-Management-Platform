// lib/studio/token-labels.ts — U4 Tâche 6 (correctif revue) : `TOKEN_LABELS` extrait de
// components/studio/token-picker.tsx vers un module PUR (aucun JSX, aucun import de composant).
//
// POURQUOI CE DÉPLACEMENT. `TOKEN_LABELS` n'est qu'un `Record<TokenId, string>` — il ne dépend que
// du TYPE `TokenId` de lib/studio/tokens.ts, jamais de React ni d'aucun composant. Mais
// token-picker.tsx, lui, importe `Popover`/`PopoverContent`/`PopoverTrigger` (@/components/ui/popover,
// base-ui) : tout module qui importe `TOKEN_LABELS` DEPUIS token-picker.tsx importe donc aussi,
// statiquement, tout l'arbre Popover — même s'il ne s'en sert jamais.
//
// C'est exactement ce qui a cassé components/studio/canvas.tsx (Tâche 6) : Canvas s'est mis à
// importer `TOKEN_LABELS` depuis token-picker.tsx pour l'étiquette « voir les liaisons », donc TOUT
// fichier de test import ANT `Canvas` (dont tests/studio-layer-view.test.ts, qui n'avait jamais
// touché à Popover) chargeait désormais base-ui AVANT que son propre `installDom()` n'ait tourné —
// gelant `useIsoLayoutEffect` sur un no-op pour le reste du process `bun test` (voir le commentaire
// en tête de tests/studio-interactions.test.ts pour le mécanisme complet). Constaté empiriquement :
// `TEST_LANE=pure bun test tests/studio-layer-view.test.ts tests/studio-interactions.test.ts` SANS
// `--isolate` passait de 42 pass/0 skip (avant) à 39 pass/3 skip (après) — le test du VRAI clic sur
// le Popover de studio-interactions.test.ts se voyait sauté, silencieusement dégradé.
//
// `lib/studio/` est déjà la zone du dépôt réservée aux modules client-safe/sans-DB (voir son propre
// historique : editor-prefs.ts, tokens.ts, values.ts...) — une table de libellés français appartient
// ici, pas dans un composant qui a par ailleurs besoin d'un Popover pour AUTRE CHOSE (le sélecteur
// lui-même). token-picker.tsx RÉ-EXPORTE `TOKEN_LABELS` depuis ce module (jamais une copie) pour que
// ses consommateurs existants (manual-generate.tsx, panels/images-panel.tsx) n'aient rien à changer.
import type { TokenId } from "./tokens";

// Étiquettes FRANÇAISES de chaque jeton (spec Tâche 8 : « chaque jeton montre son étiquette
// française »). Couvre la totalité de TOKEN_KINDS — tests/studio-token-picker.test.ts vérifie
// l'exhaustivité (un jeton sans étiquette se retrouverait affiché sous sa forme technique brute,
// {{article.byline}}, plutôt qu'en français, dans le sélecteur).
export const TOKEN_LABELS: Record<TokenId, string> = {
  "article.title": "Titre de l'article",
  "article.excerpt": "Extrait de l'article",
  "article.date": "Date de l'article",
  "article.byline": "Signature",
  "article.image": "Image de l'article",
  "article.url": "URL de l'article",
  "category.name": "Nom de la catégorie",
  "category.color": "Couleur de la catégorie",
  "source.names": "Sources",
  "brand.logo": "Logo de la marque",
  "quote.text": "Texte de la citation",
  "quote.attribution": "Attribution de la citation",
  "edition.title": "Titre de l'édition",
  "edition.date": "Date de l'édition",
  "recap.title": "Titre du récap",
  "recap.item1": "Élément 1 du récap",
  "recap.item2": "Élément 2 du récap",
  "recap.item3": "Élément 3 du récap",
};
