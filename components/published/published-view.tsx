import { PublishedFilterBar } from "./published-filter-bar";
import { PublishedTable } from "./published-table";
import { PublishedPagination } from "./published-pagination";
import { PageHeader } from "@/components/shell/page-header";
import type { PublishedFilters, PublishedPage } from "@/lib/queries/published";

export function PublishedView({
  page, filters, categories,
}: {
  page: PublishedPage;
  filters: PublishedFilters;
  categories: { id: string; name: string }[];
}) {
  const filtered = Boolean(filters.search || filters.categoryId || filters.from || filters.to || filters.author);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Articles publiés"
        actions={
          <span className="text-sm text-muted-foreground">{page.total} article{page.total > 1 ? "s" : ""}</span>
        }
      />
      <PublishedFilterBar filters={filters} categories={categories} />
      <PublishedTable rows={page.rows} filtered={filtered} />
      {page.pageCount > 1 && <PublishedPagination page={page.page} pageCount={page.pageCount} />}
    </div>
  );
}
