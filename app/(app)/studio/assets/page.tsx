import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { listAssets } from "@/lib/queries/assets";
import { getStudioConfig } from "@/lib/studio/config";
import { AssetLibrary } from "@/components/studio/asset-library";

// Même forme canonique que app/(app)/studio/page.tsx : Server Component, requireUser() +
// requirePermission() avant toute requête, puis rendu d'un composant de présentation recevant les
// données déjà chargées. "template:read" pour la LECTURE (même garde que la page Gabarits) — les
// mutations (uploadAsset/deleteAsset, lib/actions/asset-actions.ts) exigent "template:manage" et se
// re-gardent elles-mêmes indépendamment de ce que cette page affiche.
//
// Tâche 15 : storageConfigured redescend en prop — uploadAssetCore renvoie déjà « Stockage R2 non
// configuré. » gracieusement (lib/studio/asset-core.ts) si on clique quand même, mais spec §8 veut
// le téléversement DÉSACTIVÉ d'emblée plutôt qu'un échec au clic.
export default async function Page() {
  const user = await requireUser();
  requirePermission(user.role, "template", "read");
  const assets = await listAssets();
  const storageConfigured = !!getStudioConfig();
  return <AssetLibrary assets={assets} storageConfigured={storageConfigured} />;
}
