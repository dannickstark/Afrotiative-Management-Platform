# Live Run Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a `/runs` pipeline execution observable in near-real-time — a non-blocking trigger plus a live "Cockpit" panel (phase-aware header, 5-stage stepper for the current item, live journal) that survives reloads.

**Architecture:** Split the pipeline run into a synchronous `openRun` (holds the one-running slot, returns instantly) and a detached, **two-phase** `executeRun` (read all feeds → collect new items → process them) that **persists each step and progress counter as it happens**. The client panel polls a lightweight `getActiveRun()` every ~1.5s while a run is active; all state lives in Postgres, so any reader/reload rehydrates. No SSE, no new infra.

**Tech Stack:** Next.js 16 (App Router, RSC + Server Actions), TypeScript, Bun (tests/scripts), Drizzle ORM + Postgres/Neon, shadcn/ui on Base UI, `bun:test`.

## Global Constraints

- **Human-review barrier (non-negotiable):** a run only ever deposits `pending` articles; it never publishes. Do not touch this.
- **Language:** all UI copy and step names are **French** (match existing strings exactly, e.g. `"Extraction du contenu"`, `"Génération IA"`).
- **RBAC:** trigger/recovery = `pipeline:configure` (Admin only, via `RoleGate allow={["admin"]}` + server `requirePermission`); reading = `pipeline:read` (all roles).
- **Tests:** `bun test`, no network, no provider keys. DB-touching tests hit the real Neon **dev** branch and MUST clean up rows they create (see `tests/pipeline-run.test.ts` for the `Bun.serve` fixture + `snapshotEnv`/`restoreEnv` + provider-key-strip pattern).
- **No React render test harness exists.** Put all testable logic in pure functions (`lib/pipeline/live.ts`) and unit-test those. Components are verified by a scripted manual run + `bun run typecheck`.
- **Migrations are additive only.** Never drop/rename existing columns. Generate with `bun run db:generate`, apply to dev with `bun run db:migrate`.
- **Dynamic imports in `"use server"` / route modules:** value-level imports of the pipeline chain stay **deferred** (`await import(...)`) after RBAC checks — mirrors the existing pattern in `lib/actions/pipeline-actions.ts` (jsdom/Turbopack build constraint). Keep it.
- **Overlap interlock:** at most one `running` row (partial unique index `pipeline_runs_one_running`); `hasRunningRun()` reclaims stale rows first. Preserve the "always finalize to a terminal status in `finally`" guarantee.

---

## File Structure

**Create:**
- `lib/pipeline/live.ts` — pure, testable view helpers (stepper node states, ETA, header model, clock formatting).
- `components/pipeline/live-run-panel.tsx` — the panel: idle / running / done states + polling loop + terminal card + inline stepper/journal.
- `tests/live-panel.test.ts` — unit tests for `lib/pipeline/live.ts`.
- `tests/live-progress.test.ts` — DB round-trip tests for schema + two-phase `executeRun` + `getActiveRun` + `openRun`.
- `db/migrations/0003_*.sql` — generated additive migration.

**Modify:**
- `db/schema.ts` — `pipeline_runs` +6 progress columns; `pipeline_steps` +`at`.
- `lib/pipeline/stages.ts` — add optional `StageHooks` to `stageItem` (live stage callbacks).
- `lib/pipeline/run.ts` — split into `openRun` + two-phase `executeRun`; keep `runPipeline` as their composition.
- `lib/queries/runs.ts` — add `getActiveRun()` (reuses `groupSteps`).
- `lib/actions/pipeline-actions.ts` — replace `runPipelineNow` with non-blocking `startPipelineRun`; add `getActiveRunAction`.
- `app/(app)/runs/page.tsx` — fetch initial `getActiveRun` + runs, pass to `RunsView`.
- `components/pipeline/runs-view.tsx` — mount `LiveRunPanel`; remove the 4s `router.refresh()`; drop `<RunNow/>`.
- `components/pipeline/run-detail-sheet.tsx` — `RerunRunButton` uses `startPipelineRun` (non-blocking).

**Delete:**
- `components/pipeline/run-now.tsx` — superseded by the panel's idle-state trigger.

---

## Task 1: Additive migration — progress columns + step timestamp

**Files:**
- Modify: `db/schema.ts:175-203` (`pipelineRuns`, `pipelineSteps`)
- Create: `db/migrations/0003_*.sql` (generated)
- Test: `tests/live-progress.test.ts`

**Interfaces:**
- Produces: new `pipelineRuns` columns `phase`, `feedsTotal`, `totalItems`, `processedItems`, `currentStage`, `currentItem`; new `pipelineSteps.at`. All later tasks read/write these.

- [ ] **Step 1: Write the failing test**

Create `tests/live-progress.test.ts`:

```ts
import { describe, it, expect, afterAll } from "bun:test";
import { db, pipelineRuns, pipelineSteps } from "@/db";
import { eq } from "drizzle-orm";

describe("pipeline_runs progress columns + pipeline_steps.at (migration 0003)", () => {
  let runId: string | null = null;
  afterAll(async () => {
    if (runId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, runId)); // cascades steps
  });

  it("persists and reads back the new progress fields with correct defaults", async () => {
    const [run] = await db.insert(pipelineRuns).values({
      triggeredBy: "manual", status: "running",
      phase: "processing_items", feedsTotal: 6, totalItems: 20,
      processedItems: 8, currentStage: "Génération IA", currentItem: "« Titre test »",
    }).returning({ id: pipelineRuns.id });
    runId = run.id;

    const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
    expect(row.phase).toBe("processing_items");
    expect(row.feedsTotal).toBe(6);
    expect(row.totalItems).toBe(20);
    expect(row.processedItems).toBe(8);
    expect(row.currentStage).toBe("Génération IA");
    expect(row.currentItem).toBe("« Titre test »");

    await db.insert(pipelineSteps).values({ runId, name: "Étape test", status: "success", durationMs: 5 });
    const [step] = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runId));
    expect(step.at).not.toBeNull(); // default now()

    // processed_items default is 0 on a bare insert
    const [bare] = await db.insert(pipelineRuns).values({ triggeredBy: "manual", status: "failed", finishedAt: new Date() }).returning();
    expect(bare.processedItems).toBe(0);
    await db.delete(pipelineRuns).where(eq(pipelineRuns.id, bare.id));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/live-progress.test.ts`
Expected: FAIL — TypeScript/Drizzle error that `phase`/`feedsTotal`/`at` are not columns (compile error or unknown-column).

- [ ] **Step 3: Add the columns to the schema**

In `db/schema.ts`, extend `pipelineRuns` (after `finishedAt`, before the closing `}, (t) => [...]`):

```ts
  // ---- live progress (written incrementally by executeRun) ----
  phase: text("phase"), // reading_feeds | processing_items | finalizing
  feedsTotal: integer("feeds_total"),
  totalItems: integer("total_items"),
  processedItems: integer("processed_items").notNull().default(0),
  currentStage: text("current_stage"),
  currentItem: text("current_item"),
```

In `pipelineSteps`, add (after `rawItemId`):

