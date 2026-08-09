import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { listTemplates } from "@/lib/queries/studio";
import { getStudioConfig } from "@/lib/studio/config";
import { TemplatesTable } from "@/components/studio/templates-table";
import { StorageBanner } from "@/components/studio/storage-banner";

// Même forme canonique que app/(app)/settings/taxonomy/page.tsx : Server Component,
// requireUser() + requirePermission() avant toute requête, puis rendu d'un composant de
// présentation recevant les données déjà chargées.
//
// Tâche 15 (spec §8) : bannière de lecture seule quand getStudioConfig() est null. Rien d'autre à
// désactiver ICI — cette page ne fait que lister (créer/dupliquer/archiver, aucune UI encore
// branchée, restent des Server Actions sans point d'entrée écran) ; le studio et ses sous-pages
// (éditeur, bibliothèque, génération) portent chacun leur propre désactivation ciblée.
export default async function Page() {
  const user = await requireUser();
  requirePermission(user.role, "template", "read");
  const templates = await listTemplates();
  const storageConfigured = !!getStudioConfig();
  return (
    <div className="space-y-4">
      {!storageConfigured && <StorageBanner />}
      <TemplatesTable templates={templates} />
    </div>
  );
}
