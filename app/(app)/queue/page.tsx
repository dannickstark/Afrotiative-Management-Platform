import { getQueue } from "@/lib/queries/queue";
import { QueueTable } from "@/components/queue/queue-table";

export default async function QueuePage() {
  const rows = await getQueue();
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">File de revue</h1>
      <QueueTable data={rows} />
    </div>
  );
}
