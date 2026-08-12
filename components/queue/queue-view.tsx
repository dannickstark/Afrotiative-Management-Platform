import { QueueFilters } from "./queue-filters";
import { QueueTable } from "./queue-table";
import { QueuePagination } from "./queue-pagination";
import { PageHeader } from "@/components/shell/page-header";
import type { QueueFilters as Filters, QueuePage } from "@/lib/queries/queue";

export function QueueView({
  page, filters, categories,
}: {
  page: QueuePage;
  filters: Filters;
  categories: { id: string; name: string }[];
}) {
  return (
    <div className="space-y-6">
      <PageHeader
        title="File de revue"
        actions={
          <span className="text-sm text-muted-foreground">
            {page.total} article{page.total > 1 ? "s" : ""}
          </span>
        }
      />
      <QueueFilters filters={filters} categories={categories} />
      <QueueTable rows={page.rows} categories={categories} />
      {page.pageCount > 1 && <QueuePagination page={page.page} pageCount={page.pageCount} />}
    </div>
  );
}
