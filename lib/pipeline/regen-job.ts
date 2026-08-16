import { setItemStage, finishItem, isCancelRequested, finalizeRegenJob, listJobItems } from "@/lib/pipeline/regen-store";
import { db, regenJobs } from "@/db";
import { eq } from "drizzle-orm";
import type { RegenerateFieldsInput } from "@/lib/validation";

/**
 * Boucle détachée du renvoi à l'IA — l'équivalent d'executeRun pour la régénération. Lancée sans
 * await par startRegenJob (lib/actions/regen-actions.ts) : le serveur Railway est un processus
 * long, la promesse survit donc à la réponse de l'action, et le client suit l'avancement en sondant
 * getRegenJobAction.
 *
 * STRICTEMENT SÉRIELLE, délibérément : le pool de jetons OpenRouter est partagé et tourne jusqu'à
 * 2 × N jetons par appel (lib/ai/with-token-pool.ts) — des appels LLM parallèles multiplieraient les
 * périodes de récupération pour dépassement de quota. Le sériel est acceptable dès lors que la
 * progression est visible, ce qui est tout l'objet de ce job.
 *
 * NE JETTE JAMAIS : chaque article est isolé dans son try/catch (un échec ne coûte pas le lot) et
 * le job est clos dans un finally, pour qu'aucun job ne reste « running » à jamais.
 */
export async function runRegenJob(jobId: string): Promise<void> {
  try {
    const [job] = await db.select().from(regenJobs).where(eq(regenJobs.id, jobId));
    if (!job) return;
    const fields = job.fields as RegenerateFieldsInput;
    const imageMode = job.imageMode as "auto" | "manual";
    const items = await listJobItems(jobId);

    // Import dynamique : garde le graphe d'extraction/génération lourd (jsdom) hors de l'analyse
    // statique des modules qui importent ce runner.
    const { regenerateArticle } = await import("@/lib/pipeline/regenerate-core");

    for (const item of items) {
      // Annulation coopérative, sondée à la frontière sûre entre deux articles — jamais au milieu
      // d'une écriture. Les items restants gardent leur statut `pending`.
      if (await isCancelRequested(jobId)) break;
      try {
        const r = await regenerateArticle(item.articleId, fields, job.actorId, {
          imageMode,
          onStage: (stage) => setItemStage(item.id, stage),
        });
        const status = r.ok ? (r.awaitingImage ? "awaiting_image" : "ok") : "failed";
        await finishItem(item.id, status, r.ok && !r.awaitingImage ? null : r.message);
      } catch (e) {
        console.warn(`[regen-job] article ${item.articleId} en échec : ${(e as Error).message}`);
        await finishItem(item.id, "failed", (e as Error).message);
      }
    }
  } finally {
    await finalizeRegenJob(jobId).catch(() => {});
  }
}
