import { QueueFilters } from "./queue-filters";
import { QueueTable } from "./queue-table";
import { QueuePagination } from "./queue-pagination";
import type { QueueFilters as Filters, QueuePage } from "@/lib/queries/queue";

export function QueueView({
  page, filters, categories,
}: {
  page: QueuePage;
  filters: Filters;
  categories: { id: string; name: string }[];
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">File de revue</h1>
        <span className="text-sm text-muted-foreground">
          {page.total} article{page.total > 1 ? "s" : ""}
        </span>
      </div>
      <QueueFilters filters={filters} categories={categories} />
      <QueueTable rows={page.rows} />
      {page.pageCount > 1 && <QueuePagination page={page.page} pageCount={page.pageCount} />}
    </div>
  );
}
