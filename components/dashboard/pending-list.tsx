import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState } from "./empty-state";
import { relativeDate, type ArticleStatus } from "@/lib/format";

type PendingItem = {
  id: string;
  title: string;
  status: ArticleStatus;
  generatedAt: Date | null;
  confidenceFlags: { categoryUncertain?: boolean; imageMissing?: boolean; clusterUncertain?: boolean };
};

export function PendingList({ items }: { items: PendingItem[] }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Derniers articles en attente</CardTitle></CardHeader>
      <CardContent>
        {items.length === 0 ? <EmptyState title="Rien à relire" hint="Le pipeline n'a rien produit de nouveau." /> : (
          <ul className="divide-y">
            {items.map((a) => {
              const low = a.confidenceFlags?.categoryUncertain || a.confidenceFlags?.imageMissing;
              return (
                <li key={a.id} className="py-2">
                  <Link href={`/article/${a.id}`} className="flex items-center gap-2 hover:underline">
                    {low && <span title="Faible confiance IA" className="size-2 rounded-full bg-accent-brand" />}
                    <span className="flex-1 truncate">{a.title}</span>
                    <span className="text-xs text-muted-foreground">{relativeDate(a.generatedAt)}</span>
                    <StatusBadge status={a.status} />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
