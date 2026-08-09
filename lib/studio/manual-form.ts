// lib/studio/manual-form.ts — Tâche 14 (spec §7) : dérive le formulaire de /studio/generer à partir
// des DEUX catalogues déjà validés par V1 (CONTEXT_TOKENS, TOKEN_KINDS), jamais d'une liste de
// champs recopiée à part. C'est le contrat exact du brief : « the form is built from
// CONTEXT_TOKENS[context] — one field per token, typed by TOKEN_KINDS ». Un jeton ajouté à un
// contexte manuel dans tokens.ts (ex. `quote.source`) rend son champ disponible ici — et donc dans
// components/studio/manual-generate.tsx, qui n'itère que sur `fieldsForContext(context)` — SANS
// aucune modification de ce fichier ni du composant.
//
// Module pur (aucun import de "@/db" ni de React) : importable aussi bien par le composant client
// (components/studio/manual-generate.tsx) que par tests/studio-manual.test.ts, sans tirer le pool
// `pg` dans un bundle navigateur — même raisonnement que components/studio/token-picker.tsx:tokensFor.
import { CONTEXT_TOKENS, TOKEN_KINDS, type TemplateContext, type TokenId, type TokenKind } from "./tokens";

// Les trois contextes « à saisie manuelle » de la spec (§7) — citation, bandeau de newsletter,
// récap. article_image / social_post en sont délibérément absents : leurs jetons viennent d'un
// article réel (lib/studio/bindings.ts), pas d'une saisie manuelle.
export const MANUAL_CONTEXTS = ["quote_card", "newsletter_header", "recap_card"] as const satisfies readonly TemplateContext[];
export type ManualContext = (typeof MANUAL_CONTEXTS)[number];

export type ManualField = { token: TokenId; kind: TokenKind };

// PURE — DÉRIVÉE, pas recopiée : littéralement CONTEXT_TOKENS[context] mappé par TOKEN_KINDS, dans
// l'ORDRE déclaré par CONTEXT_TOKENS (stable, pas trié — un ordre de formulaire cohérent d'un rendu
// à l'autre). Ajouter un jeton à un contexte manuel dans tokens.ts change cette liste sans qu'aucune
// ligne ici ne bouge — c'est précisément ce que tests/studio-manual.test.ts vérifie en comparant à
// CONTEXT_TOKENS[context] directement (pas à une copie), pour qu'un futur hard-coding de la liste de
// champs fasse échouer le test plutôt que de passer par coïncidence.
export function fieldsForContext(context: TemplateContext): ManualField[] {
  return CONTEXT_TOKENS[context].map((token) => ({ token, kind: TOKEN_KINDS[token] }));
}
