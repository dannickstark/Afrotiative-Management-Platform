export type ArticleStatus = "draft" | "pending" | "in_review" | "approved" | "published" | "rejected";

export const STATUS_LABEL: Record<ArticleStatus, string> = {
  draft: "Brouillon",
  pending: "En attente",
  in_review: "En relecture",
  approved: "Approuvé",
  published: "Publié",
  rejected: "Rejeté",
};

export function statusLabel(s: ArticleStatus) {
  return STATUS_LABEL[s];
}

// SP5: adds 'cancelled' (Stop) and 'paused' (Pause/Resume) — mirrors db/schema.ts pipelineStatus.
// Labels only here (Task 1, required for this type to compile against the widened DB enum);
// panel/detail pill styling for these two statuses is wired in SP5 Task 5.
export type PipelineStatus = "success" | "partial" | "failed" | "running" | "cancelled" | "paused";

export const PIPELINE_STATUS_LABEL: Record<PipelineStatus, string> = {
  success: "Succès", partial: "Succès partiel", failed: "Échec", running: "En cours",
  cancelled: "Annulée", paused: "En pause",
};

export function pipelineStatusLabel(s: PipelineStatus | null | undefined): string {
  return s ? PIPELINE_STATUS_LABEL[s] : "—";
}

export function formatDate(d: Date | string | null): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(d));
}

export function relativeDate(d: Date | string | null): string {
  if (!d) return "—";
  const diff = (Date.now() - new Date(d).getTime()) / 1000;
  const h = Math.round(diff / 3600);
  if (h < 1) return "à l'instant";
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}
