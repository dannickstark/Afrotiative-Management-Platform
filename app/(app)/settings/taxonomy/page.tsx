import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { getTaxonomy } from "@/lib/queries/settings";

export default async function Page() {
  const user = await requireUser();
  requirePermission(user.role, "taxonomy", "manage");
  const { categories, tags } = await getTaxonomy();
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Catégories & Tags</h1>
      {/* TaxonomyTable arrive en Task 3 */}
      <pre className="text-xs text-muted-foreground">
        {categories.length} catégorie(s), {tags.length} tag(s)
      </pre>
    </div>
  );
}
