# Run Trigger Parameters — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user set per-run parameters (recency cutoff, feed selection, max new items) before launching a pipeline run, with defaults configurable in `/settings/pipeline`.

**Architecture:** Parameters are resolved at trigger time and persisted as a `params` jsonb blob on the `pipeline_runs` row; `executeRun` reads them from the row (so pause/resume + run history work for free). Defaults live in the `pipeline_settings` singleton. A pure helper filters feed items by publish date in phase 1; feed targeting and the item cap already flow through `executeRun`.

**Tech Stack:** Next.js 16 (App Router, Turbopack), Drizzle ORM + Postgres (Neon), Zod, shadcn/ui, `bun test`.

## Global Constraints

- **UI copy is French.** All user-facing strings (labels, toasts, step names) in French, matching the codebase.
- **Human-review barrier stays intact.** No parameter bypasses it — runs only deposit `pending` articles.
- **Migrations are additive and backward-compatible.** `default_max_item_age_hours` defaults to **NULL = no cutoff**, so shipping this changes no behavior until an admin sets a value.
- **Undated items are included** by the recency filter (only items provably older than the cutoff are skipped).
- **Pure helpers take injected time** (`now`/`cutoffAt` as parameters), never call `Date.now()` internally — matches `mergeDailyTrends`/`summarizeRunsWindow`/`filterRuns` in `lib/queries/runs.ts`. This keeps them unit-testable with no DB/DOM.
- **No silent truncation.** Items skipped for recency get a visible `pipeline_steps` row, mirroring the existing "Limite d'éléments atteinte" step.
- **Tests run against the real Neon dev DB** (see `test-setup.ts`); provider keys are stripped so extraction/embedding/LLM fall to mock/readability fallbacks. Run schema migrations before DB-touching tests: `bun run db:generate && bun run db:migrate`.
- **`import type` for cross-boundary types.** Client components and light modules must import server/DB types as `import type` (the `pg` bundle lesson) — never a value import that pulls `@/db`.
- Per `AGENTS.md`: this is a modified Next.js; when touching Next-specific conventions, consult `node_modules/next/dist/docs/` rather than assuming.

---

### Task 1: Pure recency filter helper

**Files:**
- Create: `lib/pipeline/recency.ts`
- Test: `tests/run-params.test.ts`

**Interfaces:**
- Produces: `isWithinRecency(isoDate: string | null, cutoffAt: Date | null): boolean` — `true` = keep the item.

- [ ] **Step 1: Write the failing test**

Create `tests/run-params.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { isWithinRecency } from "@/lib/pipeline/recency";

describe("isWithinRecency", () => {
  const cutoff = new Date("2026-08-05T00:00:00.000Z");

  it("keeps an item published at or after the cutoff", () => {
    expect(isWithinRecency("2026-08-05T00:00:00.000Z", cutoff)).toBe(true); // exact boundary
    expect(isWithinRecency("2026-08-06T12:00:00.000Z", cutoff)).toBe(true);
  });
  it("drops an item published before the cutoff", () => {
    expect(isWithinRecency("2026-08-01T00:00:00.000Z", cutoff)).toBe(false);
  });
  it("keeps an item with no date (undated-include policy)", () => {
    expect(isWithinRecency(null, cutoff)).toBe(true);
  });
  it("keeps an item with an unparseable date", () => {
    expect(isWithinRecency("not-a-date", cutoff)).toBe(true);
  });
  it("keeps everything when there is no cutoff", () => {
    expect(isWithinRecency("1999-01-01T00:00:00.000Z", null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/run-params.test.ts`
