import { db, pipelineRuns, pipelineSteps, rawItems } from "@/db";
import { eq, inArray, asc } from "drizzle-orm";
import { reclaimStaleRuns } from "@/lib/pipeline/overlap";

export type Step = {
  id: string; name: string; status: string; rawItemId: string | null;
  errorMessage: string | null; errorTechnical: string | null; durationMs: number | null;
};

/**
 * Pure grouping helper for the run-detail view: splits a run's steps into feed-/run-level steps
 * (no rawItemId) and per-item groups (attributed via rawItemId), joined against a title/url map.
 * Kept pure (no DB access) so it's unit-testable without a database.
 */
export function groupSteps(steps: Step[], meta: Map<string, { title: string; url: string }>) {
  const feedSteps = steps.filter((s) => !s.rawItemId);
  const order: string[] = [];
  const byItem = new Map<string, Step[]>();
  for (const s of steps) {
    if (!s.rawItemId) continue;
    if (!byItem.has(s.rawItemId)) { byItem.set(s.rawItemId, []); order.push(s.rawItemId); }
    byItem.get(s.rawItemId)!.push(s);
  }
  const items = order.map((rawItemId) => ({
    rawItemId,
    title: meta.get(rawItemId)?.title ?? "(élément inconnu)",
    url: meta.get(rawItemId)?.url ?? "",
    steps: byItem.get(rawItemId)!,
    hasFailure: byItem.get(rawItemId)!.some((s) => s.status === "failed"),
  }));
  return { feedSteps, items };
}

export async function getRunDetail(runId: string) {
  const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
  if (!run) return null;
  const steps = (await db.select({
    id: pipelineSteps.id, name: pipelineSteps.name, status: pipelineSteps.status, rawItemId: pipelineSteps.rawItemId,
    errorMessage: pipelineSteps.errorMessage, errorTechnical: pipelineSteps.errorTechnical, durationMs: pipelineSteps.durationMs,
  }).from(pipelineSteps).where(eq(pipelineSteps.runId, runId))) as Step[];
  const itemIds = [...new Set(steps.filter((s) => s.rawItemId).map((s) => s.rawItemId!))];
  const meta = new Map<string, { title: string; url: string }>();
  if (itemIds.length) {
    const rows = await db.select({ id: rawItems.id, title: rawItems.rawTitle, url: rawItems.url })
      .from(rawItems).where(inArray(rawItems.id, itemIds));
    for (const r of rows) meta.set(r.id, { title: r.title ?? "(sans titre)", url: r.url });
  }
  return { run, ...groupSteps(steps, meta) };
}
export type RunDetail = NonNullable<Awaited<ReturnType<typeof getRunDetail>>>;

/**
 * The single currently-running run (or null), with its progress fields and steps-so-far grouped
 * like getRunDetail. Reclaims stale runs first, so a dead run is finalized (→ returns null) rather
 * than shown as forever-running. Polled ~1.5s by the live panel.
 */
export async function getActiveRun() {
  await reclaimStaleRuns();
  const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.status, "running")).limit(1);
  if (!run) return null;
  const steps = (await db.select({
    id: pipelineSteps.id, name: pipelineSteps.name, status: pipelineSteps.status, rawItemId: pipelineSteps.rawItemId,
    errorMessage: pipelineSteps.errorMessage, errorTechnical: pipelineSteps.errorTechnical, durationMs: pipelineSteps.durationMs,
  }).from(pipelineSteps).where(eq(pipelineSteps.runId, run.id)).orderBy(asc(pipelineSteps.at))) as Step[];
  const itemIds = [...new Set(steps.filter((s) => s.rawItemId).map((s) => s.rawItemId!))];
  const meta = new Map<string, { title: string; url: string }>();
  if (itemIds.length) {
    const rows = await db.select({ id: rawItems.id, title: rawItems.rawTitle, url: rawItems.url })
      .from(rawItems).where(inArray(rawItems.id, itemIds));
    for (const r of rows) meta.set(r.id, { title: r.title ?? "(sans titre)", url: r.url });
  }
  return { run, ...groupSteps(steps, meta) };
}
export type ActiveRun = NonNullable<Awaited<ReturnType<typeof getActiveRun>>>;
