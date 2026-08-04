"use server";
import { db, articles, articleTags, articleRevisions, distributions } from "@/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { saveDraftSchema, type SaveDraftInput } from "@/lib/validation";
import { isLockActive } from "@/lib/lock";
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
  await db.update(articles).set({
    title: data.title, bodyHtml: data.bodyHtml, excerpt: data.excerpt,
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

export async function regenerate(id: string) {
  const user = await requireUser();
  requirePermission(user.role, "article", "regenerate");
  // STUB (SP3): mark for regeneration; no AI call yet.
  await db.update(articles).set({ status: "pending", updatedAt: new Date() }).where(eq(articles.id, id));
  await db.insert(articleRevisions).values({ articleId: id, actorId: user.id, action: "renvoyé à l'IA (simulé)" });
  revalidatePath(`/article/${id}`);
  return { stub: true, message: "Régénération simulée — le pipeline IA sera branché en SP3." };
}

export async function approveAndPublish(id: string) {
  const user = await requireUser();
  requirePermission(user.role, "article", "publish");
  const [a] = await db.select().from(articles).where(eq(articles.id, id));
  if (!a) throw new Error("Article introuvable.");
  if (!a.categoryId) throw new Error("Choisissez une catégorie avant de publier.");
  if (a.featuredImageUrl && !a.imageCredit) throw new Error("Le crédit de l'image est obligatoire.");
  await db.update(articles).set({ status: "published", publishedAt: new Date(), updatedAt: new Date(), lockedBy: null, lockedAt: null }).where(eq(articles.id, id));
  await db.insert(distributions).values({ articleId: id, channel: "wordpress", status: "stubbed" });
  await db.insert(articleRevisions).values({ articleId: id, actorId: user.id, action: "approuvé & publié (simulé)" });
  revalidatePath(`/article/${id}`); revalidatePath("/queue"); revalidatePath("/dashboard");
  return { stub: true, message: "Publication simulée — WordPress sera branché en SP5." };
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
