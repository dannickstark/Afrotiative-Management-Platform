"use server";
import { db, articles, articleRevisions, articleSources, wpCategories } from "@/db";
import { eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { publishArticle } from "@/lib/wp/publish";
import { blockingGapsForArticle, MISSING_LABEL } from "@/lib/pipeline/completeness";
import { bulkIdsSchema, bulkRejectSchema } from "@/lib/validation";
import { z } from "zod";

export async function quickApprove(id: string) {
  const user = await requireUser();
  requirePermission(user.role, "article", "publish");
  // Field validation (category required, image credit required when a featured
  // image is set) is enforced inside publishArticle itself — no need to
  // duplicate it here; a failed check surfaces as res.ok === false below with
  // the same French message.
  const res = await publishArticle(id, user.id);
  if (!res.ok) throw new Error(res.message);
  revalidatePath("/queue"); revalidatePath("/dashboard");
  return res;
}

const rejectSchema = z.object({ id: z.string().uuid(), reason: z.string().min(3, "Motif requis") });
export async function quickReject(input: { id: string; reason: string }) {
  const user = await requireUser();
  requirePermission(user.role, "article", "reject");
  const { id, reason } = rejectSchema.parse(input);
  await db.update(articles).set({ status: "rejected", rejectReason: reason, updatedAt: new Date() }).where(eq(articles.id, id));
  await db.insert(articleRevisions).values({ articleId: id, actorId: user.id, action: "rejeté", detail: reason });
  revalidatePath("/queue"); revalidatePath("/dashboard");
}

export type BulkResult = {
  ok: string[];
  failed: { id: string; title: string; message: string }[];
};

// Charge, pour chaque identifiant, tout ce qu'il faut pour décider SANS appel réseau : titre
// (pour un rapport d'échec lisible) et colonnes de complétude.
async function loadBulkCandidates(ids: string[]) {
  return db.select({
    id: articles.id, title: articles.title,
    categoryId: articles.categoryId, categoryName: wpCategories.name,
    featuredImageUrl: articles.featuredImageUrl, imageCredit: articles.imageCredit,
    imageSourceUrl: articles.imageSourceUrl,
    sourceCount: sql<number>`(select count(*) from ${articleSources} s where s.article_id = ${articles.id})`,
  }).from(articles)
    .leftJoin(wpCategories, eq(articles.categoryId, wpCategories.id))
    .where(inArray(articles.id, ids));
}

/**
 * Approuve ET PUBLIE sur WordPress une sélection d'articles — même sémantique que quickApprove,
 * appliquée en série. Séquentiel à dessein : chaque publication est un aller-retour réseau vers
 * WordPress ; en parallèle on s'exposerait au throttling et le rapport d'échec deviendrait
 * illisible.
 *
 * Ne lève pas sur un échec unitaire : le retour partiel EST le résultat attendu. Une publication
 * en lot échoue rarement en bloc, et l'appelant doit pouvoir dire lesquels sont passés.
 */
export async function bulkApprove(ids: string[]): Promise<BulkResult> {
  const user = await requireUser();
  requirePermission(user.role, "article", "publish");
  const parsed = bulkIdsSchema.parse(ids);

  const rows = await loadBulkCandidates(parsed);
  const result: BulkResult = { ok: [], failed: [] };

  for (const row of rows) {
    // Pré-filtrage : inutile d'aller jusqu'à WordPress pour en revenir refusé. Mêmes règles que
    // publishArticle, puisque c'est le même module qui les porte.
    const gaps = blockingGapsForArticle({
      categoryId: row.categoryId, categoryName: row.categoryName,
      featuredImageUrl: row.featuredImageUrl, imageCredit: row.imageCredit,
      imageSourceUrl: row.imageSourceUrl, sourceCount: Number(row.sourceCount),
    });
    if (gaps.length > 0) {
      result.failed.push({
        id: row.id, title: row.title,
        message: `Informations manquantes : ${gaps.map((g) => MISSING_LABEL[g]).join(", ")}.`,
      });
      continue;
    }

    const res = await publishArticle(row.id, user.id);
    if (res.ok) result.ok.push(row.id);
    else result.failed.push({ id: row.id, title: row.title, message: res.message });
  }

  revalidatePath("/queue"); revalidatePath("/dashboard");
  return result;
}

export async function bulkReject(input: { ids: string[]; reason: string }): Promise<BulkResult> {
  const user = await requireUser();
  requirePermission(user.role, "article", "reject");
  const { ids, reason } = bulkRejectSchema.parse(input);

  const rows = await db.select({ id: articles.id, title: articles.title })
    .from(articles).where(inArray(articles.id, ids));
  const result: BulkResult = { ok: [], failed: [] };

  for (const row of rows) {
    try {
      await db.update(articles)
        .set({ status: "rejected", rejectReason: reason, updatedAt: new Date() })
        .where(eq(articles.id, row.id));
      await db.insert(articleRevisions)
        .values({ articleId: row.id, actorId: user.id, action: "rejeté", detail: reason });
      result.ok.push(row.id);
    } catch (e) {
      result.failed.push({
        id: row.id, title: row.title,
        message: e instanceof Error ? e.message : "Échec du rejet.",
      });
    }
  }

  revalidatePath("/queue"); revalidatePath("/dashboard");
  return result;
}
