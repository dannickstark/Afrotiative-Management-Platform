"use client";

import Link from "next/link";
import { UploadCloud } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ImageAssetPicker } from "@/components/studio/asset-picker";
import { TOKEN_LABELS } from "@/components/studio/token-picker";
import { CONTEXT_TOKENS, TOKEN_KINDS, type TemplateContext, type TokenId } from "@/lib/studio/tokens";
import type { AssetRow } from "@/lib/queries/assets";

// components/studio/panels/images-panel.tsx — Tâche 2 (U1, spec §3) : le contenu de la catégorie
// « Images » du rail. Deux sections (spec §3) :
//   1. « Assets importés » — héberge `ImageAssetPicker` (components/studio/asset-picker.tsx, déjà
//      branché sur les calques image du panneau de propriétés) plutôt que de reconstruire une
//      seconde grille de vignettes — c'est exactement la surface qu'un duplicata reproduirait,
//      voir spec §3 « A duplicated asset grid is a review finding ».
//   2. « Emplacements d'image de ce contexte » — dérivée de CONTEXT_TOKENS/TOKEN_KINDS
//      (lib/studio/tokens.ts, la même source que components/studio/token-picker.tsx), filtrée aux
//      jetons de type "image" : {{article.image}}, {{brand.logo}}, etc. selon le contexte du
//      gabarit ouvert.
//
// PAS de prop `dispatch`/`EditorAction` ici : contrairement au panneau Texte (Tâche 3) ou Éléments
// (Tâche 4), la spec de cette tâche ne décrit aucun clic-pour-insérer sur une image — le chemin
// « assigner un asset à un calque image » existe déjà et reste dans le panneau de propriétés
// (PropertyPanel + ImageAssetPicker, Tâche 13). Le sélecteur ici sert donc à PARCOURIR la
// bibliothèque, pas encore à insérer — la légende sous le sélecteur le dit explicitement plutôt que
// de laisser un clic sans effet visible passer pour un bouton qui « ne marche pas ».
export interface ImagesPanelProps {
  context: TemplateContext;
  assets: AssetRow[];
}

// PURE — exportée pour rester testable sans rendu (même convention que tokensFor dans
// components/studio/token-picker.tsx, qu'on ne réimporte pas ici pour éviter un couplage à un
// module "use client" tiers ; le filtrage lui-même n'a que deux dépendances, déjà importées).
export function imageSlotsFor(context: TemplateContext): TokenId[] {
  return CONTEXT_TOKENS[context].filter((id) => TOKEN_KINDS[id] === "image");
}

export function ImagesPanel({ context, assets }: ImagesPanelProps) {
  const slots = imageSlotsFor(context);

  return (
    <div className="flex flex-col gap-4" data-testid="images-panel">
      <Link
        href="/studio/assets"
        className={cn(buttonVariants({ variant: "default", size: "sm" }), "w-full")}
        data-action="import-image"
      >
        <UploadCloud aria-hidden />Importer un fichier
      </Link>

      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase">Assets importés</h3>
        <ImageAssetPicker assets={assets} value="" onPick={() => {}} />
        <p className="text-xs text-muted-foreground">
          Sélectionnez d&rsquo;abord un calque image sur le canevas pour lui assigner un asset depuis
          le panneau de propriétés.
        </p>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase">
          Emplacements d&rsquo;image de ce contexte
        </h3>
        {slots.length === 0 ? (
          <p className="text-xs text-muted-foreground">Ce contexte ne définit aucun emplacement d&rsquo;image.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {slots.map((slot) => (
              <li key={slot} className="flex flex-col rounded-md border px-2 py-1.5 text-sm">
                <span>{TOKEN_LABELS[slot]}</span>
                <span className="text-xs text-muted-foreground">{`{{${slot}}}`}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
