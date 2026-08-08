import { requireUser } from "@/lib/session";
import { getQueue, parseQueueSearchParams } from "@/lib/queries/queue";
import { getTaxonomy } from "@/lib/queries/settings";
import { QueueView } from "@/components/queue/queue-view";

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const filters = parseQueueSearchParams(await searchParams);
  const [page, { categories }] = await Promise.all([getQueue(filters), getTaxonomy()]);
  return (
    <QueueView
      page={page}
      filters={filters}
      categories={categories.map((c) => ({ id: c.id, name: c.name }))}
    />
  );
}