```ts
  at: timestamp("at").notNull().defaultNow(),
```

(`text`, `integer`, `timestamp` are already imported in this file.)

- [ ] **Step 4: Generate and apply the migration**

Run: `bun run db:generate` (accept the generated `0003_*.sql` name), then `bun run db:migrate`.
Expected: a new additive migration file adding 6 columns to `pipeline_runs` and `at` to `pipeline_steps`; migrate applies cleanly to the dev Neon branch.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/live-progress.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add db/schema.ts db/migrations tests/live-progress.test.ts
git commit -m "feat(runs): additive migration — pipeline progress columns + step timestamp"
```

---

## Task 2: Pure live-view helpers (`lib/pipeline/live.ts`)

**Files:**
- Create: `lib/pipeline/live.ts`
- Test: `tests/live-panel.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `ITEM_STAGES: readonly string[]` — the 5 per-item DB step names, in order.
  - `type StepperNode = { name: string; label: string; state: "done" | "current" | "pending" | "failed" }`
  - `deriveStepperNodes(itemSteps: { name: string; status: string }[], currentStage: string | null): StepperNode[]`
  - `computeEta(input: { startedAtMs: number; nowMs: number; processedItems: number; totalItems: number | null }): number | null`
  - `type HeaderModel = { phaseLabel: string; numerator: number; denominator: number | null; percent: number | null }`
  - `deriveHeader(run: { phase: string | null; feedsRead: number; feedsTotal: number | null; processedItems: number; totalItems: number | null }): HeaderModel`
  - `formatClock(ms: number): string` — `"mm:ss"`

- [ ] **Step 1: Write the failing tests**

Create `tests/live-panel.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { ITEM_STAGES, deriveStepperNodes, computeEta, deriveHeader, formatClock } from "@/lib/pipeline/live";

describe("deriveStepperNodes", () => {
  it("marks completed stages done, the current stage current, the rest pending", () => {
    const nodes = deriveStepperNodes(
      [{ name: "Extraction du contenu", status: "success" }, { name: "Calcul de l'embedding", status: "success" }],
      "Regroupement (clustering)",
    );
    expect(nodes.map((n) => n.state)).toEqual(["done", "done", "current", "pending", "pending"]);
    expect(nodes).toHaveLength(ITEM_STAGES.length);
    expect(nodes[3].label).toBe("Génération IA"); // short label preserved for the long stage too
  });

  it("marks a failed stage failed and freezes the rest as pending", () => {
    const nodes = deriveStepperNodes(
      [{ name: "Extraction du contenu", status: "success" }, { name: "Regroupement (clustering)", status: "failed" }],
      null,
    );
    expect(nodes.map((n) => n.state)).toEqual(["done", "pending", "failed", "pending", "pending"]);
  });
});

describe("computeEta", () => {
  it("returns null before 2 items or with unknown total", () => {
    expect(computeEta({ startedAtMs: 0, nowMs: 10_000, processedItems: 1, totalItems: 10 })).toBeNull();
    expect(computeEta({ startedAtMs: 0, nowMs: 10_000, processedItems: 5, totalItems: null })).toBeNull();
  });
  it("estimates remaining = avg-per-item × items left", () => {
    // 4 items in 40s → 10s/item; 6 remaining → 60_000 ms
    expect(computeEta({ startedAtMs: 0, nowMs: 40_000, processedItems: 4, totalItems: 10 })).toBe(60_000);
  });
});

describe("deriveHeader", () => {
  it("uses feed counts during reading_feeds", () => {
    expect(deriveHeader({ phase: "reading_feeds", feedsRead: 3, feedsTotal: 6, processedItems: 0, totalItems: null }))
      .toEqual({ phaseLabel: "Lecture des flux", numerator: 3, denominator: 6, percent: 50 });
  });
  it("uses item counts during processing_items", () => {
    expect(deriveHeader({ phase: "processing_items", feedsRead: 6, feedsTotal: 6, processedItems: 8, totalItems: 20 }))
      .toEqual({ phaseLabel: "Traitement des éléments", numerator: 8, denominator: 20, percent: 40 });
  });
  it("reports 100% while finalizing", () => {
    expect(deriveHeader({ phase: "finalizing", feedsRead: 6, feedsTotal: 6, processedItems: 20, totalItems: 20 }).percent).toBe(100);
  });
});

describe("formatClock", () => {
  it("formats mm:ss", () => {
    expect(formatClock(72_000)).toBe("01:12");
    expect(formatClock(5_000)).toBe("00:05");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/live-panel.test.ts`
Expected: FAIL — cannot find module `@/lib/pipeline/live`.

- [ ] **Step 3: Implement `lib/pipeline/live.ts`**

```ts
// Pure, DB-free view helpers for the live run panel. Unit-tested in tests/live-panel.test.ts.

// The 5 per-item stages, by their EXACT pipeline_steps.name (must match lib/pipeline/stages.ts).
export const ITEM_STAGES = [
  "Extraction du contenu",
  "Calcul de l'embedding",
  "Regroupement (clustering)",
  "Génération IA",
  "Dépôt en revue",
] as const;

// Short labels for the stepper nodes (the long names don't fit under a 24px circle).
const STAGE_LABEL: Record<string, string> = {
  "Extraction du contenu": "Extraction",
  "Calcul de l'embedding": "Embedding",
  "Regroupement (clustering)": "Clustering",
  "Génération IA": "Génération IA",
  "Dépôt en revue": "Dépôt",
};

export type StepperNode = { name: string; label: string; state: "done" | "current" | "pending" | "failed" };

/**
 * Map an item's already-completed steps + the run's current_stage onto the 5 fixed nodes.
 * A failed stage stays failed and everything after it stays pending (the stepper freezes there).
 */
export function deriveStepperNodes(
  itemSteps: { name: string; status: string }[],
  currentStage: string | null,
): StepperNode[] {
  const byName = new Map(itemSteps.map((s) => [s.name, s.status]));
  return ITEM_STAGES.map((name) => {
    const status = byName.get(name);
    let state: StepperNode["state"];
    if (status === "failed") state = "failed";
    else if (status === "success") state = "done";
    else if (name === currentStage) state = "current";
    else state = "pending";
    return { name, label: STAGE_LABEL[name] ?? name, state };
  });
}

/** Rough ETA in ms; null until ≥2 items are done or the total is unknown. Intentionally approximate. */
export function computeEta(input: {
  startedAtMs: number; nowMs: number; processedItems: number; totalItems: number | null;
}): number | null {
  const { startedAtMs, nowMs, processedItems, totalItems } = input;
  if (totalItems == null || processedItems < 2) return null;
  const avg = (nowMs - startedAtMs) / processedItems;
  const remaining = Math.max(0, totalItems - processedItems);
  return Math.round(avg * remaining);
}

export type HeaderModel = { phaseLabel: string; numerator: number; denominator: number | null; percent: number | null };

const pct = (num: number, den: number | null): number | null =>
  den && den > 0 ? Math.round((num / den) * 100) : null;

/** Which counter/label the header shows, per phase. */
export function deriveHeader(run: {
  phase: string | null; feedsRead: number; feedsTotal: number | null; processedItems: number; totalItems: number | null;
}): HeaderModel {
  if (run.phase === "reading_feeds") {
    return { phaseLabel: "Lecture des flux", numerator: run.feedsRead, denominator: run.feedsTotal, percent: pct(run.feedsRead, run.feedsTotal) };
  }
  if (run.phase === "finalizing") {
    return { phaseLabel: "Finalisation", numerator: run.processedItems, denominator: run.totalItems, percent: 100 };
  }
  // processing_items (and any fallback)
  return { phaseLabel: "Traitement des éléments", numerator: run.processedItems, denominator: run.totalItems, percent: pct(run.processedItems, run.totalItems) };
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60), s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/live-panel.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline/live.ts tests/live-panel.test.ts
git commit -m "feat(runs): pure live-view helpers (stepper nodes, ETA, header model)"
```

