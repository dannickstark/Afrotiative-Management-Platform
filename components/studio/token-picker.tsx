"use client";

import { Braces } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  CONTEXT_TOKENS, TOKEN_KINDS, TOKEN_IDS, type TokenId, type TokenKind, type TemplateContext,
} from "@/lib/studio/tokens";

// IMPORTÉE puis RÉ-EXPORTÉE (correctif revue, U4 Tâche 6) — la table elle-même vit désormais dans
// lib/studio/token-labels.ts, un module PUR sans JSX/Popover, pour que components/studio/canvas.tsx
// (qui n'a besoin QUE de cette table, jamais du sélecteur ni de Popover) puisse la consommer sans
// importer statiquement tout l'arbre Popover de CE fichier — voir le commentaire de tête de
// token-labels.ts pour l'incident que ce déplacement corrige. IMPORTÉE ici (pas seulement
// réexportée depuis "@/lib/studio/token-labels") parce que `pickerRowsFor` plus bas, DANS ce même
// module, s'en sert aussi — un `export … from` ne lie PAS le nom localement, seulement au module
// consommateur. Ré-exportée (jamais dupliquée) pour que les consommateurs existants de CE module
// (manual-generate.tsx, panels/images-panel.tsx) n'aient rien à changer.
import { TOKEN_LABELS } from "@/lib/studio/token-labels";
export { TOKEN_LABELS };

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

// UNE ligne du sélecteur — `id`/`label` couvrent CHAQUE jeton du TokenKind demandé (jamais
// seulement ceux légaux ici), `available` dit s'il l'est dans CE contexte, `reason` (non vide ssi
// `!available`) dit pourquoi pas. Même forme que `DynamicTextRow` (lib/studio/dynamic-text.ts).
export type PickerRow = {
  id: TokenId;
  label: string;
  available: boolean;
  reason?: string;
};

// PURE — Tâche 5 (U4, correctif du défaut que `tokensFor` porte depuis la Tâche 8) : `tokensFor`
// FILTRE CONTEXT_TOKENS[context] par TokenKind, donc un jeton hors contexte DISPARAÎT purement et
// simplement de la liste — un designer qui cherche « pourquoi n'y a-t-il pas de jeton citation ici »
// ne trouve RIEN à regarder. `pickerRowsFor` renvoie au contraire l'univers COMPLET des TOKEN_IDS de
// ce TokenKind (dérivé de tokens.ts, jamais une liste recopiée) : un jeton hors CONTEXT_TOKENS[context]
// reste dans la liste, `available:false`, avec une raison non vide — jamais omis. Même principe que
// `dynamicTextRowsFor` (lib/studio/dynamic-text.ts), appliqué ici au sélecteur GÉNÉRIQUE de
// n'importe quel champ liable (texte, couleur, image, URL) plutôt qu'à la seule section « Texte
// dynamique ». La formulation de la raison reprend le fragment exact de `validateScene`
// (lib/studio/tokens.ts : « n'est pas disponible dans ce contexte ») — la même phrase que verrait un
// designer qui aurait quand même réussi à publier une liaison illégale, jamais une seconde version
// qui pourrait diverger.
export function pickerRowsFor(context: TemplateContext, kind: TokenKind): PickerRow[] {
  const legal = new Set<string>(CONTEXT_TOKENS[context]);
  return TOKEN_IDS.filter((id) => TOKEN_KINDS[id] === kind).map((id) => {
    const available = legal.has(id);
    return {
      id,
      label: TOKEN_LABELS[id],
      available,
      reason: available ? undefined : `« ${TOKEN_LABELS[id]} » n'est pas disponible dans ce contexte.`,
    };
  });
}

export interface TokenPickerProps {
  context: TemplateContext;
  kind: TokenKind;
  onPick: (token: TokenId) => void;
  title?: string;
}

// Petit bouton "insérer un jeton" à coller à côté de n'importe quel champ du panneau de propriétés
// (Tâche 8) : ouvre la liste de TOUS les jetons de ce TokenKind (Tâche 5, U4) — ceux illégaux dans ce
// contexte apparaissent GRISÉS avec leur raison plutôt que d'être omis (même correctif que la section
// « Texte dynamique », lib/studio/dynamic-text.ts/texte-panel.tsx, dont ce composant reprend le même
// motif d'accessibilité : `aria-disabled="true"` + `aria-describedby`, JAMAIS l'attribut HTML
// `disabled`, qui retirerait la ligne de l'ordre de tabulation et empêcherait un lecteur d'écran d'en
// annoncer la raison). N'affiche rien seulement si AUCUN jeton de ce TokenKind n'existe nulle part
// dans le catalogue (tokens.ts) — un cas qui n'existe pas aujourd'hui (chaque TokenKind a au moins un
// jeton) mais que ce garde-fou couvre si le catalogue changeait un jour.
export function TokenPicker({ context, kind, onPick, title }: TokenPickerProps) {
  const rows = pickerRowsFor(context, kind);
  if (rows.length === 0) return null;

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
          {rows.map((row) => {
            const reasonId = `token-picker-reason-${kind}-${row.id}`;
            return (
              <li key={row.id}>
                <button
                  type="button"
                  data-token={row.id}
                  data-available={row.available}
                  aria-disabled={!row.available}
                  aria-describedby={row.available ? undefined : reasonId}
                  onClick={() => { if (row.available) onPick(row.id); }}
                  className={cn(
                    "flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                    !row.available && "cursor-not-allowed opacity-50 hover:bg-transparent",
                  )}
                >
                  <span>{row.label}</span>
                  <span className="text-xs text-muted-foreground">{`{{${row.id}}}`}</span>
                  {!row.available && (
                    <span id={reasonId} className="text-[11px] text-muted-foreground">
                      {row.reason}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
