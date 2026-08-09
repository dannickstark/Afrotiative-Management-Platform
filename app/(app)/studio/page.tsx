import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { listTemplates } from "@/lib/queries/studio";
import { TemplatesTable } from "@/components/studio/templates-table";

// Même forme canonique que app/(app)/settings/taxonomy/page.tsx : Server Component,
// requireUser() + requirePermission() avant toute requête, puis rendu d'un composant de
// présentation recevant les données déjà chargées.
export default async function Page() {
  const user = await requireUser();
  requirePermission(user.role, "template", "read");
  const templates = await listTemplates();
  return <TemplatesTable templates={templates} />;
}
