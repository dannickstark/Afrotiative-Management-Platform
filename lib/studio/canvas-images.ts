import type { Layer } from "./scene";
import type { AssetRow } from "@/lib/queries/assets";

/**
 * Résout, pour l'AFFICHAGE du canevas « Montage » de l'éditeur, l'URL d'affichage de chaque calque
 * image dont la source est un ASSET de la bibliothèque — renvoyée dans une map keyed par ID DE
 * CALQUE, exactement comme `canvas.tsx` la consomme (`images?.get(layer.id)` → passé à
 * `LayerView`/`ImageContent`, layer-view.tsx).
 *
 * POURQUOI ce module existe. `ImageContent` (layer-view.tsx) peint une source `url` en direct
 * (`layer.source.url`) et une source `slot` en placeholder (l'éditeur n'a pas de valeur de jeton hors
 * Rendu réel). Une source `asset`, elle, n'a d'URL affichable que via la bibliothèque : `ImageContent`
 * l'attend dans sa prop `image`, qui vient de cette map. Sans elle, un calque image lié à un asset
 * restait bloqué sur le placeholder dans le canevas (le bug corrigé ici). L'`AssetRow` porte déjà
 * `url` (lib/queries/assets) : AUCUN réseau, une simple correspondance — PURE, comme `resolveTokens`
 * ou `resolveDisplayColor` (la même discipline « résoudre pour l'affichage sans toucher la scène »).
 *
 * Seules les sources `asset` entrent dans la map : `url` est peinte en direct (l'ajouter serait
 * redondant), `slot` reste un placeholder volontaire, et un asset RÉFÉRENCÉ mais absent de la
 * bibliothèque n'entre PAS (pas d'URL inventée → placeholder, comme l'export dégrade un asset
 * introuvable). Les calques non-image sont ignorés (le QR utilise un `slot`, pas une source d'asset).
 */
export function resolveCanvasImages(
  layers: readonly Layer[],
  assets: readonly AssetRow[],
): Map<string, string> {
  const urlByAssetId = new Map(assets.map((a) => [a.id, a.url]));
  const out = new Map<string, string>();
  for (const layer of layers) {
    if (layer.type !== "image") continue;
    if (layer.source.kind !== "asset") continue;
    const url = urlByAssetId.get(layer.source.assetId);
    if (url) out.set(layer.id, url);
  }
  return out;
}
