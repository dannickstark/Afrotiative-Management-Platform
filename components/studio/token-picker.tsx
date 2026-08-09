"use client";

import { Braces } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CONTEXT_TOKENS, TOKEN_KINDS, type TokenId, type TokenKind, type TemplateContext } from "@/lib/studio/tokens";

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

// PURE — LA règle testée par tests/studio-token-picker.test.ts : tous les jetons du contexte du
// gabarit (CONTEXT_TOKENS), filtrés par le TokenKind attendu par le champ courant (TOKEN_KINDS).
// C'est ici — nulle part ailleurs — que la règle V1 (article.url absent de article_image, parce que
// ce rendu a lieu AVANT la publication WordPress, lib/studio/tokens.ts) devient visible à
// l'utilisateur : elle n'est pas recodée, seulement HÉRITÉE des deux catalogues déjà validés par
// V1. Un sélecteur d'image ne propose donc que des jetons "image" ; un champ couleur, que des
// jetons "color" — jamais un jeton du mauvais type, quel que soit le contexte.
export function tokensFor(context: TemplateContext, kind: TokenKind): TokenId[] {
  return CONTEXT_TOKENS[context].filter((id) => TOKEN_KINDS[id] === kind);
}

export interface TokenPickerProps {
  context: TemplateContext;
  kind: TokenKind;
  onPick: (token: TokenId) => void;
  title?: string;
}

// Petit bouton "insérer un jeton" à coller à côté de n'importe quel champ du panneau de propriétés
// (Tâche 8) : ouvre la liste des jetons DISPONIBLES pour ce contexte et ce type, chacun avec son
// étiquette française et sa forme technique `{{jeton}}`. N'affiche rien si le contexte n'offre
// aucun jeton de ce type (ex. un contexte à saisie manuelle n'a pas de jeton "url").
export function TokenPicker({ context, kind, onPick, title }: TokenPickerProps) {
  const tokens = tokensFor(context, kind);
  if (tokens.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            title={title ?? "Insérer un jeton"}
            data-action="token-picker"
            data-kind={kind}
          >
            <Braces className="size-3.5" />
          </Button>
        }
      />
      <PopoverContent className="w-64 p-1" data-testid="token-picker-content">
        <ul className="flex flex-col">
          {tokens.map((id) => (
            <li key={id}>
              <button
                type="button"
                data-token={id}
                className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => onPick(id)}
              >
                <span>{TOKEN_LABELS[id]}</span>
                <span className="text-xs text-muted-foreground">{`{{${id}}}`}</span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
