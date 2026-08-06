import { PublishedTable } from "./published-table";
import { PublishedPagination } from "./published-pagination";
import type { PublishedFilters, PublishedPage } from "@/lib/queries/published";

export function PublishedView({
  page, filters, categories,
}: {
  page: PublishedPage;
  filters: PublishedFilters;
  categories: { id: string; name: string }[];
}) {
  const filtered = Boolean(filters.search || filters.categoryId || filters.from || filters.to || filters.author);
  void categories; // used by the filter bar in Task 5
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Articles publiés</h1>
        <span className="text-sm text-muted-foreground">{page.total} article{page.total > 1 ? "s" : ""}</span>
      </div>
      <PublishedTable rows={page.rows} filtered={filtered} />
      <PublishedPagination page={page.page} pageCount={page.pageCount} />
    </div>
  );
}
