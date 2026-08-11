"use client";

import { useMemo, useState, type Dispatch } from "react";
import Link from "next/link";
import { Search, UploadCloud } from "lucide-react";
import { Input } from "@/components/ui/input";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ImageAssetPicker } from "@/components/studio/asset-picker";
import { TOKEN_LABELS } from "@/components/studio/token-picker";
import { PanelHost } from "@/components/studio/panel-host";
import { CONTEXT_TOKENS, TOKEN_KINDS, type TemplateContext, type TokenId } from "@/lib/studio/tokens";
import { setLayerProp, type EditorAction } from "@/lib/studio/editor-state";
import { pickImageAsset } from "@/components/studio/asset-picker";
import type { AssetRow } from "@/lib/queries/assets";
import type { Layer, Scene } from "@/lib/studio/scene";
import type { RailCategory } from "@/lib/studio/editor-prefs";

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
// Correctif revue finale — Important 3 : `ImageAssetPicker` était monté avec `value=""` et
// `onPick={() => {}}` — une grille réelle dont CHAQUE clic était silencieusement avalé, sans le
// moindre calque sélectionné pour recevoir quoi que ce soit (`value=""` : rien n'y est jamais
// surligné). Un clic assigne désormais l'asset au calque IMAGE actuellement sélectionné, via
// `pickImageForSelection` ci-dessous (composable avec le VRAI réducteur, comme insertShapeTile/
// texte-panel.tsx) ; quand la sélection n'est PAS un calque image, le sélecteur est désactivé — le
// VRAI attribut `disabled` (pas seulement une classe Tailwind `disabled:`, un piège déjà rencontré
// par ce sous-projet où une recherche de sous-chaîne naïve fait un faux positif) — avec une
// explication française à côté.
//
// Correctif revue finale — Important 2 : ce panneau enrobe désormais LUI-MÊME `<PanelHost>`, ce qui
// lui permet de peupler `primaryAction` (« Importer un fichier ») ET `search` (filtre client-side
// sur `assets`, déjà reçu en prop — voir `filterAssetsBySearch` ci-dessous, exportée pure).
// Tâche 3 (U2, spec §3) — ce panneau garde `selectedId: string | null` alors que l'état de l'éditeur
// porte désormais `selectedIds: string[]`, et c'est délibéré : assigner un asset n'a de sens que sur
// UN calque image. editor-shell.tsx lui passe `singleSelectedId(state.selectedIds)`
// (lib/studio/editor-state.ts), donc une sélection multiple arrive ici comme `null` et le sélecteur
// se désactive exactement comme pour une sélection vide — le comportement honnête, sans code dédié.
// C'est le cas d'usage pour lequel le plan demandait une aide dérivée « so consumers that only make
// sense with one layer stay simple ». À ne pas confondre avec `ViewState.selectedId`
// (lib/studio/studio-mode.ts), qui porte un FORMAT en mode Rendu réel et n'a rien à voir.
export interface ImagesPanelProps {
  context: TemplateContext;
  assets: AssetRow[];
  scene: Scene;
  selectedId: string | null;
  dispatch: Dispatch<EditorAction>;
  onOpenChange?: (next: RailCategory | null) => void;
}

// PURE — exportée pour rester testable sans rendu (même convention que tokensFor dans
// components/studio/token-picker.tsx, qu'on ne réimporte pas ici pour éviter un couplage à un
// module "use client" tiers ; le filtrage lui-même n'a que deux dépendances, déjà importées).
export function imageSlotsFor(context: TemplateContext): TokenId[] {
  return CONTEXT_TOKENS[context].filter((id) => TOKEN_KINDS[id] === "image");
}

// PURE — filtre client-side sur le NOM de l'asset, insensible à la casse ; requête vide -> liste
// complète (copie, jamais la référence reçue). Même discipline que
// modeles-panel.tsx#filterTemplatesBySearch.
export function filterAssetsBySearch(assets: readonly AssetRow[], query: string): AssetRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...assets];
  return assets.filter((a) => a.name.toLowerCase().includes(q));
}

// PURE — ce qu'un clic sur un asset de la grille doit RÉELLEMENT produire : n'assigne QUE si le
// calque sélectionné est un calque IMAGE, sinon ne fait rien (défensif — le composant désactive déjà
// le sélecteur dans ce cas, donc `onPick` ne devrait jamais être atteignable, mais cette fonction
// reste totale plutôt que de supposer que son seul appelant est bien formé). Composable avec le VRAI
// réducteur pour un test direct (même idiome que insertShapeTile, elements-panel.tsx).
export function pickImageForSelection(
  layer: Layer | null,
  assetId: string,
  dispatch: Dispatch<EditorAction>,
): void {
  if (!layer || layer.type !== "image") return;
  dispatch(setLayerProp(layer.id, { source: pickImageAsset(assetId) }));
}

export function ImagesPanel({ context, assets, scene, selectedId, dispatch, onOpenChange = () => {} }: ImagesPanelProps) {
  const [query, setQuery] = useState("");
  const slots = imageSlotsFor(context);
  const filteredAssets = useMemo(() => filterAssetsBySearch(assets, query), [assets, query]);

  const selectedLayer = scene.layers.find((l) => l.id === selectedId) ?? null;
  const isImageLayer = selectedLayer?.type === "image";
  const currentAssetId = isImageLayer && selectedLayer.source.kind === "asset" ? selectedLayer.source.assetId : "";

  return (
    <PanelHost
      open="images"
      onOpenChange={onOpenChange}
      search={
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher un asset…"
            className="pl-7"
            data-testid="images-search"
          />
        </div>
      }
      primaryAction={
        <Link
          href="/studio/assets"
          className={cn(buttonVariants({ variant: "default", size: "sm" }), "w-full")}
          data-action="import-image"
        >
          <UploadCloud aria-hidden />Importer un fichier
        </Link>
      }
    >
      <div className="flex flex-col gap-4" data-testid="images-panel">
        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase">Assets importés</h3>
          <ImageAssetPicker
            assets={filteredAssets}
            value={currentAssetId}
            disabled={!isImageLayer}
            onPick={(assetId) => pickImageForSelection(selectedLayer, assetId, dispatch)}
          />
          <p className="text-xs text-muted-foreground">
            {isImageLayer
              ? "Cliquez un asset pour l’assigner au calque image sélectionné."
              : "Sélectionnez un calque image pour y placer un visuel."}
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
    </PanelHost>
  );
}
