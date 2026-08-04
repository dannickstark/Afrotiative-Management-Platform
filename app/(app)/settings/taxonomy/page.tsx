import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { getTaxonomy } from "@/lib/queries/settings";
import { TaxonomyTables } from "@/components/settings/taxonomy-tables";

export default async function Page() {
  const user = await requireUser();
  requirePermission(user.role, "taxonomy", "manage");
  const data = await getTaxonomy();
  return <TaxonomyTables data={data} />;
}