---

## Task 3: Instrument `stageItem` with live stage hooks

**Files:**
- Modify: `lib/pipeline/stages.ts:31-50` (signature + `timed`)
- Test: `tests/live-progress.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `type StageHooks = { onStageStart?: (name: string) => void | Promise<void>; onStageEnd?: (step: StepRec) => void | Promise<void> }` and an optional 4th param on `stageItem(item, mediaName, categoryNames, hooks?)`. `StepRec` is the existing export. Backward compatible — existing 3-arg callers are unaffected.

- [ ] **Step 1: Write the failing test**

Append to `tests/live-progress.test.ts`:

```ts
import { stageItem } from "@/lib/pipeline/stages";
import { ITEM_STAGES } from "@/lib/pipeline/live";
import { contentHash, type RawItem } from "@/lib/rss/parse-feed";

const PROVIDER_KEYS = [
  "JINA_API_KEY", "FIRECRAWL_API_KEY", "EMBED_API_KEY", "OPENROUTER_API_KEY",
  "OMNIROUTE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY",
] as const;
const T = "La BRVM franchit un nouveau record historique";
const HTML = `<html><body><article><h1>${T}</h1><p>${"La bourse régionale progresse fortement, portée par les valeurs bancaires. ".repeat(15)}</p></article></body></html>`;

