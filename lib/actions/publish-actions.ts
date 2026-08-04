"use server";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { revalidatePath } from "next/cache";
import { unpublishArticle, republishArticle } from "@/lib/wp/publish";

export async function unpublishArticleAction(id: string) {
  const u = await requireUser();
  requirePermission(u.role, "article", "publish");
  const res = await unpublishArticle(id);
  revalidatePath(`/article/${id}`);
  revalidatePath("/queue");
  revalidatePath("/published");
  revalidatePath("/dashboard");
  return res;
}

export async function republishArticleAction(id: string) {
  const u = await requireUser();
  requirePermission(u.role, "article", "publish");
  const res = await republishArticle(id);
  revalidatePath(`/article/${id}`);
  revalidatePath("/dashboard");
  return res;
}

// System-triggered (the /api/publish/due cron route, bearer-secret gated — no interactive user,
// so no requireUser/requirePermission here). Publishes every already-human-approved, due article.
//
// HUMAN-REVIEW GATE: the WHERE clause selects ONLY status='approved' — never 'pending'/'draft'/
// 'in_review', even if such a row somehow carries a past scheduledAt. An article only ever reaches
// 'approved' via the human review flow (SP4), so this query can never auto-publish something a
// human hasn't signed off on. Per-article try/catch: one article's failure (network, WP error,
// missing category, etc.) tallies as 'failed' and does not stop the rest of the batch.
//
// Dynamic imports (db/drizzle/publishArticle) mirror the /api/pipeline/run route's pattern — kept
// out of this module's static import graph so build-time bundling of unrelated exports in this
// "use server" file can't be affected by the WordPress publish pipeline's transitive deps.
export async function publishDueArticles(): Promise<{ published: number; failed: number }> {
  const { db, articles } = await import("@/db");
  const { and, eq, lte, isNotNull } = await import("drizzle-orm");
  const { publishArticle } = await import("@/lib/wp/publish");

  const due = await db
    .select({ id: articles.id })
    .from(articles)
    .where(
      and(
        eq(articles.status, "approved"),
        isNotNull(articles.scheduledAt),
        lte(articles.scheduledAt, new Date()),
      ),
    );

  let published = 0;
  let failed = 0;
  for (const a of due) {
    try {
      const r = await publishArticle(a.id);
      r.ok ? published++ : failed++;
    } catch {
      failed++;
    }
  }
  return { published, failed };
}
