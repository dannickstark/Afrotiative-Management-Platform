import { Sparkles, User } from "lucide-react";
import { formatDate } from "@/lib/format";
import type { ArticleDetail } from "@/lib/queries/article";

// The pipeline's first revision is always literally "généré par IA" (see
// db/seed.ts and the SP3 generation step) — everything after that is a human
// action ("modifié", "rejeté", "planifié", …), rendered as "<Verbe> par X".
function describeRevision(action: string, actorName: string | null): { label: string; isAi: boolean } {
  if (action.trim().toLowerCase() === "généré par ia") {
    return { label: "Généré par IA", isAi: true };
  }
  const verb = action.charAt(0).toUpperCase() + action.slice(1);
  return { label: `${verb} par ${actorName ?? "un utilisateur"}`, isAi: false };
}

export function HistoryPanel({ revisions }: { revisions: ArticleDetail["revisions"] }) {
  if (revisions.length === 0) {
    return <p className="text-xs text-muted-foreground">Aucun historique.</p>;
  }
  return (
    <ol className="space-y-3">
      {revisions.map((r) => {
        const { label, isAi } = describeRevision(r.action, r.actorName);
        return (
          <li key={r.id} className="flex gap-2 text-xs">
            <span className={isAi ? "text-[var(--accent-brand)]" : "text-muted-foreground"}>
              {isAi ? <Sparkles className="mt-0.5 size-3.5" /> : <User className="mt-0.5 size-3.5" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-foreground">{label}</p>
              {r.detail && <p className="text-muted-foreground">{r.detail}</p>}
              <p className="text-muted-foreground">{formatDate(r.at)}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
