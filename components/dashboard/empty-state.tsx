import { Inbox } from "lucide-react";
export function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="grid place-items-center rounded-lg border border-dashed py-16 text-center">
      <Inbox className="size-8 text-muted-foreground mb-3" />
      <p className="font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{hint}</p>
    </div>
  );
}
