"use server";
import { db, articles, articleTags, articleRevisions } from "@/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { saveDraftSchema, type SaveDraftInput, regenerateFieldsSchema, improveInputSchema, type RegenerateFieldsInput, type ImproveActionInput, fixFieldsSchema, type FixFieldsInput } from "@/lib/validation";
import { isLockActive } from "@/lib/lock";
import { publishArticle } from "@/lib/wp/publish";
import { sanitizeArticleHtml } from "@/lib/sanitize";
import type { ArticleDraft } from "@/lib/ai/schema";
import type { MissingField } from "@/lib/pipeline/completeness";
import { z } from "zod";

export async function acquireLock(id: string) {
  const user = await requireUser();
  const [a] = await db.select({ lockedBy: articles.lockedBy, lockedAt: articles.lockedAt }).from(articles).where(eq(articles.id, id));
  const held = a && a.lockedBy && a.lockedBy !== user.id && isLockActive(a.lockedAt);
  if (held && user.role !== "admin") return { ok: false as const, heldBy: a!.lockedBy! };
  await db.update(articles).set({ lockedBy: user.id, lockedAt: new Date() }).where(eq(articles.id, id));
  return { ok: true as const };
}
export async function refreshLock(id: string) {
  const user = await requireUser();
  await db.update(articles).set({ lockedAt: new Date() }).where(and(eq(articles.id, id), eq(articles.lockedBy, user.id)));
}
export async function releaseLock(id: string) {
  const user = await requireUser();
  await db.update(articles).set({ lockedBy: null, lockedAt: null }).where(and(eq(articles.id, id), eq(articles.lockedBy, user.id)));
}

export async function saveDraft(input: SaveDraftInput) {
  const user = await requireUser();
  requirePermission(user.role, "article", "edit");
  const data = saveDraftSchema.parse(input);
  // Human-edit save path: the TipTap editor's HTML is untrusted client input, so it's sanitized
  // here before it ever reaches the DB (script/style/iframe/img/on* stripped, links get a forced
  // rel). The pipeline's own AI-generated bodyHtml is sanitized separately — see SP4 Task 6.
  const bodyHtml = sanitizeArticleHtml(data.bodyHtml);
  await db.update(articles).set({
    title: data.title, bodyHtml, excerpt: data.excerpt,
    categoryId: data.categoryId, featuredImageUrl: data.featuredImageUrl,
    imageCredit: data.imageCredit, imageSourceUrl: data.imageSourceUrl, updatedAt: new Date(),
  }).where(eq(articles.id, data.id));
  await db.delete(articleTags).where(eq(articleTags.articleId, data.id));
  if (data.tags.length) await db.insert(articleTags).values(data.tags.map((t) => ({ articleId: data.id, tagName: t.tagName, isNew: t.isNew })));
  await db.insert(articleRevisions).values({ articleId: data.id, actorId: user.id, action: "modifié" });
  revalidatePath(`/article/${data.id}`);
}

const rejectSchema = z.object({ id: z.string().uuid(), reason: z.string().min(3, "Motif requis") });
export async function rejectArticle(input: { id: string; reason: string }) {
  const user = await requireUser();
  requirePermission(user.role, "article", "reject");
  const { id, reason } = rejectSchema.parse(input);
  await db.update(articles).set({ status: "rejected", rejectReason: reason, updatedAt: new Date() }).where(eq(articles.id, id));
  await db.insert(articleRevisions).values({ articleId: id, actorId: user.id, action: "rejeté", detail: reason });
  revalidatePath(`/article/${id}`); revalidatePath("/queue");
}

