import { requireUser } from "@/lib/session";
import { getPublishedArticles, parsePublishedSearchParams } from "@/lib/queries/published";
import { getTaxonomy } from "@/lib/queries/settings";
import { PublishedView } from "@/components/published/published-view";

export default async function PublishedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const filters = parsePublishedSearchParams(await searchParams);
  const [page, { categories }] = await Promise.all([getPublishedArticles(filters), getTaxonomy()]);
  return (
    <PublishedView
      page={page}
      filters={filters}
      categories={categories.map((c) => ({ id: c.id, name: c.name }))}
    />
  );
}
