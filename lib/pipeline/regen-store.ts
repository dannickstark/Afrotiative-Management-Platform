import { db, regenJobs, regenJobItems, articles, articleRevisions } from "@/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { RegenerateFieldsInput } from "@/lib/validation";
import type { RegenStage, RegenItemStatus, RegenJobView } from "@/lib/pipeline/regen-live";

// Accès DB du job de régénération, isolé du runner (lib/pipeline/regen-job.ts) et des actions
// (lib/actions/regen-actions.ts) : le runner ne fait qu'orchestrer, ce module possède toutes les
// écritures d'état. Même découpe que openRun/executeRun côté pipeline.

/**
 * Ouvre un job et ses items dans UNE transaction. L'index unique partiel
 * regen_job_items_one_inflight_per_article rejette l'insert si l'un des articles est déjà dans un
 * item non terminé — on traduit cette violation en message métier plutôt que de la laisser remonter.
 */
export async function openRegenJob(input: {
  actorId: string | null;
  articles: { id: string; title: string }[];
  fields: RegenerateFieldsInput;
  imageMode: "auto" | "manual";
}): Promise<{ ok: true; jobId: string } | { ok: false; message: string }> {
  if (input.articles.length === 0) return { ok: false, message: "Aucun article sélectionné." };
  try {
    const jobId = await db.transaction(async (tx) => {
      const [job] = await tx.insert(regenJobs).values({
        actorId: input.actorId, fields: input.fields, imageMode: input.imageMode,
        total: input.articles.length,
      }).returning({ id: regenJobs.id });
      await tx.insert(regenJobItems).values(input.articles.map((a) => ({
        jobId: job.id, articleId: a.id, title: a.title,
      })));
      return job.id;
    });
    return { ok: true, jobId };
  } catch (e) {
    // drizzle enveloppe l'erreur pg dans une DrizzleQueryError : le texte de contrainte postgres vit
    // sur `cause` (constraint / message), PAS sur `.message` du niveau supérieur (qui ne contient que
    // la requête SQL). On regarde les deux pour rester robuste au habillage exact de l'erreur.
    const cause = (e as { cause?: { constraint?: string; message?: string } }).cause;
    const marker = "regen_job_items_one_inflight_per_article";
    if (cause?.constraint === marker || cause?.message?.includes(marker) || (e as Error).message.includes(marker)) {
      return { ok: false, message: "Un renvoi à l'IA est déjà en cours sur l'un de ces articles." };
    }
    throw e;
  }
}

export async function listJobItems(jobId: string): Promise<{ id: string; articleId: string; title: string }[]> {
  return db.select({ id: regenJobItems.id, articleId: regenJobItems.articleId, title: regenJobItems.title })
    .from(regenJobItems).where(eq(regenJobItems.jobId, jobId)).orderBy(regenJobItems.title);
}

export async function setItemStage(itemId: string, stage: RegenStage): Promise<void> {
  await db.update(regenJobItems)
    .set({ stage, startedAt: sql`coalesce(${regenJobItems.startedAt}, now())` })
    .where(eq(regenJobItems.id, itemId));
}

/**
 * Termine un item et incrémente le compteur du job dans la même transaction, pour qu'un sondage ne
 * puisse jamais voir un `done` en retard sur les items. `awaiting_image` est TERMINAL (finished_at
 * renseigné) : l'article redevient immédiatement éligible à un nouveau renvoi, l'attente de choix
 * vivant dans articles.pending_image_candidates.
 */
export async function finishItem(
  itemId: string,
  status: Exclude<RegenItemStatus, "pending">,
  message: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.update(regenJobItems)
      .set({ status, message, finishedAt: new Date() })
      .where(eq(regenJobItems.id, itemId))
      .returning({ jobId: regenJobItems.jobId });
    if (row) {
      await tx.update(regenJobs)
        .set({ done: sql`${regenJobs.done} + 1` })
        .where(eq(regenJobs.id, row.jobId));
    }
  });
}

export async function isCancelRequested(jobId: string): Promise<boolean> {
  const [row] = await db.select({ c: regenJobs.cancelRequested }).from(regenJobs).where(eq(regenJobs.id, jobId));
  return row?.c ?? false;
}

