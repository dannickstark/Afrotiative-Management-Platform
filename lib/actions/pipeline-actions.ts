"use server";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { revalidatePath } from "next/cache";
import type { RawItem } from "@/lib/rss/parse-feed";

// Drizzle wraps driver errors in DrizzleQueryError, so the pg SQLSTATE lives on `.cause` (not the
// top-level error) — walk the cause chain to find it. Mirrors lib/pipeline/run.ts's helper; used
// to turn the pipeline_runs_one_running unique violation (23505) into a friendly message rather
// than an unhandled throw. (import type above is erased at build time, so it adds no runtime deps.)
function pgErrorCode(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur != null; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export async function runPipelineNow() {
  const user = await requireUser();
  requirePermission(user.role, "pipeline", "configure");

  // Dynamic import (kept AFTER the RBAC check above): runPipeline() transitively pulls in the
  // extraction chain (jsdom, via @mozilla/readability), whose internal css-tree dependency does
  // a relative require('../data/patch.json') that Turbopack can't statically resolve when this
  // "use server" module is analyzed at build time. Once Task 9 wires this action into a page, a
  // top-level static import would break `bun run build` exactly as it did for the route handler;
  // deferring the load sidesteps that while behaving identically at request time.
  const { runPipeline } = await import("@/lib/pipeline/run");
  const { hasRunningRun } = await import("@/lib/pipeline/overlap");

  // Fast path: avoid opening a run (and its DB round-trips) when one is already in flight.
  // runPipeline() re-checks this itself, so this is a belt-and-suspenders early exit only.
  if (await hasRunningRun()) return { ok: false as const, message: "Une exécution est déjà en cours." };

  const res = await runPipeline({ triggeredBy: "manual" });
  if (res.status === "skipped") return { ok: false as const, message: "Une exécution est déjà en cours." };

  revalidatePath("/runs");
  revalidatePath("/dashboard");
  revalidatePath("/queue");
  return { ok: true as const, ...res };
}

/**
 * Retries one stored raw_items row through the stage chain WITHOUT dedup: unlike the normal
 * ingestion path (isSeen/recordRawItem in lib/pipeline/dedup.ts), this operates directly on the
 * already-recorded row, so a previously-failed or previously-published item can be re-run on
 * demand. Human-review gate still applies — stageItem only ever produces a "pending" article.
 */
export async function reprocessRawItem(
  rawItemId: string
): Promise<{ ok: boolean; message: string; articleId?: string | null }> {
  const user = await requireUser();
  requirePermission(user.role, "pipeline", "configure");

  // Dynamic import (kept AFTER the RBAC check above): see runPipelineNow's comment — stageItem
  // transitively pulls in the jsdom-heavy extraction chain, which breaks `bun run build` under
  // Turbopack if statically imported at the top of this "use server" module.
  const { db, rawItems, feeds, wpCategories, pipelineRuns, pipelineSteps } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const { hasRunningRun } = await import("@/lib/pipeline/overlap");
  const { stageItem } = await import("@/lib/pipeline/stages");

  if (await hasRunningRun()) return { ok: false as const, message: "Une exécution est déjà en cours." };

  const [ri] = await db.select().from(rawItems).where(eq(rawItems.id, rawItemId));
  if (!ri) return { ok: false as const, message: "Élément introuvable." };
  const [feed] = await db.select().from(feeds).where(eq(feeds.id, ri.feedId));
  const cats = (await db.select({ name: wpCategories.name }).from(wpCategories)).map((c) => c.name);

  // Open the "reprocess" run row. Even with the hasRunningRun() check above, two admin-triggered
  // reprocess/run-now calls can slip past it in the same instant; the pipeline_runs_one_running
  // partial unique index then rejects the losing insert (SQLSTATE 23505). Return the friendly
  // message rather than throwing, matching runPipeline()'s handling of the same collision.
  let run: { id: string };
  try {
    [run] = await db.insert(pipelineRuns)
      .values({ triggeredBy: "reprocess", status: "running", feedsRead: 0, newItems: 1, published: 0 })
      .returning({ id: pipelineRuns.id });
  } catch (e) {
    if (pgErrorCode(e) === "23505") return { ok: false as const, message: "Une exécution est déjà en cours." };
    throw e;
  }

  // From here on the run row is "running", occupying the single slot the pipeline_runs_one_running
  // partial unique index allows — a stuck row would block every future run (scheduled AND
  // reprocess) until the RUN_STALE_MINUTES reaper reclaims it. Mirror runPipeline()'s guarantee
  // (lib/pipeline/run.ts) that the row is ALWAYS finalized, even if something in here throws.
  let articleId: string | null = null;
  try {
    // Built from the stored row rather than a fresh RSS parse — this IS the dedup bypass: we
    // never call isSeen()/recordRawItem(), so a raw_items row that already exists (by
    // construction, since we just selected it by id) is staged anyway.
    const item: RawItem = {
      guid: ri.guid, url: ri.url, title: ri.rawTitle ?? "", contentSnippet: ri.rawBody ?? "",
      isoDate: null, contentHash: ri.contentHash,
    };
    const staged = await stageItem(item, feed?.name ?? "Source", cats);
    articleId = staged.articleId;

    // Persist steps best-effort: observability only — a step-insert failure must NEVER block the
    // run's finalization or the returned envelope (the article may already be staged). Same
    // isolated swallow-catch as lib/pipeline/run.ts's step insert.
    if (staged.steps.length) {
      try {
        await db.insert(pipelineSteps).values(staged.steps.map((s) => ({
          runId: run.id, rawItemId, name: s.name, status: s.status, durationMs: s.durationMs,
          errorMessage: s.errorMessage ?? null, errorTechnical: s.errorTechnical ?? null,
        })));
      } catch { /* observability only — never block finalization/return */ }
    }
  } finally {
    await db.update(pipelineRuns)
      .set({ status: articleId ? "success" : "failed", finishedAt: new Date(), newItems: 1, published: 0 })
      .where(eq(pipelineRuns.id, run.id));
  }

  const { revalidatePath } = await import("next/cache");
  revalidatePath("/runs");
  revalidatePath("/queue");
  revalidatePath("/dashboard");

  return articleId
    ? { ok: true as const, message: "Élément retraité — article déposé en revue.", articleId }
    : { ok: false as const, message: "Le retraitement a échoué (voir la trace de l'exécution)." };
}
