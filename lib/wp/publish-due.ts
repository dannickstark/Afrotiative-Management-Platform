import { db, articles } from "@/db";
import { and, eq, lte, isNotNull } from "drizzle-orm";
import { publishArticle } from "@/lib/wp/publish";

// System-triggered scheduled auto-publish — invoked ONLY by the bearer-secret-gated
// /api/publish/due cron route. This is deliberately a PLAIN server-only module (NO "use server"
// directive), NOT a Next.js server action: it has no auth of its own, so it must never be exposed
// as a directly-invokable RPC. Living here (like lib/pipeline/run.ts vs its bearer route) makes
// that structurally impossible — a plain export can never be registered in the server-action
// manifest, so no client import could ever turn it into an unauthenticated publish trigger.
//
// HUMAN-REVIEW GATE: the WHERE clause selects ONLY status='approved' — never 'pending'/'draft'/
// 'in_review', even if such a row somehow carries a past scheduledAt. An article only ever reaches
// 'approved' via the human review flow (SP4) OR gated auto-approval (SP6, default off, audited via
// article_revisions — see lib/pipeline/auto-publish.ts and stages.ts's persistArticle), so this
// query can never auto-publish something neither a human nor that explicit, admin-configured
// exception has signed off on. This function itself is UNCHANGED by SP6: it still only ever reads
// status='approved', never anything else. Per-article try/catch: one article's failure (network,
// WP error, missing category, etc.) tallies as 'failed' and does not stop the rest of the batch.
export async function publishDueArticles(): Promise<{ published: number; failed: number }> {
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