/**
 * Clôture le job. `failed` est réservé au cas où TOUS les items ont échoué ; sinon `done`, avec le
 * rapport d'échecs partiels porté par les items (même convention que les lots existants). Un job
 * dont l'annulation a été demandée se termine en `cancelled`.
 *
 * INVARIANT D'APPEL : finalizeRegenJob n'est appelé qu'une fois la boucle du runner terminée, donc
 * jamais en concurrence d'un finishItem de ce job (runRegenJob est strictement sériel et l'appelle
 * depuis son `finally`). C'est ce qui permet à ces quatre requêtes de ne pas être dans une
 * transaction. Un appelant qui romprait cet invariant verrait un finishItem tardif écraser une
 * ligne balayée et désynchroniser `done` du statut terminal du job.
 */
export async function finalizeRegenJob(jobId: string): Promise<void> {
  // Tout item encore NON TERMINÉ à la clôture — job annulé avant de l'atteindre, ou processus mort
  // en cours de route — doit être fermé ICI. L'index unique partiel
  // regen_job_items_one_inflight_per_article ne regarde que `finished_at is null` : un item laissé
  // ouvert verrouillerait son article hors de TOUTE régénération ultérieure, définitivement.
  // On n'incrémente PAS `done` au passage : le compteur doit refléter le travail réellement
  // effectué, pour qu'un job annulé à 3/10 s'affiche bien à 30 % (voir lib/pipeline/regen-live.ts).
  await db.update(regenJobItems)
    .set({ status: "failed", message: "Annulé avant traitement.", finishedAt: new Date() })
    .where(and(eq(regenJobItems.jobId, jobId), isNull(regenJobItems.finishedAt)));

  const items = await db.select({ status: regenJobItems.status })
    .from(regenJobItems).where(eq(regenJobItems.jobId, jobId));
  const cancelled = await isCancelRequested(jobId);
  const allFailed = items.length > 0 && items.every((i) => i.status === "failed");
  const status = cancelled ? "cancelled" : allFailed ? "failed" : "done";
  await db.update(regenJobs).set({ status, finishedAt: new Date() }).where(eq(regenJobs.id, jobId));
}

/**
 * Applique un choix d'image manuel. Le cœur vit ici (module plain, testable sans contexte de
 * requête) ; l'action pickRegeneratedImage n'ajoute que RBAC + revalidation autour.
 *
 * L'URL choisie DOIT figurer dans la liste en attente de CET article : le client envoie une URL,
 * et une action serveur ne fait jamais confiance à une URL arbitraire venue du navigateur (elle
 * finirait en `src` d'une image publiée). `choice === null` = « Aucune image » : on vide l'attente
 * sans jamais effacer l'image en place.
 */
export async function applyImagePick(
  articleId: string,
  choice: { url: string; credit: string | null; sourceUrl: string | null } | null,
  actorId: string | null,
): Promise<{ ok: boolean; message: string }> {
  const [article] = await db.select().from(articles).where(eq(articles.id, articleId));
  if (!article) return { ok: false, message: "Article introuvable." };

  if (choice === null) {
    await db.update(articles).set({ pendingImageCandidates: null }).where(eq(articles.id, articleId));
    return { ok: true, message: "Aucune image retenue — image inchangée." };
  }

  const pending = article.pendingImageCandidates ?? [];
  const match = pending.find((c) => c.url === choice.url);
  if (match === undefined) return { ok: false, message: "Cette image ne fait pas partie des candidates." };

  await db.transaction(async (tx) => {
    await tx.insert(articleRevisions).values({
      articleId, actorId, action: "image choisie",
      detail: `Image retenue : ${match.url}\n— Image précédente : ${article.featuredImageUrl ?? "(aucune)"}`,
    });
    await tx.update(articles).set({
      featuredImageUrl: match.url,
      imageCredit: choice.credit ?? match.mediaName,
      imageSourceUrl: choice.sourceUrl ?? match.sourceUrl,
      pendingImageCandidates: null,
      updatedAt: new Date(),
    }).where(eq(articles.id, articleId));
  });
  return { ok: true, message: "Image à la une mise à jour." };
}

export async function readRegenJob(jobId: string): Promise<RegenJobView | null> {
  const [job] = await db.select().from(regenJobs).where(eq(regenJobs.id, jobId));
  if (!job) return null;
  const items = await db.select().from(regenJobItems)
    .where(eq(regenJobItems.jobId, jobId)).orderBy(regenJobItems.title);
  return {
    id: job.id, total: job.total, done: job.done,
    status: job.status as RegenJobView["status"],
    imageMode: job.imageMode as RegenJobView["imageMode"],
    items: items.map((i) => ({
      id: i.id, articleId: i.articleId, title: i.title,
      stage: i.stage as RegenJobView["items"][number]["stage"],
      status: i.status as RegenJobView["items"][number]["status"],
      message: i.message,
    })),
  };
}
