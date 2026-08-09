import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { listAssets } from "@/lib/queries/assets";
import { AssetLibrary } from "@/components/studio/asset-library";

// Même forme canonique que app/(app)/studio/page.tsx : Server Component, requireUser() +
// requirePermission() avant toute requête, puis rendu d'un composant de présentation recevant les
// données déjà chargées. "template:read" pour la LECTURE (même garde que la page Gabarits) — les
// mutations (uploadAsset/deleteAsset, lib/actions/asset-actions.ts) exigent "template:manage" et se
// re-gardent elles-mêmes indépendamment de ce que cette page affiche.
export default async function Page() {
  const user = await requireUser();
  requirePermission(user.role, "template", "read");
  const assets = await listAssets();
  return <AssetLibrary assets={assets} />;
}
