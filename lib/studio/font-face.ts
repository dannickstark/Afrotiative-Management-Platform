// lib/studio/font-face.ts — un seul endroit pour dériver le nom de famille CSS scopé qu'un
// `@font-face` inline utilise pour prévisualiser une police d'asset DANS LE NAVIGATEUR (bibliothèque
// Tâche 11, sélecteur Tâche 13). Extrait pour que les deux surfaces ne puissent jamais diverger sur
// la convention de nommage — un préfixe stable, jamais un simple `a.fontFamily` brut (qui pourrait
// collisionner avec une police déjà installée sur la machine de l'utilisateur, ex. "Arial").
export function fontFaceFamily(assetId: string): string {
  return `studio-asset-font-${assetId}`;
}

// Le `src` d'un `@font-face` inline pointe ICI — un chemin MÊME ORIGINE (app/api/studio/
// asset-fonts/[id]/route.ts), jamais directement l'URL publique R2 (AssetRow.url) : découvert en
// pilotant un vrai navigateur, `@font-face` exige des en-têtes CORS pour une ressource cross-origin
// et le bucket R2 public n'en envoie aucun — voir la note du proxy pour le détail. `<img src>`
// (miniatures d'image) n'a PAS ce problème (l'affichage seul ne demande pas CORS), donc SEULES les
// polices passent par ce détour.
export function fontProxyUrl(assetId: string): string {
  return `/api/studio/asset-fonts/${assetId}`;
}