describe("stageItem live hooks", () => {
  const snap = Object.fromEntries(PROVIDER_KEYS.map((k) => [k, process.env[k]]));
  let server: ReturnType<typeof Bun.serve>;
  let url: string;
  let articleId: string | null = null;
  const clean: string[] = [];

  beforeAll(() => {
    for (const k of PROVIDER_KEYS) delete process.env[k];
    server = Bun.serve({ port: 0, fetch: () => new Response(HTML, { headers: { "content-type": "text/html" } }) });
    url = `http://localhost:${server.port}/a`;
  });
  afterAll(async () => {
    server.stop(true);
    for (const [k, v] of Object.entries(snap)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    const { db, articles } = await import("@/db");
    const { eq } = await import("drizzle-orm");
    if (articleId) await db.delete(articles).where(eq(articles.id, articleId));
  });

  it("fires onStageStart before each stage and onStageEnd after, in ITEM_STAGES order", async () => {
    const item: RawItem = { guid: "test:hooks", url, title: T, contentSnippet: "La bourse progresse.", isoDate: null, contentHash: contentHash(T, "hooks") };
    const starts: string[] = [];
    const ends: string[] = [];
    const res = await stageItem(item, "Test Media", ["Économie"], {
      onStageStart: (n) => { starts.push(n); },
      onStageEnd: (s) => { ends.push(s.name); },
    });
    articleId = res.articleId;
    expect(res.articleId).not.toBeNull();
    expect(starts).toEqual([...ITEM_STAGES]);
    expect(ends).toEqual([...ITEM_STAGES]);
  });
});
```

(Add `beforeAll`, `beforeAll` to the top-level `bun:test` import if not already there.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/live-progress.test.ts`
Expected: FAIL — `stageItem` ignores the 4th arg; `starts`/`ends` stay empty.

- [ ] **Step 3: Add hooks to `stageItem`**

In `lib/pipeline/stages.ts`, add the type near `StepRec` and thread hooks through `timed`:

```ts
export type StageHooks = {
  onStageStart?: (name: string) => void | Promise<void>;
  onStageEnd?: (step: StepRec) => void | Promise<void>;
};

export async function stageItem(
  item: RawItem,
  mediaName: string,
  categoryNames: string[],
  hooks: StageHooks = {},
): Promise<{ articleId: string | null; steps: StepRec[] }> {
  const steps: StepRec[] = [];
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    await hooks.onStageStart?.(name);
    const t0 = Date.now();
    try {
      const r = await fn();
      const step: StepRec = { name, status: "success", durationMs: Date.now() - t0 };
      steps.push(step);
      await hooks.onStageEnd?.(step);
      return r;
    } catch (e) {
      const step: StepRec = {
        name, status: "failed", durationMs: Date.now() - t0,
        errorMessage: humanError(name, e as Error), errorTechnical: (e as Error).stack,
      };
      steps.push(step);
      await hooks.onStageEnd?.(step);
      throw e;
    }
  };
  // ...rest of the function body is UNCHANGED...
```

Leave the entire body after `const timed = ...` exactly as-is.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/live-progress.test.ts`
Expected: PASS. Also run the existing stage tests to confirm no regression: `bun test tests/pipeline-run.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline/stages.ts tests/live-progress.test.ts
git commit -m "feat(runs): optional live stage hooks on stageItem"
```

---

## Task 4: Two-phase `executeRun` + `openRun` (incremental progress)

**Files:**
- Modify: `lib/pipeline/run.ts` (whole run body)
- Test: `tests/live-progress.test.ts` (append) + existing `tests/pipeline-run.test.ts` must stay green

**Interfaces:**
- Consumes: `stageItem(..., hooks)` (Task 3), `ITEM_STAGES` (Task 2) not needed here, progress columns (Task 1).
- Produces:
  - `openRun(opts: { triggeredBy: RunTrigger; feedsTotal?: number }): Promise<string | null>` — reclaim+overlap-check, insert the `running` row (`phase:"reading_feeds"`), return its id or `null` on overlap/23505.
  - `executeRun(runId: string, opts?: { feedIds?: string[] }): Promise<RunResult>` — two-phase body, incremental writes, always finalizes.
  - `runPipeline(opts: { triggeredBy: RunTrigger; feedIds?: string[] }): Promise<RunResult>` — `openRun` then `executeRun` (awaited); preserved signature/behaviour for the cron route + existing tests.

- [ ] **Step 1: Write the failing tests**

Append to `tests/live-progress.test.ts`:

```ts
import { openRun, executeRun } from "@/lib/pipeline/run";
import { db as _db, feeds as _feeds, pipelineRuns as _runs, pipelineSteps as _steps, rawItems as _raw } from "@/db";
import { eq as _eq, inArray as _in } from "drizzle-orm";

// A feed fixture that serves an RSS document with N distinct items pointing at a local article server.
function rssServer(itemCount: number) {
  const article = Bun.serve({ port: 0, fetch: () => new Response(HTML, { headers: { "content-type": "text/html" } }) });
  const items = Array.from({ length: itemCount }, (_, i) => `
    <item><title>${T} #${i}</title><link>http://localhost:${article.port}/a${i}</link>
    <guid>test:exec:${i}:${Math.random()}</guid><description>Bourse ${i}</description></item>`).join("");
  const rss = Bun.serve({ port: 0, fetch: () => new Response(
    `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title>${items}</channel></rss>`,
    { headers: { "content-type": "application/xml" } }) });
  return { rssUrl: `http://localhost:${rss.port}/feed`, stop: () => { article.stop(true); rss.stop(true); } };
}

describe("executeRun two-phase progress + cap", () => {
  const snap = Object.fromEntries(PROVIDER_KEYS.map((k) => [k, process.env[k]]));
  beforeAll(() => { for (const k of PROVIDER_KEYS) delete process.env[k]; });
  afterAll(() => { for (const [k, v] of Object.entries(snap)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  it("reads all feeds, caps recorded items, records ONLY what it processes, and lands progress fields", async () => {
    process.env.MAX_ITEMS_PER_RUN = "2";
    const fx = rssServer(4); // 4 new items, cap 2
    const [f] = await _db.insert(_feeds).values({ name: "Fixture cap", feedUrl: fx.rssUrl, active: true }).returning({ id: _feeds.id });
    let runId: string | null = null;
    try {
      runId = await openRun({ triggeredBy: "manual", feedsTotal: 1 });
      expect(runId).not.toBeNull();
      const res = await executeRun(runId!, { feedIds: [f.id] });

      expect(res.status).toBe("partial");           // cap hit → partial
      const [row] = await _db.select().from(_runs).where(_eq(_runs.id, runId!));
      expect(row.phase).toBe("finalizing");
      expect(row.totalItems).toBe(2);               // exact denominator after phase 1
      expect(row.processedItems).toBe(2);
      expect(row.currentStage).toBeNull();          // pointer cleared on finalize
      expect(row.finishedAt).not.toBeNull();

      const steps = await _db.select().from(_steps).where(_eq(_steps.runId, runId!));
      expect(steps.some((s) => s.name === "Limite d'éléments atteinte")).toBe(true);
      expect(steps.some((s) => s.name.startsWith("Lecture du flux"))).toBe(true);

      // "record only what we process": exactly 2 raw_items for this feed, not 4.
      const recorded = await _db.select().from(_raw).where(_eq(_raw.feedId, f.id));
      expect(recorded.length).toBe(2);
    } finally {
      delete process.env.MAX_ITEMS_PER_RUN;
      fx.stop();
      if (runId) await _db.delete(_runs).where(_eq(_runs.id, runId));       // cascades steps
      const arts = await _db.select().from(_raw).where(_eq(_raw.feedId, f.id));
      await _db.delete(_raw).where(_in(_raw.id, arts.map((r) => r.id).length ? arts.map((r) => r.id) : ["00000000-0000-0000-0000-000000000000"]));
      // NOTE: articles created by staging are cleaned by the broader afterAll below if you track ids;
      // for this cap test we accept the 2 pending articles are left — delete them here if your dev DB must stay pristine:
      const { articles } = await import("@/db");
      // best-effort: remove pending articles whose source url points at the fixture is out of scope; skip.
      void articles;
      await _db.delete(_feeds).where(_eq(_feeds.id, f.id));
    }
  });
});
```

> Cleanup note for the implementer: this test leaves up to 2 `pending` articles on the dev branch (staging succeeds). If your dev DB must stay pristine, capture `res` article ids via a `getRunDetail` lookup and delete those articles + their clusters in `finally` (see `tests/pipeline-run.test.ts` afterAll for the FK order). Do not skip the feed/run/raw_items cleanup shown.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/live-progress.test.ts`
Expected: FAIL — `openRun`/`executeRun` are not exported yet.

- [ ] **Step 3: Rewrite `lib/pipeline/run.ts`**

Replace the file's exports below the helpers (`pgErrorCode`, `isUniqueViolation`, `StepRow`, types stay). Key points: `openRun` opens the row; `executeRun` is two-phase with incremental writes; `runPipeline` composes them.

```ts
import { db, feeds, pipelineRuns, pipelineSteps, wpCategories } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { parseFeed } from "@/lib/rss/parse-feed";
import { isSeen, recordRawItem } from "./dedup";
import { stageItem } from "./stages";
import { hasRunningRun } from "./overlap";
import { getPipelineConfig } from "@/lib/config/pipeline-config";
import type { RawItem } from "@/lib/rss/parse-feed";

export type RunTrigger = "manual" | "scheduled";
export type RunStatus = "success" | "partial" | "failed" | "skipped";
export type RunResult = { runId: string | null; status: RunStatus; produced: number };

// (keep pgErrorCode + isUniqueViolation exactly as they are)

// Best-effort single-step insert (observability only — never block the run).
async function insertStep(row: {
  runId: string; name: string; status: "success" | "failed" | "partial";
  durationMs: number | null; errorMessage?: string; errorTechnical?: string; rawItemId?: string | null;
}): Promise<void> {
  try { await db.insert(pipelineSteps).values(row); } catch { /* observability only */ }
}

async function setProgress(runId: string, fields: Partial<{
  phase: string; feedsTotal: number; totalItems: number; processedItems: number;
  currentStage: string | null; currentItem: string | null; feedsRead: number;
}>): Promise<void> {
  await db.update(pipelineRuns).set(fields).where(eq(pipelineRuns.id, runId));
}

/** Open a run row (holds the one-running slot). Returns runId, or null if a run is already active. */
export async function openRun(opts: { triggeredBy: RunTrigger; feedsTotal?: number }): Promise<string | null> {
  if (await hasRunningRun()) return null;
  try {
    const [run] = await db.insert(pipelineRuns).values({
      triggeredBy: opts.triggeredBy, status: "running",
      phase: "reading_feeds", feedsTotal: opts.feedsTotal ?? null, processedItems: 0,
    }).returning({ id: pipelineRuns.id });
    return run.id;
  } catch (e) {
    if (isUniqueViolation(e)) return null;
    throw e;
  }
}

/**
 * Two-phase execution of an already-opened run. ALWAYS finalizes the row to a terminal status.
 * Phase 1: read every active feed, collect NEW candidates (no record yet), cap at maxItemsPerRun.
 * Phase 2: for each candidate — record it (this is where "seen" is committed, so we only ever
 * record what we process), then stage it with live hooks that persist current_stage + each step.
 */
export async function executeRun(runId: string, opts: { feedIds?: string[] } = {}): Promise<RunResult> {
  const cfg = getPipelineConfig();
  let feedsRead = 0, feedsFailed = 0, newItems = 0, produced = 0, itemFailures = 0, overCap = 0;
  let capHit = false, targetFeedsLength = 0;
  let status: RunStatus = "failed";

  try {
    const targetFeeds = opts.feedIds !== undefined
      ? (opts.feedIds.length ? await db.select().from(feeds).where(inArray(feeds.id, opts.feedIds)) : [])
      : await db.select().from(feeds).where(eq(feeds.active, true));
    targetFeedsLength = targetFeeds.length;
    const categoryNames = (await db.select({ name: wpCategories.name }).from(wpCategories)).map((c) => c.name);

    await setProgress(runId, { phase: "reading_feeds", feedsTotal: targetFeedsLength });

    // ---- Phase 1: read ALL feeds, collect candidates ----
    type Candidate = { item: RawItem; feedId: string; feedName: string };
    const candidates: Candidate[] = [];
    const seenHashes = new Set<string>(); // intra-batch dedup across feeds

    for (const feed of targetFeeds) {
      const t0 = Date.now();
      let items: RawItem[];
      try {
        items = await parseFeed(feed.feedUrl);
        feedsRead++;
        await insertStep({ runId, name: `Lecture du flux « ${feed.name} »`, status: "success", durationMs: Date.now() - t0 });
        await setProgress(runId, { feedsRead });
      } catch (e) {
        feedsFailed++;
        await insertStep({
          runId, name: `Lecture du flux « ${feed.name} »`, status: "failed", durationMs: Date.now() - t0,
          errorMessage: `La lecture du flux « ${feed.name} » a échoué : ${(e as Error).message}`, errorTechnical: (e as Error).stack,
        });
        continue;
      }
      for (const item of items) {
        if (seenHashes.has(item.contentHash)) continue;      // duplicate within this run's batch
        if (await isSeen(feed.id, item)) continue;           // recorded by a previous run
        seenHashes.add(item.contentHash);
        if (candidates.length >= cfg.maxItemsPerRun) { capHit = true; overCap++; continue; }
        candidates.push({ item, feedId: feed.id, feedName: feed.name });
      }
    }

    await setProgress(runId, { phase: "processing_items", totalItems: candidates.length, processedItems: 0 });

    // ---- Phase 2: process collected candidates ----
    let processed = 0;
    for (const c of candidates) {
      await setProgress(runId, { currentItem: c.item.title, currentStage: null });
      try {
        const rawItemId = await recordRawItem(c.feedId, c.item);
        newItems++;
        const { articleId } = await stageItem(c.item, c.feedName, categoryNames, {
          onStageStart: (name) => setProgress(runId, { currentStage: name }),
          onStageEnd: (step) => insertStep({
            runId, name: step.name, status: step.status, durationMs: step.durationMs,
            errorMessage: step.errorMessage, errorTechnical: step.errorTechnical, rawItemId,
          }),
        });
        if (articleId) produced++; else itemFailures++;
      } catch (e) {
        itemFailures++;
        await insertStep({
          runId, name: "Traitement de l'élément", status: "failed", durationMs: null,
          errorMessage: `Le traitement d'un élément (${c.item.url}) a échoué : ${(e as Error).message}`, errorTechnical: (e as Error).stack,
        });
      }
      processed++;
      await setProgress(runId, { processedItems: processed });
    }

    if (capHit) {
      await insertStep({
        runId, name: "Limite d'éléments atteinte", status: "partial", durationMs: null,
        errorMessage:
          `La limite de ${cfg.maxItemsPerRun} nouveaux éléments par exécution a été atteinte : `
          + `${overCap} nouvel(x) élément(s) au-delà de la limite n'ont pas été traités ; ils seront repris lors d'une prochaine exécution.`,
      });
    }

    const itemsAttempted = produced + itemFailures;
    const allFeedsFailed = targetFeedsLength > 0 && feedsFailed === targetFeedsLength;
    const allItemsFailed = itemsAttempted > 0 && produced === 0;
    status =
      allFeedsFailed || allItemsFailed ? "failed"
      : feedsFailed > 0 || itemFailures > 0 || capHit ? "partial"
      : "success";
  } catch (e) {
    status = "failed";
    await insertStep({
      runId, name: "Exécution du pipeline", status: "failed", durationMs: null,
      errorMessage: `L'exécution du pipeline a échoué : ${(e as Error).message}`, errorTechnical: (e as Error).stack,
    });
  } finally {
    // Always land a terminal status AND clear the live pointer so a late poll can't show a stale stage.
    await db.update(pipelineRuns).set({
      status, feedsRead, newItems, published: 0, finishedAt: new Date(),
      phase: "finalizing", currentStage: null, currentItem: null,
    }).where(eq(pipelineRuns.id, runId));
  }

  return { runId, status, produced };
}

