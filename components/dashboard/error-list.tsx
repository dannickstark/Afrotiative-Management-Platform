import { AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "./empty-state";

export function ErrorList({ items }: { items: { id: string; name: string; message: string | null }[] }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Erreurs du pipeline à traiter</CardTitle></CardHeader>
      <CardContent>
        {items.length === 0 ? <EmptyState title="Aucune erreur" hint="Le pipeline tourne normalement." /> : (
          <ul className="divide-y">
            {items.map((e) => (
              <li key={e.id} className="py-2">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="size-4 shrink-0 text-[var(--status-error)]" />
                  <span className="font-medium">{e.name}</span>
                  <span className="flex-1 truncate text-sm text-muted-foreground">{e.message}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
