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
// panel/detail pill styling for these two statuses is wired in components/pipeline/live-run-panel.tsx,
// run-detail-sheet.tsx and runs-view.tsx (Task 5).
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

// SP7: a plain "N s" / "N min N s" rendering of a whole number of seconds — the shared low-level
// formatter behind formatRunDuration below AND the trends strip's "Durée moyenne" tile
// (components/pipeline/run-trends.tsx), so the two never drift apart on rounding/wording.
export function formatSecondsDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

// SP7: lifted from components/pipeline/run-detail-sheet.tsx (was a private local helper there) so
// the new runs-view.tsx Duration column can reuse it verbatim instead of re-implementing the same
// "en cours"/"en pause" + duration math a second time. A run with no finished_at is not finalized:
// normally "running" (→ "en cours"), but SP5 Task 5 also makes "paused" rows reachable in the runs
// list/detail (they intentionally leave finished_at null while parked) — so a paused run must read
// "en pause", not the misleading "en cours".
export function formatRunDuration(startedAt: Date | string, finishedAt: Date | string | null, status: string): string {
  if (!finishedAt) return status === "paused" ? "en pause" : "en cours";
  const ms = Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime());
  return formatSecondsDuration(ms / 1000);
}