// Real regeneration: re-extract every existing source, regenerate a full draft, and apply only
// the checked fields. RBAC runs FIRST (cheap, statically-imported) — every subsequent import is
// dynamic so the jsdom-heavy extraction/generation graph never enters this "use server" module's
// static analysis (mirrors reprocessRawItem in lib/actions/pipeline-actions.ts).
export async function regenerate(articleId: string, fields: RegenerateFieldsInput): Promise<{ ok: boolean; message: string }> {
  const user = await requireUser();
  requirePermission(user.role, "article", "regenerate");
  const parsed = regenerateFieldsSchema.safeParse(fields);
  if (!parsed.success) return { ok: false, message: "Sélectionnez au moins un champ à régénérer." };

  const { articleSources, wpCategories } = await import("@/db");
  const [article] = await db.select().from(articles).where(eq(articles.id, articleId));
  if (!article) return { ok: false, message: "Article introuvable." };
  const sources = await db.select().from(articleSources).where(eq(articleSources.articleId, articleId));
  if (sources.length === 0) return { ok: false, message: "Aucune source à régénérer." };

  const { extractExternal } = await import("@/lib/extract");
  const extracted: { mediaName: string; url: string; text: string; images?: string[] }[] = [];
  const candidateImages: string[] = [];
  for (const s of sources) {
    try {
      const r = await extractExternal(s.url);
      if (r.text.trim().length > 0) { extracted.push({ mediaName: s.mediaName, url: s.url, text: r.text }); candidateImages.push(...r.images); }
    } catch (e) {
      console.warn(`[regenerate] extraction échouée pour ${s.url}: ${(e as Error).message}`);
    }
  }
  if (extracted.length === 0) return { ok: false, message: "Impossible d'extraire les sources (indisponibles ou extracteur non configuré)." };

  const { generateArticle } = await import("@/lib/ai/generate-article");
  const categoryNames = (await db.select({ name: wpCategories.name }).from(wpCategories)).map((c) => c.name);
  const { draft, via } = await generateArticle({ sources: extracted, candidateImages, categories: categoryNames });
  if (via === "mock") return { ok: false, message: "Aucun fournisseur IA configuré — régénération impossible." };

  const { applyRegeneration } = await import("@/lib/pipeline/regenerate");
  await applyRegeneration({
    articleId, prior: { title: article.title, bodyHtml: article.bodyHtml, featuredImageUrl: article.featuredImageUrl, confidenceFlags: article.confidenceFlags },
    draft, fields: parsed.data, sourceCount: extracted.length, categoryNames, actorId: user.id,
  });

  revalidatePath(`/article/${articleId}`); revalidatePath("/queue");
  return { ok: true, message: "Article régénéré — déposé en revue." };
}

// AI-assisted body rewrite driven by an optional editor instruction. Reuses applyRegeneration
// with a body-only "draft" (fields:{body:true, ...false}) so the same selective-write, revision,
// re-embed/re-score machinery applies — only tagged with a distinct revisionAction for
// traceability in the article history.
export async function improveWithAi(articleId: string, input?: ImproveActionInput): Promise<{ ok: boolean; message: string }> {
  const user = await requireUser();
  requirePermission(user.role, "article", "regenerate");
  const instruction = improveInputSchema.safeParse(input ?? {});
  if (!instruction.success) return { ok: false, message: "Instruction invalide." };

  const { articleSources } = await import("@/db");
  const [article] = await db.select().from(articles).where(eq(articles.id, articleId));
  if (!article) return { ok: false, message: "Article introuvable." };

  const { improveArticleBody } = await import("@/lib/ai/improve-article");
  const { bodyHtml, via } = await improveArticleBody({ title: article.title, bodyHtml: article.bodyHtml, instruction: instruction.data.instruction });
  if (via === "mock") return { ok: false, message: "Aucun fournisseur IA configuré — amélioration impossible." };

  // Reuse applyRegeneration with a body-only "draft": only bodyHtml is applied (fields.body=true).
  const sources = await db.select().from(articleSources).where(eq(articleSources.articleId, articleId));
  const { applyRegeneration } = await import("@/lib/pipeline/regenerate");
  await applyRegeneration({
    articleId, prior: { title: article.title, bodyHtml: article.bodyHtml, featuredImageUrl: article.featuredImageUrl, confidenceFlags: article.confidenceFlags },
    draft: {
      title: article.title, bodyHtml, excerpt: article.excerpt ?? "", category: "", tags: [],
      featuredImageUrl: article.featuredImageUrl, imageCredit: article.imageCredit, imageSourceUrl: article.imageSourceUrl,
      confidence: (article.confidenceFlags ?? { categoryUncertain: false, imageMissing: false, clusterUncertain: false }) as ArticleDraft["confidence"],
    },
    fields: { title: false, body: true, excerpt: false, category: false, tags: false, image: false },
    sourceCount: sources.length, categoryNames: [], actorId: user.id,
    revisionAction: "amélioré par IA",
  });

  revalidatePath(`/article/${articleId}`); revalidatePath("/queue");
  return { ok: true, message: "Corps amélioré — déposé en revue." };
}

export async function approveAndPublish(id: string) {
  const user = await requireUser();
  requirePermission(user.role, "article", "publish");
  const [a] = await db.select().from(articles).where(eq(articles.id, id));
  if (!a) throw new Error("Article introuvable.");
  // La garde de complétude n'est PAS dupliquée ici : publishArticle (lib/wp/publish.ts) est
  // l'unique point d'application du refus de publication, dérivé de blockingGapsForArticle.
  // Un second contrôle ici pourrait diverger (message obsolète) sans jamais devenir plus strict.
  const res = await publishArticle(id, user.id);
  if (!res.ok) throw new Error(res.message);
  revalidatePath(`/article/${id}`); revalidatePath("/queue"); revalidatePath("/dashboard");
  return res;
}

