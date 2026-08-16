// PUR — dérivations d'affichage pour le panneau de progression du renvoi à l'IA. Aucun accès DB ni
// réseau, exactement comme lib/pipeline/live.ts le fait pour le panneau d'exécution du pipeline :
// la logique d'affichage est ainsi testable en table de fixtures sur la voie test:pure, et le
// composant client se réduit au sondage + au rendu.
export type RegenStage = "queued" | "extracting" | "generating" | "writing";
export type RegenItemStatus = "pending" | "ok" | "failed" | "awaiting_image";

export type RegenItemView = {
  id: string; articleId: string; title: string;
  stage: RegenStage; status: RegenItemStatus; message: string | null;
};

export type RegenJobView = {
  id: string; total: number; done: number;
  status: "running" | "done" | "failed" | "cancelled";
  imageMode: "auto" | "manual";
  items: RegenItemView[];
};

export const STAGE_LABELS: Record<RegenStage, string> = {
  queued: "En attente",
  extracting: "Extraction des sources",
  generating: "Génération IA",
  writing: "Écriture",
};

export function deriveRegenHeader(job: RegenJobView): { label: string; done: number; total: number; percent: number } {
  const percent = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
  // L'article « en cours » est le premier item encore pending : le runner est strictement sériel,
  // il ne peut donc jamais y en avoir deux.
  const current = job.items.find((i) => i.status === "pending" && i.stage !== "queued");
  if (current === undefined) {
    const label = job.status === "running" ? "Préparation…" : job.status === "cancelled" ? "Annulé" : "Terminé";
    return { label, done: job.done, total: job.total, percent: job.status === "running" ? percent : 100 };
  }
  return { label: `${STAGE_LABELS[current.stage]} — ${current.title}`, done: job.done, total: job.total, percent };
}

export function summarizeRegenJob(job: RegenJobView): { ok: number; failed: number; awaitingImage: number } {
  let ok = 0, failed = 0, awaitingImage = 0;
  for (const i of job.items) {
    if (i.status === "ok") ok += 1;
    else if (i.status === "failed") failed += 1;
    else if (i.status === "awaiting_image") awaitingImage += 1;
  }
  return { ok, failed, awaitingImage };
}