Expected: FAIL — cannot resolve `@/lib/pipeline/recency`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/pipeline/recency.ts`:

```ts
// Pure recency predicate for phase-1 candidate filtering (no DB/DOM, time injected). Returns true
// when an item should be KEPT. Undated / unparseable-date items are kept (undated-include policy):
// the cutoff only excludes items we can prove are older than it.
export function isWithinRecency(isoDate: string | null, cutoffAt: Date | null): boolean {
  if (!cutoffAt) return true;         // no cutoff configured
  if (!isoDate) return true;          // no publish date → include
  const t = Date.parse(isoDate);
  if (Number.isNaN(t)) return true;   // unparseable date → treat as undated → include
  return t >= cutoffAt.getTime();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/run-params.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline/recency.ts tests/run-params.test.ts
git commit -m "feat(pipeline): pure isWithinRecency helper for run recency filtering"
```

---

### Task 2: Schema — RunParams type + two columns + migration

**Files:**
- Modify: `db/schema.ts` (add `RunParams` type after `RunCheckpoint` ~line 16; add a column to `pipelineSettings` ~line 279; add a column to `pipelineRuns` ~line 224)
- Create: `drizzle/<generated>.sql` (via `bun run db:generate`)
- Test: `tests/run-params-db.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type RunParams = {
    recency:
      | { kind: "age"; hours: number; cutoffAt: string }
      | { kind: "since"; cutoffAt: string }
      | { kind: "none" };
    feedIds: string[] | null;
    maxItems: number;
  };
  ```
  - `pipelineSettings.defaultMaxItemAgeHours: number | null`
  - `pipelineRuns.params: RunParams | null`

- [ ] **Step 1: Write the failing test**

Create `tests/run-params-db.test.ts`:

```ts
import { describe, it, expect, afterAll } from "bun:test";
import { db, pipelineRuns } from "@/db";
import { eq } from "drizzle-orm";
import type { RunParams } from "@/db";

describe("pipeline_runs.params jsonb round-trip", () => {
  let runId: string | null = null;
  afterAll(async () => { if (runId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, runId)); });

  it("persists and reads back a typed RunParams blob", async () => {
    const params: RunParams = {
      recency: { kind: "age", hours: 48, cutoffAt: "2026-08-04T00:00:00.000Z" },
      feedIds: null,
      maxItems: 20,
    };
    const [row] = await db.insert(pipelineRuns)
      .values({ triggeredBy: "manual", status: "success", finishedAt: new Date(), params })
      .returning({ id: pipelineRuns.id, params: pipelineRuns.params });
    runId = row.id;
    expect(row.params).toEqual(params);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/run-params-db.test.ts`
Expected: FAIL — `params` is not a known column / type `RunParams` not exported.

- [ ] **Step 3: Add the type and columns**

In `db/schema.ts`, after the `RunCheckpoint` type (~line 16) add:

```ts
// ---- run trigger parameters (persisted per run; resolved at trigger time) ----
// Single source of truth for what a run used: recency cutoff (resolved to an instant), the feed
// subset (null = all active feeds), and the item cap. executeRun reads this off the row.
export type RunParams = {
  recency:
    | { kind: "age"; hours: number; cutoffAt: string }  // "last N h" — cutoffAt resolved at open
    | { kind: "since"; cutoffAt: string }               // absolute ISO datetime
    | { kind: "none" };                                  // no cutoff
  feedIds: string[] | null;
  maxItems: number;
};
```

In `pipelineSettings` (after `autoPublishMinSources`, ~line 284) add:

```ts
  // Default recency cutoff (relative, hours) for a run. NULL = no cutoff (backward-compatible ship
  // default). The trigger dialog pre-fills from this; scheduled runs inherit it.
  defaultMaxItemAgeHours: integer("default_max_item_age_hours"),
```

In `pipelineRuns` (after `checkpoint`, ~line 224) add:

```ts
  // Parameters this run used (recency/feeds/maxItems), resolved at trigger time. NULL for runs
  // created before this feature. See RunParams above.
  params: jsonb("params").$type<RunParams>(),
```

(`integer` and `jsonb` are already imported at the top of `db/schema.ts`.)

- [ ] **Step 4: Generate and apply the migration**

Run:
```bash
bun run db:generate
bun run db:migrate
```
Expected: a new `drizzle/*.sql` file adding both columns; migration applies cleanly to the dev DB.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/run-params-db.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
bun run typecheck
git add db/schema.ts drizzle/ tests/run-params-db.test.ts
git commit -m "feat(db): RunParams type + pipeline_runs.params + pipeline_settings.default_max_item_age_hours"
```

---

### Task 3: Zod schema `runParamsSchema`

**Files:**
- Modify: `lib/validation.ts` (add `runParamsSchema` + `RunParamsInput`; near the other pipeline schemas)
- Test: `tests/run-params-schema.test.ts`

**Interfaces:**
- Produces: `runParamsSchema` (zod) and `type RunParamsInput = z.infer<typeof runParamsSchema>`, where
  ```ts
  RunParamsInput = {
    recency?: { kind: "age"; hours: number } | { kind: "since"; at: string } | { kind: "none" };
    feedIds?: string[] | null;
    maxItems?: number;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/run-params-schema.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { runParamsSchema } from "@/lib/validation";

const past = "2026-08-01T00:00:00.000Z";
const future = "3000-01-01T00:00:00.000Z";

describe("runParamsSchema", () => {
  it("accepts an age recency with valid feeds and maxItems", () => {
    const r = runParamsSchema.safeParse({
      recency: { kind: "age", hours: 48 },
      feedIds: ["11111111-1111-1111-1111-111111111111"],
      maxItems: 20,
    });
    expect(r.success).toBe(true);
  });
  it("accepts an absolute 'since' in the past, and 'none', and an empty input", () => {
    expect(runParamsSchema.safeParse({ recency: { kind: "since", at: past } }).success).toBe(true);
    expect(runParamsSchema.safeParse({ recency: { kind: "none" } }).success).toBe(true);
    expect(runParamsSchema.safeParse({}).success).toBe(true);
  });
  it("rejects a non-positive or too-large age", () => {
    expect(runParamsSchema.safeParse({ recency: { kind: "age", hours: 0 } }).success).toBe(false);
    expect(runParamsSchema.safeParse({ recency: { kind: "age", hours: 721 } }).success).toBe(false);
  });
  it("rejects a 'since' date in the future", () => {
    expect(runParamsSchema.safeParse({ recency: { kind: "since", at: future } }).success).toBe(false);
  });
  it("rejects a malformed feed id and an out-of-range maxItems", () => {
    expect(runParamsSchema.safeParse({ feedIds: ["not-a-uuid"] }).success).toBe(false);
    expect(runParamsSchema.safeParse({ maxItems: 0 }).success).toBe(false);
    expect(runParamsSchema.safeParse({ maxItems: 501 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/run-params-schema.test.ts`
Expected: FAIL — `runParamsSchema` not exported.

- [ ] **Step 3: Add the schema**

In `lib/validation.ts`, after `pipelineSettingsSchema`/`PipelineSettingsInput`, add:

```ts
// Per-run trigger parameters (all optional — omitted fields fall back to the settings defaults in
// resolveRunParams). `since` must not be in the future. maxItems capped at a sane ceiling.
export const runParamsSchema = z.object({
  recency: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("age"), hours: z.number().int().positive("Doit être un entier positif").max(720, "Maximum 720 heures (30 jours)") }),
    z.object({ kind: z.literal("since"), at: z.string().datetime("Date/heure invalide") }),
    z.object({ kind: z.literal("none") }),
  ]).optional(),
  feedIds: z.array(z.string().uuid("Identifiant de flux invalide")).nullable().optional(),
  maxItems: z.number().int().positive("Doit être un entier positif").max(500, "Maximum 500 éléments").optional(),
}).refine(
  (v) => v.recency?.kind !== "since" || Date.parse(v.recency.at) <= Date.now(),
  { message: "La date « depuis » ne peut pas être dans le futur.", path: ["recency"] },
);
export type RunParamsInput = z.infer<typeof runParamsSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/run-params-schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/validation.ts tests/run-params-schema.test.ts
git commit -m "feat(validation): runParamsSchema for trigger parameters"
```

---

### Task 4: Param resolution helper (`resolveRunParams` + `cutoffDate`)

**Files:**
- Create: `lib/pipeline/run-params.ts`
- Test: `tests/run-params.test.ts` (append)

**Interfaces:**
- Consumes: `RunParamsInput` (Task 3), `RunParams` (Task 2).
- Produces:
  - `resolveRunParams(input: RunParamsInput | undefined, defaults: RunParamDefaults, now: Date): RunParams`
  - `cutoffDate(params: RunParams): Date | null`
  - `type RunParamDefaults = { defaultMaxItemAgeHours: number | null; maxItemsPerRun: number }`

- [ ] **Step 1: Write the failing test**

Append to `tests/run-params.test.ts`:

```ts
import { resolveRunParams, cutoffDate } from "@/lib/pipeline/run-params";

describe("resolveRunParams", () => {
  const now = new Date("2026-08-06T00:00:00.000Z");
  const defaults = { defaultMaxItemAgeHours: 72, maxItemsPerRun: 20 };

  it("resolves an 'age' input to a cutoff relative to now", () => {
    const p = resolveRunParams({ recency: { kind: "age", hours: 48 } }, defaults, now);
    expect(p.recency).toEqual({ kind: "age", hours: 48, cutoffAt: "2026-08-04T00:00:00.000Z" });
  });
  it("passes an absolute 'since' through as the cutoff", () => {
    const p = resolveRunParams({ recency: { kind: "since", at: "2026-08-05T09:00:00.000Z" } }, defaults, now);
    expect(p.recency).toEqual({ kind: "since", cutoffAt: "2026-08-05T09:00:00.000Z" });
  });
  it("honors an explicit 'none' even when a default exists", () => {
    expect(resolveRunParams({ recency: { kind: "none" } }, defaults, now).recency).toEqual({ kind: "none" });
  });
  it("falls back to the settings default when recency is omitted", () => {
    const p = resolveRunParams(undefined, defaults, now);
    expect(p.recency).toEqual({ kind: "age", hours: 72, cutoffAt: "2026-08-03T00:00:00.000Z" });
  });
  it("yields no cutoff when omitted and the default is null", () => {
    const p = resolveRunParams(undefined, { defaultMaxItemAgeHours: null, maxItemsPerRun: 20 }, now);
    expect(p.recency).toEqual({ kind: "none" });
  });
  it("defaults feedIds to null and maxItems to the settings value, but honors overrides", () => {
    expect(resolveRunParams(undefined, defaults, now).feedIds).toBeNull();
    expect(resolveRunParams(undefined, defaults, now).maxItems).toBe(20);
    const p = resolveRunParams({ feedIds: ["a"], maxItems: 5 }, defaults, now);
    expect(p.feedIds).toEqual(["a"]);
    expect(p.maxItems).toBe(5);
  });
});

describe("cutoffDate", () => {
  it("returns a Date for age/since and null for none", () => {
    expect(cutoffDate({ recency: { kind: "age", hours: 1, cutoffAt: "2026-08-06T00:00:00.000Z" }, feedIds: null, maxItems: 1 }))
      .toEqual(new Date("2026-08-06T00:00:00.000Z"));
    expect(cutoffDate({ recency: { kind: "none" }, feedIds: null, maxItems: 1 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/run-params.test.ts`
Expected: FAIL — cannot resolve `@/lib/pipeline/run-params`.

- [ ] **Step 3: Write the implementation**

Create `lib/pipeline/run-params.ts`:

```ts
import type { RunParams } from "@/db";
import type { RunParamsInput } from "@/lib/validation";

export type RunParamDefaults = { defaultMaxItemAgeHours: number | null; maxItemsPerRun: number };

const HOUR_MS = 3_600_000;

// Resolve a validated (or absent) trigger input against the settings defaults + an injected `now`
// into the RunParams that gets persisted on the run row. Pure: `now` is a parameter, never Date.now().
export function resolveRunParams(
  input: RunParamsInput | undefined,
  defaults: RunParamDefaults,
  now: Date,
): RunParams {
  return {
    recency: resolveRecency(input?.recency, defaults.defaultMaxItemAgeHours, now),
    feedIds: input?.feedIds ?? null,
    maxItems: input?.maxItems ?? defaults.maxItemsPerRun,
  };
}

function resolveRecency(
  input: RunParamsInput["recency"],
  defaultHours: number | null,
  now: Date,
): RunParams["recency"] {
  if (input) {
    if (input.kind === "age") return { kind: "age", hours: input.hours, cutoffAt: new Date(now.getTime() - input.hours * HOUR_MS).toISOString() };
    if (input.kind === "since") return { kind: "since", cutoffAt: input.at };
    return { kind: "none" };
  }
  if (defaultHours == null) return { kind: "none" };
  return { kind: "age", hours: defaultHours, cutoffAt: new Date(now.getTime() - defaultHours * HOUR_MS).toISOString() };
}

// The absolute instant the phase-1 filter compares against (null = no cutoff).
export function cutoffDate(params: RunParams): Date | null {
  return params.recency.kind === "none" ? null : new Date(params.recency.cutoffAt);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/run-params.test.ts`
Expected: PASS (all `isWithinRecency` + `resolveRunParams` + `cutoffDate` tests).

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline/run-params.ts tests/run-params.test.ts
git commit -m "feat(pipeline): resolveRunParams + cutoffDate (defaulting + cutoff resolution)"
```

---

### Task 5: Wire params into `openRun` + `executeRun` (phase-1 filtering)

**Files:**
- Modify: `lib/pipeline/run.ts` (imports; `openRun` signature ~line 103; `executeRun` top-of-try ~line 166–283; candidate loop ~line 254–260; cap step ~line 488–495)
- Test: `tests/run-recency-e2e.test.ts`

**Interfaces:**
- Consumes: `isWithinRecency` (Task 1), `cutoffDate` (Task 4), `RunParams` (Task 2).
- Produces: `openRun(opts: { triggeredBy: RunTrigger; feedsTotal?: number; params?: RunParams }): Promise<string | null>` — `executeRun` reads `run.params` from the row.

- [ ] **Step 1: Write the failing test**

Create `tests/run-recency-e2e.test.ts` (network-free; a local RSS+article fixture; provider keys stripped so extraction/embedding/LLM use mock/readability):

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, feeds, rawItems, pipelineRuns, pipelineSteps, articles, articleSources, clusters, pipelineSettings } from "@/db";
import { eq, inArray, like } from "drizzle-orm";
import { openRun, executeRun } from "@/lib/pipeline/run";
import type { RunParams } from "@/db";

const PROVIDER_KEYS = [
  "JINA_API_KEY", "FIRECRAWL_API_KEY", "EMBED_API_KEY", "OPENROUTER_API_KEY",
  "OMNIROUTE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY",
] as const;
function snapshotEnv(keys: readonly string[]) { return Object.fromEntries(keys.map((k) => [k, process.env[k]])); }
function restoreEnv(snap: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(snap)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}
const ARTICLE_HTML = `<html><body><article><h1>Titre</h1><p>${"Contenu régional de référence. ".repeat(20)}</p></article></body></html>`;

describe("executeRun — phase-1 recency filter", () => {
  const envSnap = snapshotEnv(PROVIDER_KEYS);
  let settingsSnapshot: typeof pipelineSettings.$inferSelect | undefined;
  let article: ReturnType<typeof Bun.serve>;
  let rss: ReturnType<typeof Bun.serve>;
  let feedId: string;
  let runId: string | null = null;
  let recentUrl = "";

  beforeAll(async () => {
    for (const k of PROVIDER_KEYS) delete process.env[k];
    article = Bun.serve({ port: 0, fetch: () => new Response(ARTICLE_HTML, { headers: { "content-type": "text/html" } }) });
    recentUrl = `http://localhost:${article.port}/recent`;
    const oldDate = new Date(Date.now() - 10 * 24 * 3600_000).toUTCString();   // 10 days ago
    const recentDate = new Date().toUTCString();                                // now
    const items = `
      <item><title>Vieille actualité</title><link>http://localhost:${article.port}/old</link>
        <guid>test:recency:old</guid><description>Ancienne dépêche.</description><pubDate>${oldDate}</pubDate></item>
      <item><title>Actualité récente</title><link>${recentUrl}</link>
        <guid>test:recency:recent</guid><description>Dépêche récente.</description><pubDate>${recentDate}</pubDate></item>`;
    rss = Bun.serve({ port: 0, fetch: () => new Response(
      `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture récence</title>${items}</channel></rss>`,
      { headers: { "content-type": "application/xml" } }) });

    [settingsSnapshot] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, 1));
    await db.insert(pipelineSettings).values({ id: 1, maxItemsPerRun: 10 })
      .onConflictDoUpdate({ target: pipelineSettings.id, set: { maxItemsPerRun: 10 } });

    const [f] = await db.insert(feeds).values({ name: "Fixture récence", feedUrl: `http://localhost:${rss.port}/feed`, active: true }).returning({ id: feeds.id });
    feedId = f.id;
  });

  afterAll(async () => {
    article.stop(true); rss.stop(true);
    restoreEnv(envSnap);
    await db.delete(pipelineSettings).where(eq(pipelineSettings.id, 1));
    if (settingsSnapshot) await db.insert(pipelineSettings).values(settingsSnapshot);
    // FK-safe cleanup of any article staged from the recent fixture.
    const src = await db.select({ articleId: articleSources.articleId }).from(articleSources).where(like(articleSources.url, `http://localhost:${article.port}%`));
    const ids = [...new Set(src.map((s) => s.articleId))];
    let clusterIds: string[] = [];
    if (ids.length) {
      const staged = await db.select({ clusterId: articles.clusterId }).from(articles).where(inArray(articles.id, ids));
      clusterIds = [...new Set(staged.map((a) => a.clusterId).filter((c): c is string => c !== null))];
      await db.delete(articles).where(inArray(articles.id, ids));
    }
    for (const c of clusterIds) {
      const used = await db.select({ id: articles.id }).from(articles).where(eq(articles.clusterId, c)).limit(1);
      if (!used.length) await db.delete(clusters).where(eq(clusters.id, c));
    }
    await db.delete(rawItems).where(eq(rawItems.feedId, feedId));
    if (runId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, runId));
    await db.delete(feeds).where(eq(feeds.id, feedId));
  });

  it("skips items older than the cutoff, records only the recent one, and logs a 'too old' step", async () => {
    const params: RunParams = {
      recency: { kind: "age", hours: 48, cutoffAt: new Date(Date.now() - 48 * 3600_000).toISOString() },
      feedIds: null, maxItems: 10,
    };
    runId = await openRun({ triggeredBy: "manual", feedsTotal: 1, params });
    expect(runId).not.toBeNull();
    await executeRun(runId!);

    const recorded = await db.select({ url: rawItems.url }).from(rawItems).where(eq(rawItems.feedId, feedId));
    expect(recorded.map((r) => r.url)).toEqual([recentUrl]);          // old item filtered before recording

    const steps = await db.select({ name: pipelineSteps.name }).from(pipelineSteps).where(eq(pipelineSteps.runId, runId!));
    expect(steps.some((s) => /trop anciens/i.test(s.name))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/run-recency-e2e.test.ts`
Expected: FAIL — `openRun` rejects the `params` option / old item still recorded (no filter yet).

- [ ] **Step 3: Update imports in `lib/pipeline/run.ts`**

Change the checkpoint type import (~line 15) and add the two helpers below it:

```ts
import type { RunCheckpoint, RunParams } from "@/db";
import { isWithinRecency } from "./recency";
import { cutoffDate } from "./run-params";
```

- [ ] **Step 4: Extend `openRun` to persist params**

Change the signature and insert (~line 103–114):

```ts
export async function openRun(opts: { triggeredBy: RunTrigger; feedsTotal?: number; params?: RunParams }): Promise<string | null> {
  if (await hasRunningRun()) return null;
  try {
    const [run] = await db.insert(pipelineRuns).values({
      triggeredBy: opts.triggeredBy, status: "running",
      phase: "reading_feeds", feedsTotal: opts.feedsTotal ?? null, processedItems: 0,
      params: opts.params ?? null,
    }).returning({ id: pipelineRuns.id });
    return run.id;
  } catch (e) {
    if (isUniqueViolation(e)) return null;
    throw e;
  }
}
```

- [ ] **Step 5: Read params in `executeRun` and apply targeting/cap/cutoff**

In `executeRun`, add a counter to the top-of-function `let` block (~line 166):

```ts
  let feedsRead = 0, feedsFailed = 0, newItems = 0, produced = 0, itemFailures = 0, overCap = 0, tooOld = 0;
```

After `const settings = await getPipelineSettings();` (~line 185) add:

```ts
    // Params live on the run row (resolved at trigger). Read once; drives feed targeting, the item
    // cap, and the recency cutoff. Null for legacy rows / direct executeRun callers → no cutoff,
    // opts.feedIds fallback, settings.maxItemsPerRun.
    const [runRow] = await db.select({ params: pipelineRuns.params }).from(pipelineRuns).where(eq(pipelineRuns.id, runId));
    const params = runRow?.params ?? null;
    const cutoff = params ? cutoffDate(params) : null;
    const maxItems = params?.maxItems ?? settings.maxItemsPerRun;
```

Replace the `targetFeeds` selection in the non-resume branch (~line 218–221) with:

```ts
      const paramFeedIds = params?.feedIds ?? opts.feedIds;
      const targetFeeds = paramFeedIds != null
        ? (paramFeedIds.length > 0 ? await db.select().from(feeds).where(inArray(feeds.id, paramFeedIds)) : [])
        : await db.select().from(feeds).where(eq(feeds.active, true));
```

In the per-item candidate loop (~line 254–260), add the recency skip at the top and use `maxItems` for the cap:

```ts
        for (const item of items) {
          if (!isWithinRecency(item.isoDate, cutoff)) { tooOld++; continue; }  // published before cutoff
          if (seenHashes.has(item.contentHash)) continue;
          if (await isSeen(feed.id, item)) continue;
          seenHashes.add(item.contentHash);
          if (candidates.length >= maxItems) { capHit = true; overCap++; continue; }
          candidates.push({ item, feedId: feed.id, feedName: feed.name });
        }
```

- [ ] **Step 6: Emit the "too old" observability step and fix the cap message**

In the cap-hit block (~line 488), change `settings.maxItemsPerRun` → `maxItems`, and add the recency step right after it:

```ts
    if (capHit) {
      await insertStep({
        runId, name: "Limite d'éléments atteinte", status: "partial", durationMs: null,
        errorMessage:
          `La limite de ${maxItems} nouveaux éléments par exécution a été atteinte : `
          + `${overCap} élément(s) supplémentaire(s) au-delà de la limite n'ont pas été traités ; ils seront repris lors d'une prochaine exécution.`,
      });
    }
    // No silent truncation: items skipped for being older than the recency cutoff get their own step.
    if (tooOld > 0) {
      await insertStep({
        runId, name: "Éléments trop anciens ignorés", status: "partial", durationMs: null,
        errorMessage: `${tooOld} élément(s) antérieur(s) à la date de récence configurée ont été ignorés (non traités).`,
      });
    }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test tests/run-recency-e2e.test.ts`
Expected: PASS. Then regression-check the pipeline suite:
Run: `bun test tests/pipeline-run.test.ts tests/pipeline-grouping.test.ts tests/pipeline-pause-resume.test.ts`
Expected: PASS (existing callers unaffected — `params` null → old behavior).

- [ ] **Step 8: Commit**

```bash
git add lib/pipeline/run.ts tests/run-recency-e2e.test.ts
git commit -m "feat(pipeline): executeRun reads run.params (feed targeting, max items, recency filter)"
```

---

### Task 6: Trigger action `startPipelineRun(input?)` + `runPipeline` defaults

**Files:**
- Modify: `lib/actions/pipeline-actions.ts` (imports; `startPipelineRun` ~line 46–64)
- Modify: `lib/pipeline/run.ts` (`runPipeline` ~line 601–605; add import)
- Test: `tests/run-trigger-params.test.ts`

**Interfaces:**
- Consumes: `runParamsSchema`/`RunParamsInput` (Task 3), `resolveRunParams` (Task 4), `openRun` (Task 5).
- Produces: `startPipelineRun(input?: RunParamsInput): Promise<{ ok: true; runId: string } | { ok: false; message: string }>` (input optional → all defaults); `runPipeline` now persists resolved params.

- [ ] **Step 1: Write the failing test**

Create `tests/run-trigger-params.test.ts` (verifies the resolve→openRun persistence path without executing a run):

```ts
import { describe, it, expect, afterEach } from "bun:test";
import { db, pipelineRuns } from "@/db";
import { eq } from "drizzle-orm";
import { openRun } from "@/lib/pipeline/run";
import { resolveRunParams } from "@/lib/pipeline/run-params";

describe("resolveRunParams → openRun persistence", () => {
  let runId: string | null = null;
  afterEach(async () => { if (runId) { await db.delete(pipelineRuns).where(eq(pipelineRuns.id, runId)); runId = null; } });

  it("persists resolved defaults on the run row", async () => {
    const params = resolveRunParams(undefined, { defaultMaxItemAgeHours: 72, maxItemsPerRun: 15 }, new Date());
    runId = await openRun({ triggeredBy: "manual", params });
    expect(runId).not.toBeNull();
    const [row] = await db.select({ params: pipelineRuns.params }).from(pipelineRuns).where(eq(pipelineRuns.id, runId!));
    expect(row.params?.recency).toMatchObject({ kind: "age", hours: 72 });
    expect(row.params?.maxItems).toBe(15);
    expect(row.params?.feedIds).toBeNull();
    // finalize so it doesn't hold the one-running slot for later tests
    await db.update(pipelineRuns).set({ status: "success", finishedAt: new Date() }).where(eq(pipelineRuns.id, runId!));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/run-trigger-params.test.ts`
Expected: FAIL — `openRun` doesn't yet accept/persist `params` **if Task 5 not merged**; if Task 5 is merged this test passes at Step 2, in which case treat Steps 3–4 as the action/runPipeline wiring and re-run. (This task's real deliverable is the action + runPipeline changes below; the test guards the persistence contract they depend on.)

- [ ] **Step 3: Update `startPipelineRun` in `lib/actions/pipeline-actions.ts`**

Add to the top-of-file imports (static — `lib/validation` has no jsdom/DB deps):

```ts
import { runParamsSchema, type RunParamsInput } from "@/lib/validation";
```

Replace `startPipelineRun` (~line 46–64) with:

```ts
export async function startPipelineRun(input?: RunParamsInput): Promise<{ ok: true; runId: string } | { ok: false; message: string }> {
  const user = await requireUser();
  requirePermission(user.role, "pipeline", "configure");

  // Validate overrides if provided; omit → resolve everything from settings defaults.
  let parsed: RunParamsInput | undefined;
  if (input !== undefined) {
    const r = runParamsSchema.safeParse(input);
    if (!r.success) return { ok: false as const, message: "Paramètres d'exécution invalides." };
    parsed = r.data;
  }

  // Dynamic imports kept AFTER the RBAC check (mirrors the rest of this file — see reprocessRawItem).
  const { openRun, executeRun } = await import("@/lib/pipeline/run");
  const { resolveRunParams } = await import("@/lib/pipeline/run-params");
  const { getPipelineSettings } = await import("@/lib/queries/settings");
  const { db, feeds } = await import("@/db");
  const { eq, inArray } = await import("drizzle-orm");

  const settings = await getPipelineSettings();
  const params = resolveRunParams(parsed, {
    defaultMaxItemAgeHours: settings.defaultMaxItemAgeHours,
    maxItemsPerRun: settings.maxItemsPerRun,
  }, new Date());

  const feedsTotal = params.feedIds != null
    ? (await db.select({ id: feeds.id }).from(feeds).where(inArray(feeds.id, params.feedIds))).length
    : (await db.select({ id: feeds.id }).from(feeds).where(eq(feeds.active, true))).length;

  const runId = await openRun({ triggeredBy: "manual", feedsTotal, params });
  if (!runId) return { ok: false as const, message: "Une exécution est déjà en cours." };

  void executeRun(runId).catch(() => {});
  return { ok: true as const, runId };
}
```

- [ ] **Step 4: Make `runPipeline` resolve + persist defaults (`lib/pipeline/run.ts`)**

Add near the other imports:

```ts
import { resolveRunParams } from "./run-params";
```

Replace `runPipeline` (~line 601–605) with:

```ts
export async function runPipeline(opts: { triggeredBy: RunTrigger; feedIds?: string[] }): Promise<RunResult> {
  // Resolve params from settings so scheduled/programmatic runs persist the same shape as manual
  // ones (and inherit the recency default). feedIds from opts, if given, becomes the feed subset.
  const settings = await getPipelineSettings();
  const params = resolveRunParams(
    opts.feedIds !== undefined ? { feedIds: opts.feedIds } : undefined,
    { defaultMaxItemAgeHours: settings.defaultMaxItemAgeHours, maxItemsPerRun: settings.maxItemsPerRun },
    new Date(),
  );
  const runId = await openRun({ triggeredBy: opts.triggeredBy, params });
  if (!runId) return { runId: null, status: "skipped", produced: 0 };
  return executeRun(runId);
}
```

(`getPipelineSettings` is already imported at the top of `lib/pipeline/run.ts`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/run-trigger-params.test.ts`
Expected: PASS.
Run: `bun test tests/pipeline-run.test.ts tests/pipeline-scheduler.test.ts`
Expected: PASS (runPipeline still works; scheduled path persists params).

- [ ] **Step 6: Typecheck + commit**

```bash
bun run typecheck
git add lib/actions/pipeline-actions.ts lib/pipeline/run.ts tests/run-trigger-params.test.ts
git commit -m "feat(pipeline): startPipelineRun(input) + runPipeline resolve/persist run params"
```

---

### Task 7: Settings — default recency column mapping, schema field, form

**Files:**
- Modify: `lib/validation.ts` (`pipelineSettingsSchema` — add field)
- Modify: `lib/pipeline/settings-write.ts` (`persistPipelineSettings` `values`)
- Modify: `components/settings/pipeline-settings-form.tsx` (`FormState`, `toFormState`, `handleSave` payload, new input in the "Exécution" card)
- Modify: `tests/pipeline-settings.test.ts` (add coverage; fix any literal `PipelineSettingsInput` fixtures)

**Interfaces:**
- Consumes: `pipelineSettings.defaultMaxItemAgeHours` column (Task 2). `PipelineSettings` type (`$inferSelect`) auto-includes it; `getPipelineSettings` needs no change.
- Produces: `pipelineSettingsSchema` accepts `defaultMaxItemAgeHours: number | null`; the form round-trips it.

- [ ] **Step 1: Write the failing test**

Add to `tests/pipeline-settings.test.ts` (follow the file's existing snapshot/restore of the `pipeline_settings` row; if it already has a `beforeAll/afterAll` snapshot, reuse it):

```ts
import { getPipelineSettings } from "@/lib/queries/settings";
import { persistPipelineSettings } from "@/lib/pipeline/settings-write";
// (db, pipelineSettings, eq are already imported in this file)

it("persists and clears the default recency (defaultMaxItemAgeHours)", async () => {
  const base = {
    maxItemsPerRun: 20, perOperationTimeoutMs: 300000, clusterThreshold: 0.83, scoreThreshold: 70,
    autoPublishEnabled: false, autoPublishMinSources: 2, webSearchEnabled: false,
    scheduleCron: null, alertEmailEnabled: false, alertEmailRecipients: null,
  };
  await persistPipelineSettings({ ...base, defaultMaxItemAgeHours: 96 });
  expect((await getPipelineSettings()).defaultMaxItemAgeHours).toBe(96);
  await persistPipelineSettings({ ...base, defaultMaxItemAgeHours: null });
  expect((await getPipelineSettings()).defaultMaxItemAgeHours).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/pipeline-settings.test.ts`
Expected: FAIL — `defaultMaxItemAgeHours` not in the schema/persist `values`, so it's dropped.

- [ ] **Step 3: Add the field to `pipelineSettingsSchema`**

In `lib/validation.ts`, inside `pipelineSettingsSchema` (before the closing `})`), add:

```ts
  // Default recency cutoff (hours). Nullable = "no limit". `.default(null)` keeps existing callers
  // that don't send the field valid (mirrors alertEmailEnabled's default-for-compat pattern).
  defaultMaxItemAgeHours: z.number().int().positive("Doit être un entier positif").max(720, "Maximum 720 heures (30 jours)").nullable().default(null),
```

- [ ] **Step 4: Persist it (`lib/pipeline/settings-write.ts`)**

In `persistPipelineSettings`, add to the `values` object (after `alertEmailRecipients`):

```ts
    defaultMaxItemAgeHours: data.defaultMaxItemAgeHours ?? null,
```

- [ ] **Step 5: Run the settings test to verify it passes**

Run: `bun test tests/pipeline-settings.test.ts`
Expected: PASS. (If any pre-existing literal typed as `PipelineSettingsInput` and passed to `persistPipelineSettings` now fails typecheck, add `defaultMaxItemAgeHours: null` to it.)

- [ ] **Step 6: Add the form field**

In `components/settings/pipeline-settings-form.tsx`:

Add to `FormState`: `defaultMaxItemAgeHours: string;`

Add to `toFormState` return: `defaultMaxItemAgeHours: settings.defaultMaxItemAgeHours == null ? "" : String(settings.defaultMaxItemAgeHours),`

Add to the `handleSave` `payload`: `defaultMaxItemAgeHours: form.defaultMaxItemAgeHours.trim() === "" ? null : Number(form.defaultMaxItemAgeHours),`

Add this field inside the "Exécution" `CardContent` (after the max-items field, ~line 101):

```tsx
          <div className="space-y-1.5">
            <Label htmlFor="default-recency">Récence par défaut (heures)</Label>
            <Input
              id="default-recency" type="number" min={1} max={720} disabled={isSaving}
              value={form.defaultMaxItemAgeHours}
              placeholder="Aucune limite"
              onChange={(e) => setForm((f) => ({ ...f, defaultMaxItemAgeHours: e.target.value }))}
            />
            <p className="text-xs text-muted-foreground">
              Vide = aucune limite. Pré-remplit la fenêtre de récence au lancement d&apos;une exécution ; appliquée aussi aux exécutions planifiées.
            </p>
          </div>
```

- [ ] **Step 7: Typecheck + commit**

```bash
bun run typecheck
git add lib/validation.ts lib/pipeline/settings-write.ts components/settings/pipeline-settings-form.tsx tests/pipeline-settings.test.ts
git commit -m "feat(settings): configurable default recency (defaultMaxItemAgeHours)"
```

---

### Task 8: Trigger dialog UI + `getRunConfigOptions` action

**Files:**
- Modify: `lib/actions/pipeline-actions.ts` (add `getRunConfigOptions`)
- Create: `components/pipeline/run-config-dialog.tsx`
- Modify: `components/pipeline/live-run-panel.tsx` (`IdleView` + `handleStart` → open dialog, thread `onStarted`)

**Interfaces:**
- Consumes: `startPipelineRun(input)` (Task 6), `RunParamsInput` (Task 3).
- Produces: `getRunConfigOptions(): Promise<{ feeds: { id: string; name: string }[]; defaults: { defaultMaxItemAgeHours: number | null; maxItemsPerRun: number } }>`; `<RunConfigDialog onStarted={(runId: string) => void} />`.

No unit test (no component-test harness in this repo). Gate: typecheck + build + manual verification.

- [ ] **Step 1: Add the options action**

In `lib/actions/pipeline-actions.ts`, add:

```ts
/** Feeds + defaults for the "configure run" dialog (pipeline:configure). */
export async function getRunConfigOptions(): Promise<{
  feeds: { id: string; name: string }[];
  defaults: { defaultMaxItemAgeHours: number | null; maxItemsPerRun: number };
}> {
  const user = await requireUser();
  requirePermission(user.role, "pipeline", "configure");
  const { db, feeds } = await import("@/db");
  const { eq, asc } = await import("drizzle-orm");
  const { getPipelineSettings } = await import("@/lib/queries/settings");
  const [feedRows, settings] = await Promise.all([
    db.select({ id: feeds.id, name: feeds.name }).from(feeds).where(eq(feeds.active, true)).orderBy(asc(feeds.name)),
    getPipelineSettings(),
  ]);
  return { feeds: feedRows, defaults: { defaultMaxItemAgeHours: settings.defaultMaxItemAgeHours, maxItemsPerRun: settings.maxItemsPerRun } };
}
```

- [ ] **Step 2: Build the dialog component**

Create `components/pipeline/run-config-dialog.tsx`. Uses existing primitives only (`Dialog`, `Select`, `Input`, `Label`, `Button`, `Switch`; native checkboxes for the feed list — no `checkbox`/`radio-group` primitive exists). Recency mode is a `Select` (`none` / `age` / `since`); `age` shows a preset `Select`, `since` shows date + time `Input`s.

```tsx
"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Play } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getRunConfigOptions, startPipelineRun } from "@/lib/actions/pipeline-actions";
import type { RunParamsInput } from "@/lib/validation";

const AGE_PRESETS = [
  { value: "6", label: "6 heures" }, { value: "12", label: "12 heures" }, { value: "24", label: "24 heures" },
  { value: "48", label: "48 heures" }, { value: "72", label: "72 heures" }, { value: "168", label: "7 jours" },
];
type Feed = { id: string; name: string };
type RecencyMode = "none" | "age" | "since";

export function RunConfigDialog({ onStarted }: { onStarted: (runId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<RecencyMode>("none");
  const [ageHours, setAgeHours] = useState("48");
  const [sinceDate, setSinceDate] = useState("");
  const [sinceTime, setSinceTime] = useState("09:00");
  const [maxItems, setMaxItems] = useState("");
  const [isPending, startTransition] = useTransition();

  async function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next && feeds.length === 0) {
      setLoading(true);
      try {
        const opts = await getRunConfigOptions();
        setFeeds(opts.feeds);
        setSelected(new Set(opts.feeds.map((f) => f.id)));           // all feeds by default
        setMaxItems(String(opts.defaults.maxItemsPerRun));
        if (opts.defaults.defaultMaxItemAgeHours != null) {
          setMode("age");
          setAgeHours(String(opts.defaults.defaultMaxItemAgeHours));
        }
      } catch {
        toast.error("Impossible de charger les options d'exécution.");
        setOpen(false);
      } finally { setLoading(false); }
    }
  }

  function toggleFeed(id: string) {
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  function buildInput(): RunParamsInput | null {
    let recency: RunParamsInput["recency"];
    if (mode === "none") recency = { kind: "none" };
    else if (mode === "age") recency = { kind: "age", hours: Number(ageHours) };
    else {
      if (!sinceDate) { toast.error("Choisissez une date « depuis »."); return null; }
      const at = new Date(`${sinceDate}T${sinceTime || "00:00"}`);        // local → ISO with tz
      if (Number.isNaN(at.getTime())) { toast.error("Date « depuis » invalide."); return null; }
      recency = { kind: "since", at: at.toISOString() };
    }
    const allSelected = selected.size === feeds.length;
    return {
      recency,
      feedIds: allSelected ? null : [...selected],
      maxItems: maxItems.trim() ? Number(maxItems) : undefined,
    };
  }

  function handleLaunch() {
    if (selected.size === 0) { toast.error("Sélectionnez au moins un flux."); return; }
    const input = buildInput();
    if (!input) return;
    startTransition(async () => {
      try {
        const r = await startPipelineRun(input);
        if (!r.ok) { toast.error(r.message); return; }
        setOpen(false);
        onStarted(r.runId);
      } catch { toast.error("Une erreur inattendue est survenue."); }
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button><Play aria-hidden /> Configurer l&apos;exécution…</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Configurer l&apos;exécution</DialogTitle>
          <DialogDescription>Ajustez les paramètres avant de lancer. Les valeurs par défaut viennent des réglages.</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="animate-spin" aria-hidden /></div>
        ) : (
          <div className="space-y-4">
            {/* Récence */}
            <div className="space-y-1.5">
              <Label>Récence</Label>
              <Select value={mode} onValueChange={(v) => setMode((v as RecencyMode) ?? "none")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Aucune limite</SelectItem>
                  <SelectItem value="age">Derniers…</SelectItem>
                  <SelectItem value="since">Depuis une date</SelectItem>
                </SelectContent>
              </Select>
              {mode === "age" && (
                <Select value={ageHours} onValueChange={(v) => setAgeHours(v ?? "48")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{AGE_PRESETS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent>
                </Select>
              )}
              {mode === "since" && (
                <div className="flex gap-2">
                  <Input type="date" value={sinceDate} onChange={(e) => setSinceDate(e.target.value)} />
                  <Input type="time" value={sinceTime} onChange={(e) => setSinceTime(e.target.value)} />
                </div>
              )}
            </div>

            {/* Flux */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>Flux ({selected.size}/{feeds.length})</Label>
                <button type="button" className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setSelected(selected.size === feeds.length ? new Set() : new Set(feeds.map((f) => f.id)))}>
                  {selected.size === feeds.length ? "Tout désélectionner" : "Tout sélectionner"}
                </button>
              </div>
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
                {feeds.map((f) => (
                  <label key={f.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted/50">
                    <input type="checkbox" checked={selected.has(f.id)} onChange={() => toggleFeed(f.id)} />
                    <span className="truncate">{f.name}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Max items */}
            <div className="space-y-1.5">
              <Label htmlFor="run-max-items">Nombre max de nouveaux éléments</Label>
              <Input id="run-max-items" type="number" min={1} max={500} value={maxItems}
                onChange={(e) => setMaxItems(e.target.value)} />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button onClick={handleLaunch} disabled={isPending || loading}>
            {isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Play aria-hidden />}
            {isPending ? "Démarrage…" : "Lancer l'exécution"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Wire the dialog into `IdleView`**

In `components/pipeline/live-run-panel.tsx`:

Add the import:
```ts
import { RunConfigDialog } from "@/components/pipeline/run-config-dialog";
```

Replace `handleStart` with an `onStarted` callback that begins polling (the dialog now owns the `startPipelineRun` call):

```ts
  const handleStarted = useCallback((runId: string) => {
    watchedRef.current = runId;
    setPolling(true); // effect picks up the live state on the next poll
  }, []);
```

Change the `LiveRunPanel` return's idle branch:
```ts
  if (active) return <RunningView active={active} onCancelInitiated={(id) => { justCancelledRef.current = id; }} />;
  return <IdleView lastRun={lastRun} onStarted={handleStarted} />;
```

Replace `IdleView` to render the dialog (drop the old `onStart`/`starting` props and the direct Button):

```tsx
function IdleView({ lastRun, onStarted }: { lastRun: RunRow | null; onStarted: (runId: string) => void }) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="text-sm text-muted-foreground">
          {lastRun ? (
            <>Dernière exécution : <span className={STATUS_TEXT[lastRun.status]}>{pipelineStatusLabel(lastRun.status)}</span>{" · "}{relativeDate(lastRun.startedAt)}</>
          ) : "Aucune exécution pour l'instant."}
        </div>
        <RoleGate allow={["admin"]}>
          <RunConfigDialog onStarted={onStarted} />
        </RoleGate>
      </CardContent>
    </Card>
  );
}
```

Remove the now-unused `startPipelineRun` import and the old `isStarting`/`startTransition` used only by `handleStart` if they're no longer referenced (leave `useTransition` if still used elsewhere — it is not, so remove `isStarting`/`startTransition` and the `Play` import if unused; keep `Loader2`/others still referenced by `RunningView`).

- [ ] **Step 4: Verify typecheck + build**

Run:
```bash
bun run typecheck
bun run build
```
Expected: both exit 0. Fix any unused-import/type errors surfaced by the `IdleView` refactor.

- [ ] **Step 5: Manual verification**

Use the `run` skill (or `bun dev`) to open `/runs` as an admin: the button reads "Configurer l'exécution…", opens a dialog pre-filled from settings (recency = default, all feeds checked, max items = default), and launching starts a live run. Confirm a run created with a recency cutoff logs the "Éléments trop anciens ignorés" step when applicable.

- [ ] **Step 6: Commit**

```bash
git add lib/actions/pipeline-actions.ts components/pipeline/run-config-dialog.tsx components/pipeline/live-run-panel.tsx
git commit -m "feat(runs): configure-run dialog (recency, feed selection, max items) replaces one-click trigger"
```

---

### Task 9: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck`
Expected: exit 0.

- [ ] **Step 2: Full test suite**

Run: `bun test`
Expected: all green (new `run-params*`, `run-recency-e2e`, `run-trigger-params`, updated `pipeline-settings`, and all existing pipeline tests).

- [ ] **Step 3: Production build**

Run: `bun run build`
Expected: exit 0 (no `pg`-in-client-bundle regression from the new client dialog — it imports only actions + the `RunParamsInput` type via `import type`).

- [ ] **Step 4: Final commit (if anything outstanding)**

```bash
git status
# commit any stragglers, then the branch is ready for review/PR
```

---

## Self-Review

**Spec coverage:**
- Recency cutoff (relative default + absolute override, undated-include) → Tasks 1, 4, 5, 7. ✅
- Feed selection → Tasks 5 (targeting), 8 (UI). ✅
- Max new items → Tasks 5 (cap), 8 (UI). ✅
- Settings defaults (`default_max_item_age_hours`, NULL ship default) → Tasks 2, 7. ✅
- Params persisted as jsonb on `pipeline_runs`; `executeRun` reads them → Tasks 2, 5. ✅
- Scheduled runs inherit defaults → Task 6 (`runPipeline`). ✅
- No silent truncation ("too old" step) → Task 5. ✅
- Configure-run dialog pre-filled from defaults → Task 8. ✅
- Out of scope (web-search/auto-publish override, preview) → not planned. ✅

**Type consistency:** `RunParams` (Task 2) is consumed unchanged by `resolveRunParams`/`cutoffDate` (Task 4), `openRun`/`executeRun` (Task 5), and the round-trip tests. `RunParamsInput` (Task 3) is consumed by `resolveRunParams` (Task 4), `startPipelineRun` (Task 6), and the dialog (Task 8) with matching shapes. `RunParamDefaults` fields (`defaultMaxItemAgeHours`, `maxItemsPerRun`) match `getPipelineSettings()`'s row. ✅

**Placeholder scan:** No TBD/TODO; every code step has concrete content and every test has real assertions. ✅
