import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { listTemplates, listCategoriesForManual } from "@/lib/queries/studio";
import { getStudioConfig } from "@/lib/studio/config";
import { TemplatesTable } from "@/components/studio/templates-table";
import { StorageBanner } from "@/components/studio/storage-banner";

// Même forme canonique que app/(app)/settings/taxonomy/page.tsx : Server Component,
// requireUser() + requirePermission() avant toute requête, puis rendu d'un composant de
// présentation recevant les données déjà chargées.
//
// Tâche 15 (spec §8) : bannière de lecture seule quand getStudioConfig() est null — seules les
// opérations qui touchent au stockage (téléversement, aperçu, publication, génération) en dépendent
// réellement (voir components/studio/storage-banner.tsx) ; créer/dupliquer/renommer/archiver un
// gabarit ne sont que des écritures render_templates, donc restent actifs même sans R2.
//
// Correctif Critique 1 (revue finale V2) : listCategoriesForManual() (déjà utilisée par
// /studio/generer, Tâche 14) alimente le sélecteur de catégorie du dialogue « Nouveau gabarit »
// porté par TemplatesTable — la seule surface où la portée (canal/catégorie) d'un gabarit se
// choisit à la création.
export default async function Page() {
  const user = await requireUser();
  requirePermission(user.role, "template", "read");
  const [templates, categories] = await Promise.all([listTemplates(), listCategoriesForManual()]);
  const storageConfigured = !!getStudioConfig();
  return (
    <div className="space-y-4">
      {!storageConfigured && <StorageBanner />}
      <TemplatesTable templates={templates} categories={categories} />
    </div>
  );
}
