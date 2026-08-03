import { Badge } from "@/components/ui/badge";
import { statusLabel, type ArticleStatus } from "@/lib/format";

const STYLE: Record<ArticleStatus, string> = {
  draft: "bg-[var(--status-draft)]/15 text-[var(--status-draft)] border-[var(--status-draft)]/30",
  pending: "bg-[var(--status-pending)]/15 text-[var(--status-pending)] border-[var(--status-pending)]/30",
  in_review: "bg-[var(--status-in-review)]/15 text-[var(--status-in-review)] border-[var(--status-in-review)]/30",
  approved: "bg-[var(--status-approved)]/15 text-[var(--status-approved)] border-[var(--status-approved)]/30",
  published: "bg-[var(--status-published)]/15 text-[var(--status-published)] border-[var(--status-published)]/30",
  rejected: "bg-[var(--status-rejected)]/15 text-[var(--status-rejected)] border-[var(--status-rejected)]/30",
};

export function StatusBadge({ status }: { status: ArticleStatus }) {
  return (
    <Badge variant="outline" className={STYLE[status]}>
      {statusLabel(status)}
    </Badge>
  );
}
