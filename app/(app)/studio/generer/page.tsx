import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { listAssets } from "@/lib/queries/assets";
import { listCategoriesForManual } from "@/lib/queries/studio";
import { getStudioConfig } from "@/lib/studio/config";
import { ManualGenerate } from "@/components/studio/manual-generate";

// Même forme canonique que les autres pages Studio (app/(app)/studio/page.tsx,
// app/(app)/studio/assets/page.tsx) : Server Component, requireUser() + requirePermission() avant
// toute requête, puis rendu d'un Client Component recevant les données déjà chargées.
// "template:read" ici — la même garde que les autres pages de LECTURE du studio ; renderManual
// (Server Action, lib/actions/studio-manual-actions.ts) se re-garde lui-même avec "template:manage"
// indépendamment de ce que cette page affiche, exactement comme uploadAsset ne se fie jamais au
// "read" de app/(app)/studio/assets/page.tsx.
//
// Tâche 15 (spec §8) : storageConfigured redescend en prop, PAS recalculé côté client (getStudioConfig
// lit process.env, absent du bundle navigateur) — c'est ce qui permet à ManualGenerate d'afficher la
// bannière de lecture seule et de désactiver *Générer* SANS jamais tenter l'action puis échouer au
// clic.
export default async function StudioManualGeneratePage() {
  const user = await requireUser();
  requirePermission(user.role, "template", "read");

  const [assets, categories] = await Promise.all([listAssets(), listCategoriesForManual()]);
  const storageConfigured = !!getStudioConfig();

  return <ManualGenerate assets={assets} categories={categories} storageConfigured={storageConfigured} />;
}
