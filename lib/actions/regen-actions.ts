"use server";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { revalidatePath } from "next/cache";
import { startRegenJobSchema, type StartRegenJobInput, imagePickSchema, type ImagePickInput } from "@/lib/validation";
import type { RegenJobView } from "@/lib/pipeline/regen-live";

/**
 * Déclencheur NON BLOQUANT du renvoi à l'IA : ouvre le job (ce qui donne un jobId tout de suite),
 * lance le runner DÉTACHÉ, et rend la main immédiatement. Le client sonde ensuite
 * getRegenJobAction. Même motif que startPipelineRun (lib/actions/pipeline-actions.ts) — la
 * promesse détachée survit sur le processus Node long de Railway.
 *
 * L'unitaire passe par ici aussi, avec un seul id : un job de un. Un seul chemin de code, et la
 * page article gagne la même bande de progression que le lot.
 */
export async function startRegenJob(input: StartRegenJobInput): Promise<{ ok: true; jobId: string } | { ok: false; message: string }> {
  const user = await requireUser();
  requirePermission(user.role, "article", "regenerate");
  const parsed = startRegenJobSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Entrée invalide." };

  // Imports dynamiques APRÈS la garde RBAC — convention du fichier (voir article-actions.ts).
  const { db, articles } = await import("@/db");
  const { inArray } = await import("drizzle-orm");
  const { openRegenJob } = await import("@/lib/pipeline/regen-store");
  const { runRegenJob } = await import("@/lib/pipeline/regen-job");

  const rows = await db.select({ id: articles.id, title: articles.title })
    .from(articles).where(inArray(articles.id, parsed.data.articleIds));
  if (rows.length === 0) return { ok: false, message: "Aucun article trouvé." };

  const opened = await openRegenJob({
    actorId: user.id, articles: rows, fields: parsed.data.fields, imageMode: parsed.data.imageMode,
  });
  if (!opened.ok) return opened;

  // Détaché — ne PAS attendre. runRegenJob clôt toujours le job dans son propre finally, donc un
  // rejet est impossible en pratique ; le catch est une ceinture contre un rejet non géré.
  void runRegenJob(opened.jobId).catch(() => {});
  return { ok: true, jobId: opened.jobId };
}

/** Lecture seule pour le sondage du panneau de progression (1,5 s). */
export async function getRegenJobAction(jobId: string): Promise<RegenJobView | null> {
  const user = await requireUser();
  requirePermission(user.role, "article", "regenerate");
  const { readRegenJob } = await import("@/lib/pipeline/regen-store");
  return readRegenJob(jobId);
}

/**
 * Annulation coopérative : pose le drapeau, que runRegenJob observe à la frontière entre deux
 * articles. L'article en cours va jusqu'au bout — on n'interrompt jamais une écriture à mi-chemin.
 * Gardé par `finished_at IS NULL` : annuler un job déjà clos est un no-op silencieux, jamais une
 * réouverture d'un statut terminal.
 *
 * PAS de revalidatePath ici volontairement : une revalidation à cet instant redonnerait à
 * QueueTable un `rows` neuf, dont l'effet `[rows]` vide `rowSelection` — ce qui démonte
 * BulkActionBar (garde `rows.length === 0`) et avec elle RegenProgress, le SEUL observateur du
 * job. handleJobFinished ne serait alors jamais appelé : le job continue de s'annuler et de se
 * clore côté serveur, mais l'éditeur voit juste la barre disparaître sans confirmation. Le
 * rafraîchissement de la liste, lui, arrive déjà via router.refresh() dans handleJobFinished une
 * fois le job effectivement clos.
 */
export async function cancelRegenJob(jobId: string): Promise<void> {
  const user = await requireUser();
  requirePermission(user.role, "article", "regenerate");
  const { db, regenJobs } = await import("@/db");
  const { eq, isNull, and } = await import("drizzle-orm");
  await db.update(regenJobs).set({ cancelRequested: true })
    .where(and(eq(regenJobs.id, jobId), isNull(regenJobs.finishedAt)));
}

/** Choix d'image manuel depuis le bac / l'assistant du /queue. */
export async function pickRegeneratedImage(articleId: string, choice: ImagePickInput): Promise<{ ok: boolean; message: string }> {
  const user = await requireUser();
  requirePermission(user.role, "article", "regenerate");
  const parsed = imagePickSchema.safeParse(choice);
  if (!parsed.success) return { ok: false, message: "Choix invalide." };
  const { applyImagePick } = await import("@/lib/pipeline/regen-store");
  const r = await applyImagePick(articleId, parsed.data, user.id);
  revalidatePath("/queue"); revalidatePath(`/article/${articleId}`);
  return r;
}