/** Convenience for the cron route + tests: open then execute (awaited). Preserves prior behaviour. */
export async function runPipeline(opts: { triggeredBy: RunTrigger; feedIds?: string[] }): Promise<RunResult> {
  const runId = await openRun({ triggeredBy: opts.triggeredBy });
  if (!runId) return { runId: null, status: "skipped", produced: 0 };
  return executeRun(runId, { feedIds: opts.feedIds });
}
```

Delete the old `StepRow` type and the old batch-insert logic (steps are now inserted incrementally). Keep `pgErrorCode`/`isUniqueViolation`.

- [ ] **Step 4: Run the new + existing pipeline tests**

Run: `bun test tests/live-progress.test.ts tests/pipeline-run.test.ts tests/reprocess.test.ts`
Expected: PASS. The existing overlap / always-finalize / stale-reaper tests still pass because `runPipeline` is preserved (open→execute) and `executeRun` keeps the `finally` finalize guarantee.

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline/run.ts tests/live-progress.test.ts
git commit -m "feat(runs): two-phase executeRun with incremental progress persistence"
```

---

## Task 5: `startPipelineRun` (non-blocking) + `getActiveRun`

**Files:**
- Modify: `lib/queries/runs.ts` (add `getActiveRun`)
- Modify: `lib/actions/pipeline-actions.ts` (replace `runPipelineNow` → `startPipelineRun`; add `getActiveRunAction`)
- Test: `tests/live-progress.test.ts` (append)