const scheduleSchema = z.object({ id: z.string().uuid(), at: z.coerce.date() });
export async function schedule(input: { id: string; at: Date }) {
  const user = await requireUser();
  requirePermission(user.role, "article", "publish");
  const { id, at } = scheduleSchema.parse(input);
  await db.update(articles).set({ status: "approved", scheduledAt: at, updatedAt: new Date() }).where(eq(articles.id, id));
  await db.insert(articleRevisions).values({ articleId: id, actorId: user.id, action: "planifié" });
  revalidatePath(`/article/${id}`);
}

/**
 * Correction ciblée des informations manquantes, depuis /queue (fix-popover) ou ailleurs.
 * Écrit UNIQUEMENT les champs fournis, puis RECALCULE articles.missing_fields avec le même
 * module que le pipeline — c'est ce qui garantit que le badge de la file, l'encadré de l'aperçu
 * et le refus de publication racontent tous la même chose.
 */
export async function fixArticleFields(
  input: FixFieldsInput,
): Promise<{ ok: boolean; message: string; missingFields: MissingField[] }> {
  const user = await requireUser();
  requirePermission(user.role, "article", "edit");
  const data = fixFieldsSchema.parse(input);

  const { articleSources, wpCategories, articleTags } = await import("@/db");
  const { checkCompleteness, sortMissingFields } = await import("@/lib/pipeline/completeness");

  // Seuls les champs réellement fournis entrent dans le SET — un champ absent garde sa valeur.
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (data.categoryId !== undefined) patch.categoryId = data.categoryId;
  if (data.featuredImageUrl !== undefined) patch.featuredImageUrl = data.featuredImageUrl;
  if (data.imageCredit !== undefined) patch.imageCredit = data.imageCredit;
  if (data.imageSourceUrl !== undefined) patch.imageSourceUrl = data.imageSourceUrl;
  await db.update(articles).set(patch).where(eq(articles.id, data.id));

  // Relecture APRÈS écriture : le recalcul doit porter sur l'état réel de la ligne, jamais sur
  // une reconstitution en mémoire de ce qu'on croit avoir écrit.
  const [row] = await db.select({
    category: wpCategories.name, bodyHtml: articles.bodyHtml, excerpt: articles.excerpt,
    featuredImageUrl: articles.featuredImageUrl, imageCredit: articles.imageCredit,
    imageSourceUrl: articles.imageSourceUrl, confidenceFlags: articles.confidenceFlags,
  }).from(articles)
    .leftJoin(wpCategories, eq(articles.categoryId, wpCategories.id))
    .where(eq(articles.id, data.id)).limit(1);
  if (!row) return { ok: false, message: "Article introuvable.", missingFields: [] };

  const [sources, tags, allCategories] = await Promise.all([
    db.select({ mediaName: articleSources.mediaName, url: articleSources.url })
      .from(articleSources).where(eq(articleSources.articleId, data.id)),
    db.select({ tagName: articleTags.tagName }).from(articleTags).where(eq(articleTags.articleId, data.id)),
    db.select({ name: wpCategories.name }).from(wpCategories),
  ]);

  const categoryNames = allCategories.map((c) => c.name);
  const missingFields = sortMissingFields(checkCompleteness(
    {
      // Une catégorie non résolue donne category: "" — absente de categoryNames, donc
      // correctement signalée comme manquante.
      category: row.category ?? "",
      bodyHtml: row.bodyHtml, excerpt: row.excerpt ?? "",
      tags: tags.map((t) => t.tagName),
      featuredImageUrl: row.featuredImageUrl, imageCredit: row.imageCredit,
      imageSourceUrl: row.imageSourceUrl,
      // Le doute initial de l'IA sur la catégorie est levé dès qu'un humain en choisit une.
      confidence: data.categoryId !== undefined
        ? { ...row.confidenceFlags, categoryUncertain: false }
        : (row.confidenceFlags ?? {}),
    },
    sources, categoryNames,
  ));

  await db.update(articles).set({ missingFields }).where(eq(articles.id, data.id));
  await db.insert(articleRevisions).values({
    articleId: data.id, actorId: user.id, action: "informations complétées",
    detail: Object.keys(patch).filter((k) => k !== "updatedAt").join(", "),
  });

  revalidatePath("/queue");
  revalidatePath(`/article/${data.id}`);
  return { ok: true, message: "Informations enregistrées.", missingFields };
}
