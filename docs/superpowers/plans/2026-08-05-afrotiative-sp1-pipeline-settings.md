# SP1 — Pipeline Settings foundation — Plan

**Goal:** A DB-backed, admin-editable pipeline settings store + a `/settings/pipeline` page, with `getPipelineSettings()` as the runtime source of truth for run-behavior knobs (env stays the seed default; secrets stay env-only).

**Branch:** `feat/pipeline-v2`. **Tech:** Next.js 16 RSC/Server Actions, Drizzle/Postgres-Neon, Bun, shadcn on Base UI.

## Global constraints
- **Additive migration only.** French UI copy. RBAC: page + actions gate on `requirePermission(user.role, "pipeline", "configure")` (admin-only), matching `/settings/integrations`.
- Follow existing settings patterns exactly: page = server component fetching a `lib/queries/settings.ts` getter → client form; actions = `"use server"` with a `guard()` re-checking RBAC, Zod validation from `lib/validation.ts`, Drizzle upsert, `revalidatePath`. Nav entry in `components/settings/settings-nav.tsx`.
- `getPipelineConfig()` (sync, env) stays for providers/secrets/order. New `getPipelineSettings()` (async, DB) owns run-behavior knobs. Do NOT make `getPipelineConfig()` async.
- Tests: `bun test`, real Neon dev, network-free, MUST clean up rows they create.

## Design

### `pipeline_settings` table (singleton row, `db/schema.ts`)
```ts
export const pipelineSettings = pgTable("pipeline_settings", {
  id: integer("id").primaryKey().default(1),                 // singleton; always row id=1
  maxItemsPerRun: integer("max_items_per_run").notNull().default(20),
  perOperationTimeoutMs: integer("per_operation_timeout_ms").notNull().default(300000), // 5 min
  clusterThreshold: real("cluster_threshold").notNull().default(0.83),
  scoreThreshold: integer("score_threshold").notNull().default(70),        // auto-publish min score (SP6)
  autoPublishEnabled: boolean("auto_publish_enabled").notNull().default(false),
  autoPublishMinSources: integer("auto_publish_min_sources").notNull().default(2),
  webSearchEnabled: boolean("web_search_enabled").notNull().default(false),
  scheduleCron: text("schedule_cron"),                       // null = no in-app schedule (SP2)
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
```
`integer`, `real`, `boolean`, `text`, `timestamp` — check which are already imported in `db/schema.ts`; add `real` to the drizzle-orm/pg-core import if missing. Generate the migration with `bun run db:generate`, apply with `bun run db:migrate`.

### `getPipelineSettings()` — `lib/queries/settings.ts` (async, DB source of truth)
Reads row id=1. If absent, **seed it once** from the current env defaults so an existing `MAX_ITEMS_PER_RUN` / `CLUSTER_THRESHOLD` env is honored as the initial value, then DB is authoritative:
```ts
export type PipelineSettings = typeof pipelineSettings.$inferSelect;
export async function getPipelineSettings(): Promise<PipelineSettings> {
  const [row] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, 1));
  if (row) return row;
  const cfg = getPipelineConfig(); // env defaults as seed
  const [created] = await db.insert(pipelineSettings).values({
    id: 1, maxItemsPerRun: cfg.maxItemsPerRun, clusterThreshold: cfg.clusterThreshold,
  }).onConflictDoNothing().returning();
  if (created) return created;
  const [again] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, 1));
  return again;
}
```

### `updatePipelineSettings` action — `lib/actions/pipeline-settings-actions.ts` (`"use server"`)
`guard()` (requireUser + requirePermission pipeline:configure) → `pipelineSettingsSchema.parse(input)` → upsert row id=1 (`onConflictDoUpdate`) with `updatedAt: new Date()` → `revalidatePath("/settings/pipeline")`. Zod schema in `lib/validation.ts` (a `"use server"` file may only export async fns, so the schema lives in validation.ts): positive ints for maxItems/timeout/minSources, `scoreThreshold` 0-100, `clusterThreshold` 0-1, booleans, `scheduleCron` optional string (validate as a 5-field cron or empty; a light regex is fine).

### Wire one knob as proof: `maxItemsPerRun` in `lib/pipeline/run.ts`
In `executeRun`, replace `const cfg = getPipelineConfig(); ... cfg.maxItemsPerRun` reads with a `const settings = await getPipelineSettings();` read for `maxItemsPerRun` (keep `getPipelineConfig()` for anything else it still needs). This proves the DB→behavior path. Update the cap test in `tests/live-progress.test.ts` if it relied on the env var: it currently sets `process.env.MAX_ITEMS_PER_RUN = "2"` — switch that test to instead upsert `pipeline_settings.maxItemsPerRun = 2` (and restore/delete in cleanup), OR keep env by having `getPipelineSettings` fall back to env when no row — simplest: the test upserts the settings row id=1 with maxItemsPerRun=2 before the run and deletes it after. Ensure the `getPipelineSettings` seed path and the test's explicit row don't collide (test writes id=1 explicitly).

### `/settings/pipeline` page + form + nav
- `app/(app)/settings/pipeline/page.tsx`: server component, `requireUser()` + `requirePermission("pipeline","configure")`, `getPipelineSettings()` → `<PipelineSettingsForm settings={...} />`.
- `components/settings/pipeline-settings-form.tsx`: client form (shadcn `Input`/`Switch`/`Label`/`Button`) editing the knobs, submits via `updatePipelineSettings`, `toast` on success/error. French labels + helop text (e.g. "Nombre max d'éléments par exécution", "Délai max par opération (ms)", "Publication automatique", "Seuil de score", "Cron de planification"). Group: Exécution (maxItems, timeout, clusterThreshold), Publication auto (enabled, minScore=scoreThreshold, minSources), Recherche web (webSearchEnabled), Planification (scheduleCron). Note next to auto-publish/schedule/webSearch that they're wired in later sub-projects.
- Add to `SETTINGS_NAV_ITEMS` in `components/settings/settings-nav.tsx`: `{ href: "/settings/pipeline", label: "Pipeline", icon: <a lucide icon e.g. SlidersHorizontal>, roles: ["admin"] }`.

## Tests (bun:test, real Neon, cleanup mandatory)
1. `pipeline_settings` migration round-trips (insert id=1 with values, read back, defaults correct); clean up.
2. `getPipelineSettings()` seeds the singleton on first call (delete row id=1 first if present — carefully, shared DB; better: assert it returns a row with the expected default shape, and is idempotent on second call). Keep it non-destructive to a real configured row: the test should snapshot/restore row id=1 if it exists.
3. `getPipelineSettings` merge/seed honors env seed for maxItemsPerRun (set env, ensure no row, call, assert). Restore env + row.
4. `pipelineSettingsSchema` validation: rejects negative maxItems, score>100, clusterThreshold>1; accepts valid.
5. RBAC: `updatePipelineSettings` requires admin (mirror `tests/pipeline-actions.test.ts` `can()` assertions or attempt as non-admin).
6. The two-phase cap test in `tests/live-progress.test.ts` now drives the cap via `pipeline_settings.maxItemsPerRun` and still passes.

## Verify
`bun run typecheck` → 0 errors. `bun test` → full suite green (incl. updated cap test). Commit: `feat(settings): DB-backed pipeline settings + /settings/pipeline page`.

## Notes for later SPs (do not implement here)
`perOperationTimeoutMs` → SP5. `scoreThreshold`/`autoPublish*` → SP6. `webSearchEnabled`/`clusterThreshold` (for cross-check) → SP4. `scheduleCron` → SP2. This SP only WIRES `maxItemsPerRun`; the rest are stored + editable but consumed later.