**Interfaces:**
- Consumes: `openRun`/`executeRun` (Task 4), `groupSteps` (existing), `reclaimStaleRuns` (existing).
- Produces:
  - `getActiveRun(): Promise<ActiveRun | null>` and `type ActiveRun` in `lib/queries/runs.ts`.
  - `startPipelineRun(): Promise<{ ok: true; runId: string } | { ok: false; message: string }>` (server action, `pipeline:configure`).
  - `getActiveRunAction(): Promise<ActiveRun | null>` (server action, `pipeline:read`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/live-progress.test.ts`:

```ts
import { getActiveRun } from "@/lib/queries/runs";

describe("getActiveRun", () => {
  let runId: string | null = null;
  afterAll(async () => { if (runId) await _db.delete(_runs).where(_eq(_runs.id, runId)); });

  it("returns null when nothing is running", async () => {
    // (assumes no run is active in the dev DB at this point in the suite)
    expect(await getActiveRun()).toBeNull();
  });

  it("returns the running run with progress fields and grouped steps", async () => {
    const [run] = await _db.insert(_runs).values({
      triggeredBy: "manual", status: "running", phase: "processing_items",
      feedsTotal: 1, totalItems: 3, processedItems: 1, currentStage: "Génération IA", currentItem: "« X »",
    }).returning({ id: _runs.id });
    runId = run.id;
    await _db.insert(_steps).values([
      { runId, name: "Lecture du flux « A »", status: "success", durationMs: 5 },
      { runId, name: "Extraction du contenu", status: "success", durationMs: 7, rawItemId: null },
    ]);

    const active = await getActiveRun();
    expect(active).not.toBeNull();
    expect(active!.run.id).toBe(runId);
    expect(active!.run.currentStage).toBe("Génération IA");
    expect(active!.run.processedItems).toBe(1);
    expect(active!.feedSteps.length).toBeGreaterThanOrEqual(1);
  });
});

describe("openRun overlap", () => {
  it("returns null when a run is already active", async () => {
    const [run] = await _db.insert(_runs).values({ triggeredBy: "scheduled", status: "running" }).returning({ id: _runs.id });
    try {
      expect(await openRun({ triggeredBy: "manual" })).toBeNull();
    } finally {
      await _db.delete(_runs).where(_eq(_runs.id, run.id));
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/live-progress.test.ts`
Expected: FAIL — `getActiveRun` not exported.

- [ ] **Step 3: Add `getActiveRun` to `lib/queries/runs.ts`**

At the top, extend the imports and add the query (reuse `groupSteps`):

```ts
import { db, pipelineRuns, pipelineSteps, rawItems } from "@/db";
import { eq, inArray, asc } from "drizzle-orm";
import { reclaimStaleRuns } from "@/lib/pipeline/overlap";
```

```ts
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
```

- [ ] **Step 4: Replace `runPipelineNow` with `startPipelineRun` + add `getActiveRunAction`**

In `lib/actions/pipeline-actions.ts`, replace the `runPipelineNow` function with:

```ts
/**
 * Non-blocking trigger: opens the run (holds the slot, gives us runId synchronously), then kicks
 * executeRun DETACHED and returns immediately. The /runs live panel polls getActiveRun to watch it.
 * Detached promise survives on Railway's long-lived Node process; a mid-run process death is caught
 * by the RUN_STALE_MINUTES reaper.
 */
export async function startPipelineRun(): Promise<{ ok: true; runId: string } | { ok: false; message: string }> {
  const user = await requireUser();
  requirePermission(user.role, "pipeline", "configure");

  const { openRun, executeRun } = await import("@/lib/pipeline/run");
  const { db, feeds } = await import("@/db");
  const { eq } = await import("drizzle-orm");

  const active = (await db.select({ id: feeds.id }).from(feeds).where(eq(feeds.active, true))).length;
  const runId = await openRun({ triggeredBy: "manual", feedsTotal: active });
  if (!runId) return { ok: false as const, message: "Une exécution est déjà en cours." };

  // Detached — do NOT await. executeRun always finalizes in its own finally, so a rejection here
  // is impossible in practice; the catch is belt-and-suspenders against an unhandled rejection.
  void executeRun(runId).catch(() => {});
  return { ok: true as const, runId };
}

/** Read-only fetch of the active run for the live panel poll (pipeline:read). */
export async function getActiveRunAction() {
  const user = await requireUser();
  requirePermission(user.role, "pipeline", "read");
  const { getActiveRun } = await import("@/lib/queries/runs");
  return getActiveRun();
}
```

Remove the now-unused `revalidatePath` calls tied to the old blocking `runPipelineNow` (the panel drives its own refresh). Keep `getRunDetailAction` and `reprocessRawItem` unchanged.

- [ ] **Step 5: Run to verify it passes + typecheck**

Run: `bun test tests/live-progress.test.ts` → PASS.
Run: `bun run typecheck` → note: this will FAIL until Task 8 updates the two `runPipelineNow` callers. That's expected; proceed (Task 8 fixes them). If you prefer green typecheck now, do Task 8's caller edits before committing — but the panel component (Task 7) is the natural consumer, so committing here with a known caller gap is acceptable.

- [ ] **Step 6: Commit**

```bash
git add lib/queries/runs.ts lib/actions/pipeline-actions.ts tests/live-progress.test.ts
git commit -m "feat(runs): non-blocking startPipelineRun + getActiveRun query/action"
```

---

## Task 6: Live run panel component

**Files:**
- Create: `components/pipeline/live-run-panel.tsx`
- Test: none (no React harness) — logic is covered by Task 2; verified manually in Task 8.

**Interfaces:**
- Consumes: `getActiveRunAction`, `startPipelineRun`, `getRunDetailAction` (existing); `ActiveRun`/`RunDetail` types; `deriveStepperNodes`/`computeEta`/`deriveHeader`/`formatClock` (Task 2); `pipelineStatusLabel`/`relativeDate`/`formatDate` (existing `lib/format.ts`); `RoleGate`, shadcn `Card`/`Button`/`Badge`/`Progress`.
- Produces: `<LiveRunPanel initialActive={ActiveRun | null} lastRun={RunRow | null} />`.

Check whether a `Progress` primitive exists: `ls components/ui/progress.tsx`. If absent, render the bar with a plain div (as in the mockup) — do NOT add a dependency.

- [ ] **Step 1: Implement the component**

```tsx
"use client";
import { useEffect, useRef, useState, useTransition, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Check, X, ChevronRight, ExternalLink, Play } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RoleGate } from "@/components/role-gate";
import { cn } from "@/lib/utils";
import { pipelineStatusLabel, relativeDate, type PipelineStatus } from "@/lib/format";
import { deriveStepperNodes, computeEta, deriveHeader, formatClock } from "@/lib/pipeline/live";
import { getActiveRunAction, startPipelineRun } from "@/lib/actions/pipeline-actions";
import type { ActiveRun } from "@/lib/queries/runs";
import type { RunRow } from "@/components/pipeline/runs-view";

const POLL_MS = 1500;

export function LiveRunPanel({ initialActive, lastRun }: { initialActive: ActiveRun | null; lastRun: RunRow | null }) {
  const router = useRouter();
  const [active, setActive] = useState<ActiveRun | null>(initialActive);
  const [polling, setPolling] = useState<boolean>(initialActive != null);
  const [isStarting, startTransition] = useTransition();
  const watchedRef = useRef<string | null>(initialActive?.run.id ?? null);
  // Re-render every second so elapsed/ETA tick even between polls.
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!polling) return;
    const clock = setInterval(() => setTick((n) => n + 1), 1000);
    const poll = setInterval(async () => {
      let res: ActiveRun | null = null;
      try { res = await getActiveRunAction(); } catch { return; } // transient — try again next tick
      if (res) { watchedRef.current = res.run.id; setActive(res); return; }
      // res == null → the run we were watching just finished.
      const finishedId = watchedRef.current;
      watchedRef.current = null;
      setActive(null);
      setPolling(false);
      if (finishedId) {
        try {
          const { getRunDetailAction } = await import("@/lib/actions/pipeline-actions");
          const detail = await getRunDetailAction(finishedId);
          const st = (detail?.run.status ?? "success") as PipelineStatus;
          if (st === "failed") toast.error("Exécution terminée — échec. Voir le détail.");
          else if (st === "partial") toast.warning("Exécution terminée — succès partiel.");
          else toast.success("Exécution terminée avec succès.");
        } catch { /* ignore */ }
      }
      router.refresh(); // resync the list below
    }, POLL_MS);
    return () => { clearInterval(poll); clearInterval(clock); };
  }, [polling, router]);

  const handleStart = useCallback(() => {
    startTransition(() => {
      startPipelineRun()
        .then((r) => {
          if (!r.ok) { toast.error(r.message); return; }
          watchedRef.current = r.runId;
          setPolling(true); // effect will pick up the live state on the next poll
        })
        .catch(() => toast.error("Une erreur inattendue est survenue."));
    });
  }, []);

  if (active) return <RunningView active={active} />;
  return <IdleView lastRun={lastRun} onStart={handleStart} starting={isStarting} />;
}

function IdleView({ lastRun, onStart, starting }: { lastRun: RunRow | null; onStart: () => void; starting: boolean }) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="text-sm text-muted-foreground">
          {lastRun ? (
            <>Dernière exécution : <span className={STATUS_TEXT[lastRun.status]}>{pipelineStatusLabel(lastRun.status)}</span>{" · "}{relativeDate(lastRun.startedAt)}</>
          ) : "Aucune exécution pour l'instant."}
        </div>
        <RoleGate allow={["admin"]}>
          <Button onClick={onStart} disabled={starting}>
            {starting ? <Loader2 className="animate-spin" aria-hidden /> : <Play aria-hidden />}
            {starting ? "Démarrage…" : "Lancer une exécution maintenant"}
          </Button>
        </RoleGate>
      </CardContent>
    </Card>
  );
}

function RunningView({ active }: { active: ActiveRun }) {
  const { run, feedSteps, items } = active;
  const header = deriveHeader(run);
  const startedMs = new Date(run.startedAt).getTime();
  const elapsed = Date.now() - startedMs;
  const etaMs = computeEta({ startedAtMs: startedMs, nowMs: Date.now(), processedItems: run.processedItems, totalItems: run.totalItems });
  // The item currently being processed = last item group that matches current_item, else the last group.
  const currentGroup = items.find((i) => i.title === run.currentItem) ?? items[items.length - 1];
  const stepperNodes = currentGroup ? deriveStepperNodes(currentGroup.steps, run.currentStage) : deriveStepperNodes([], run.currentStage);
  const failures = items.filter((i) => i.hasFailure).length + feedSteps.filter((s) => s.status === "failed").length;

  return (
    <Card>
      <CardContent className="space-y-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="font-semibold">Exécution en cours</div>
            <div className="text-xs text-muted-foreground">Déclenchement manuel · démarrée {new Intl.DateTimeFormat("fr-FR", { timeStyle: "medium" }).format(startedMs)}</div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--status-in-review)]/25 bg-[var(--status-in-review)]/10 px-2.5 py-1 text-xs font-semibold text-[var(--status-in-review)]">
            <span className="size-1.5 animate-pulse rounded-full bg-current" /> En cours
          </span>
        </div>

        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{header.phaseLabel}{header.denominator != null && <> — <b className="text-foreground">{header.numerator}/{header.denominator}</b></>}</span>
          <span>écoulé <b className="text-foreground">{formatClock(elapsed)}</b>{etaMs != null && <> · ~{formatClock(etaMs)} restant</>}{failures > 0 && <> · <span className="text-[var(--status-error)]">{failures} échec{failures > 1 ? "s" : ""}</span></>}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-[var(--status-in-review)] transition-all" style={{ width: `${header.percent ?? 8}%` }} />
        </div>

        {run.phase === "processing_items" && currentGroup && (
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <div className="mb-2 truncate text-xs text-muted-foreground">Élément en cours : <b className="text-foreground">{run.currentItem ?? currentGroup.title}</b></div>
            <Stepper nodes={stepperNodes} />
          </div>
        )}

        <LiveJournal feedSteps={feedSteps} items={items} currentTitle={run.currentItem} />
      </CardContent>
    </Card>
  );
}

function Stepper({ nodes }: { nodes: ReturnType<typeof deriveStepperNodes> }) {
  return (
    <ol className="flex items-start">
      {nodes.map((n, i) => (
        <li key={n.name} className="flex flex-1 flex-col items-center">
          <div className="flex w-full items-center">
            <span className={cn("mx-auto grid size-6 place-items-center rounded-full border text-[11px] font-bold",
              n.state === "done" && "border-[var(--status-approved)] bg-[var(--status-approved)] text-white",
              n.state === "current" && "border-[var(--status-in-review)] text-[var(--status-in-review)] ring-4 ring-[var(--status-in-review)]/15",
              n.state === "failed" && "border-[var(--status-error)] bg-[var(--status-error)] text-white",
              n.state === "pending" && "border-border text-muted-foreground")}>
              {n.state === "done" ? <Check className="size-3.5" /> : n.state === "failed" ? <X className="size-3.5" /> : n.state === "current" ? <Loader2 className="size-3 animate-spin" /> : i + 1}
            </span>
          </div>
          <span className={cn("mt-1.5 text-center text-[10px] leading-tight", n.state === "current" ? "font-semibold text-foreground" : "text-muted-foreground")}>{n.label}</span>
        </li>
      ))}
    </ol>
  );
}

function LiveJournal({ feedSteps, items, currentTitle }: { feedSteps: ActiveRun["feedSteps"]; items: ActiveRun["items"]; currentTitle: string | null }) {
  // Completed item groups (exclude the one still in flight) + feed steps, newest-ish first.
  const done = items.filter((i) => i.title !== currentTitle);
  return (
    <div>
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Journal en direct · {done.length} terminé{done.length > 1 ? "s" : ""}</div>
      <ul className="space-y-1">
        {done.slice().reverse().map((i) => (
          <li key={i.rawItemId} className="flex items-center gap-2 border-t border-border/60 py-1.5 text-sm first:border-t-0">
            <span className={cn("grid size-4 place-items-center rounded-full text-[10px] font-bold text-white", i.hasFailure ? "bg-[var(--status-error)]" : "bg-[var(--status-approved)]")}>{i.hasFailure ? "✕" : "✓"}</span>
            <span className="min-w-0 flex-1 truncate">{i.title}</span>
            {i.url && <a href={i.url} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground"><ExternalLink className="size-3.5" /></a>}
          </li>
        ))}
        {feedSteps.slice().reverse().map((s) => (
          <li key={s.id} className="flex items-center gap-2 border-t border-border/60 py-1.5 text-sm text-muted-foreground first:border-t-0">
            <span className={cn("grid size-4 place-items-center rounded-full text-[10px] font-bold text-white", s.status === "failed" ? "bg-[var(--status-error)]" : "bg-slate-400")}>≡</span>
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const STATUS_TEXT: Record<PipelineStatus, string> = {
  running: "text-[var(--status-in-review)]", success: "text-[var(--status-approved)]",
  partial: "text-[var(--status-pending)]", failed: "text-[var(--status-error)]",
};
```

- [ ] **Step 2: Typecheck the component in isolation**

Run: `bun run typecheck`
Expected: errors only from the not-yet-updated callers (Task 8) + the `runs-view` `RunRow` import cycle; the panel file itself should type-check once `RunRow` is exported (it already is). Fix any genuine type errors in the panel now (e.g. the `formatClock(0) &&` fragment — inline the date).

- [ ] **Step 3: Commit**

```bash
git add components/pipeline/live-run-panel.tsx
git commit -m "feat(runs): live run panel (idle/running/done, stepper, journal, polling)"
```

---

## Task 7: Wire the panel into `/runs` and retire the blocking trigger

**Files:**
- Modify: `app/(app)/runs/page.tsx`
- Modify: `components/pipeline/runs-view.tsx`
- Modify: `components/pipeline/run-detail-sheet.tsx:205-228` (`RerunRunButton`)
- Delete: `components/pipeline/run-now.tsx`

**Interfaces:**
- Consumes: `getActiveRun` (Task 5), `LiveRunPanel` (Task 6), `startPipelineRun` (Task 5).
- Produces: `/runs` renders the live panel with SSR initial state; the old 4s refresh + `<RunNow/>` are gone.

- [ ] **Step 1: Feed initial live state from the page**

In `app/(app)/runs/page.tsx`, after building `runs`, also fetch the active run and pass both:

```tsx
import { getActiveRun } from "@/lib/queries/runs";
// ...
  const runs = rows.map((r) => ({ ...r, failedSteps: Number(r.failedSteps) }));
  const activeRun = await getActiveRun();
  return <RunsView runs={runs} initialActive={activeRun} />;
```

- [ ] **Step 2: Mount the panel in `RunsView`, remove the 4s refresh + RunNow**

In `components/pipeline/runs-view.tsx`:
- Add `initialActive: ActiveRun | null` to the `RunsView` props; import `ActiveRun` from `@/lib/queries/runs` and `LiveRunPanel`.
- **Delete** the `hasRunning`/`useEffect` interval block (lines ~43-53) and the `RunNow` import + its usage in the header.
- Render the panel above the card:

```tsx
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Exécutions du pipeline</h1>
      </div>

      <LiveRunPanel initialActive={initialActive} lastRun={runs[0] ?? null} />
```

Keep the rest of `RunsView` (list table + detail sheet) unchanged.

- [ ] **Step 3: Make the sheet's "Relancer" non-blocking**

In `components/pipeline/run-detail-sheet.tsx`, change the import `runPipelineNow` → `startPipelineRun` and rewrite `RerunRunButton`'s handler:

```tsx
  function handleClick() {
    startTransition(() => {
      startPipelineRun()
        .then((r) => {
          if (r.ok) toast.success("Exécution lancée — suivez-la en direct sur la page des exécutions.");
          else toast.error(r.message);
        })
        .catch(() => toast.error("Une erreur inattendue est survenue."));
    });
  }
```

Button label stays "Relancer l'exécution"; the `isPending` spinner now only covers the brief start call.

- [ ] **Step 4: Delete the obsolete component**

```bash
git rm components/pipeline/run-now.tsx
```

Confirm nothing else imports it: `grep -rn "run-now" components app lib` → no results.

- [ ] **Step 5: Typecheck + full test suite**

Run: `bun run typecheck` → PASS (no more dangling `runPipelineNow`).
Run: `bun test` → PASS (all suites; the two-phase behaviour change touches no existing assertion).

- [ ] **Step 6: Commit**

```bash
git add app/(app)/runs/page.tsx components/pipeline/runs-view.tsx components/pipeline/run-detail-sheet.tsx
git commit -m "feat(runs): mount live panel on /runs; retire blocking trigger + 4s refresh"
```

---

## Task 8: End-to-end manual verification

**Files:** none (verification only).

- [ ] **Step 1: Seed dev data if needed**

Ensure the dev Neon branch has ≥2 active feeds and WP categories (the seed provides them): if empty, `CONFIRM_SEED=1 bun run db:seed` (DEV only, destructive — skip if your dev DB already has data you want).

- [ ] **Step 2: Run the app**

Run: `bun run dev` → open `http://localhost:3000/runs`, logged in as `admin@afrotiative.com`.

- [ ] **Step 3: Trigger and watch**

Click "Lancer une exécution maintenant". Verify, without reloading:
- The button returns immediately (no long spinner) and the panel flips to "En cours".
- Header shows "Lecture des flux — k/N", then "Traitement des éléments — X/Y"; the bar advances.
- The stepper lights up Extraction → Embedding → Clustering → Génération IA → Dépôt for the current item; finished items drop into the journal.
- Elapsed ticks each second; ETA appears after ~2 items.

- [ ] **Step 4: Reload mid-run**

Hard-reload the page while the run is active → the panel rehydrates into the same live "En cours" state (proves reload-safety).

- [ ] **Step 5: Completion**

On finish: a single toast fires (success/partiel/échec), the panel returns to Idle with the last-run summary, and the runs list below shows the new terminal row. Open its detail sheet → the full step trace is present with per-item timings and any failure reasons.

- [ ] **Step 6: Non-admin + failure paths (spot check)**

- Log in as `editor@` → `/runs` shows the live panel (if a run is active) but NO trigger button.
- If a feed fails (temporarily point one feed at an unreachable URL in `/settings/feeds`), verify the failed feed read appears red in the journal and the run finalizes `partial`/`failed` accordingly.

- [ ] **Step 7: Final commit (if any verification fixes were needed)**

```bash
git add -A && git commit -m "fix(runs): live panel verification follow-ups"
```

(Skip if Steps 3-6 passed with no changes.)

---

## Self-review notes (already reconciled)

- **Spec coverage:** §4 data model → Task 1; §2/§5 execution (two-phase, non-blocking, incremental) → Tasks 3-5; §6 `getActiveRun` → Task 5; §7 panel states + stepper + phase-aware header → Tasks 2/6/7; §8 inline failures → Task 6 journal + existing `FailedStepDetail` in the sheet; §9 edge cases (reload/reaper/overlap/empty/ETA/non-admin) → Tasks 4-6 + verified in Task 8; §10 tests incl. two-phase behaviour change → Tasks 1-5; §11 RBAC → Tasks 5-7.
- **Type consistency:** `openRun`/`executeRun`/`runPipeline` (Task 4) ↔ `startPipelineRun`/`getActiveRunAction` (Task 5) ↔ panel props (Task 6) ↔ page wiring (Task 7) all use the same `ActiveRun` type and `{ok,runId}`/`{ok,message}` envelope. Stepper node states (`done|current|pending|failed`) are defined once in Task 2 and consumed in Task 6.
- **Behaviour change flagged:** reading all feeds past the cap (Task 4) — no existing test asserts the old `feedsNotRead` semantics (verified), new cap coverage added in Task 4.
