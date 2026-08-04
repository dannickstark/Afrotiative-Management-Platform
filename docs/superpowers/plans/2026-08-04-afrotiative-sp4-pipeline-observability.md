# Afrotiative SP4 — Pipeline Observability (full Runs screen) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the minimal Runs surface into a diagnosable observability screen: a run-detail Sheet drawer with a per-item step trace (French errors first, technical detail behind a disclosure), recovery actions (re-run execution + per-item reprocess bypassing dedup), and light auto-refresh while a run is in progress.

**Architecture:** Read UI over existing `pipeline_runs`/`pipeline_steps` (populated by SP3) + one additive migration (`pipeline_steps.raw_item_id`) so per-item steps are attributable/reprocessable, + a `reprocessRawItem` server action. Builds on SP3; never publishes (reprocess only stages `pending`).

**Tech Stack:** TypeScript · Bun · Next.js 16 · Drizzle/Neon · shadcn/Base-UI (`Sheet`, `Collapsible`) · sonner · React (`useRouter().refresh()` for auto-refresh).

## Global Constraints

- **Runtime & toolchain: Bun.** `bun add`/`bun run`/`bun test` (`bun:test`)/`bun file.ts`. `.env.local` auto-loaded (+ `test-setup.ts` preload, which now deletes provider `*_API_KEY` vars — tests are credential-free by default; a test needing real keys sets them itself). Never touch/commit `.env.local`; never `git clean`. Reseed (`bun run db:seed`) after any test/run that mutates rows.
- **UI language French.** Error messages surfaced to humans are French + plain; technical detail (`error_technical`) only behind a "Voir les détails techniques" disclosure.
- **Human-review gate (non-negotiable):** reprocess only ever stages `articles.status='pending'`, `ai_author=true` — NEVER `published`. WordPress = SP5, out of scope.
- **RBAC:** viewing `/runs` + details = `pipeline:read` (Admin+Editor; the page gate already exists from SP3). Recovery actions (`runPipelineNow`, `reprocessRawItem`) = `pipeline:configure` (Admin) — enforced server-side AND buttons under `RoleGate allow={["admin"]}`.
- **DB:** any schema change is an **additive** Drizzle migration (never destructive); pooled `DATABASE_URL` in app code, `DIRECT_URL` only for migrations.
- **Base UI:** shadcn primitives are Base UI (triggers use `render`, not `asChild`; `Select`/value patterns as in existing components). Add new primitives (`collapsible`) via the shadcn CLI.
- **Server-action modules that transitively import the jsdom-heavy pipeline** must use dynamic `import()` inside the function body (Turbopack build safety) — as `runPipelineNow` already does.
- **Overlap safety preserved:** reprocess is guarded by `hasRunningRun()` + the SP3 `pipeline_runs_one_running` interlock; runs always finalize (SP3 try/finally + stale-run reaper).
- **TDD where logic lives** (query grouping, reprocess RBAC + dedup-bypass + pending-stage). UI ends with a manual verification step driving the real app.

---

## File Structure

```
db/schema.ts                             # + rawItemId on pipelineSteps
db/migrations/…                          # additive: pipeline_steps.raw_item_id
lib/pipeline/run.ts                      # stamp raw_item_id on per-item step rows
lib/queries/runs.ts                      # getRuns() (moved/shared) + getRunDetail(runId)
lib/actions/pipeline-actions.ts          # + reprocessRawItem(rawItemId)
components/pipeline/runs-view.tsx        # client: list + row-click Sheet + auto-refresh
components/pipeline/run-detail-sheet.tsx # Sheet: summary + grouped trace + recovery
app/(app)/runs/page.tsx                  # fetch runs+detailless list → RunsView
components/ui/collapsible.tsx            # shadcn CLI (Base UI)
tests/{run-detail,reprocess}.test.ts
```

---

## Task 1: Schema attribution + run-detail query

**Files:** Modify `db/schema.ts`, `lib/pipeline/run.ts`; Create `db/migrations/*` (additive), `lib/queries/runs.ts`; Test `tests/run-detail.test.ts`

**Interfaces:**
- Produces:
  - `pipelineSteps.rawItemId` (uuid, nullable, FK → `rawItems.id`, `onDelete: "set null"`).
  - `getRunDetail(runId): Promise<RunDetail | null>` where `RunDetail = { run: PipelineRun; feedSteps: Step[]; items: { rawItemId: string; title: string; url: string; steps: Step[]; hasFailure: boolean }[] }` (feed-level steps = `rawItemId` null; per-item groups joined to `raw_items.raw_title`/`url`).
  - `groupSteps(steps, rawItems)` — a PURE helper (steps + a rawItemId→{title,url} map → `{feedSteps, items}`) for unit testing.

- [ ] **Step 1: Add the column (schema + additive migration)**

In `db/schema.ts`, add to `pipelineSteps`:
```ts
rawItemId: uuid("raw_item_id").references(() => rawItems.id, { onDelete: "set null" }),
```
Then generate + push the additive migration:
```bash
bun run db:generate   # review the generated SQL: it must be ADD COLUMN only (no drops)
bun run db:push
```
Verify on Neon the column exists and is nullable; confirm the migration SQL contains only `ALTER TABLE "pipeline_steps" ADD COLUMN ...` (abort if drizzle proposes anything destructive).

- [ ] **Step 2: Stamp `raw_item_id` on per-item steps in `run.ts`**

In `lib/pipeline/run.ts`, where an item's `StepRec[]` are persisted as `pipeline_steps` rows, set `rawItemId` = the id returned by `recordRawItem` for that item (already in scope in the per-item loop). Feed-level/run-level steps (RSS read, feed failure, cap-reached) keep `rawItemId` null. The reprocess path (Task 2) sets it too. No other behavior changes; the human-review gate is untouched.

- [ ] **Step 3: Write the pure grouping test first**

`tests/run-detail.test.ts` (pure part):
```ts
import { describe, it, expect } from "bun:test";
import { groupSteps } from "@/lib/queries/runs";

describe("groupSteps", () => {
  it("splits feed-level steps from per-item groups and flags failures", () => {
    const steps = [
      { id: "1", name: "Lecture du flux", status: "success", rawItemId: null, errorMessage: null, errorTechnical: null, durationMs: 10 },
      { id: "2", name: "Extraction du contenu", status: "success", rawItemId: "ri1", errorMessage: null, errorTechnical: null, durationMs: 20 },
      { id: "3", name: "Génération IA", status: "failed", rawItemId: "ri1", errorMessage: "La génération a échoué.", errorTechnical: "stack…", durationMs: 30 },
    ] as any;
    const meta = new Map([["ri1", { title: "La BRVM progresse", url: "https://x/a" }]]);
    const g = groupSteps(steps, meta);
    expect(g.feedSteps.map((s) => s.id)).toEqual(["1"]);
    expect(g.items).toHaveLength(1);
    expect(g.items[0]).toMatchObject({ rawItemId: "ri1", title: "La BRVM progresse", hasFailure: true });
    expect(g.items[0].steps.map((s) => s.id)).toEqual(["2", "3"]);
  });
});
```

- [ ] **Step 4: Run → FAIL** — `bun test tests/run-detail.test.ts` (module missing).

- [ ] **Step 5: Implement `lib/queries/runs.ts`**

```ts
import { db, pipelineRuns, pipelineSteps, rawItems } from "@/db";
import { desc, eq, sql } from "drizzle-orm";

export type Step = {
  id: string; name: string; status: string; rawItemId: string | null;
  errorMessage: string | null; errorTechnical: string | null; durationMs: number | null;
};

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
      .from(rawItems).where(sql`${rawItems.id} in ${itemIds}`);
    for (const r of rows) meta.set(r.id, { title: r.title ?? "(sans titre)", url: r.url });
  }
  return { run, ...groupSteps(steps, meta) };
}
export type RunDetail = NonNullable<Awaited<ReturnType<typeof getRunDetail>>>;
```
> Verify the `in ${itemIds}` array-binding form against installed drizzle-orm (SP0/SP3 used `inArray`); prefer `inArray(rawItems.id, itemIds)` if cleaner. Also (optional) move the existing `/runs` list query into a `getRuns()` here and have the page import it — DRY, not required.

- [ ] **Step 6: Run → PASS + integration sanity + typecheck**

Run: `bun test tests/run-detail.test.ts && bun run typecheck`. (Optional DB check: after a seeded run exists, `getRunDetail(<id>)` returns grouped items — but the seed's runs have no steps with rawItemId yet; this is exercised fully in Task 5.)

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(runs): raw_item_id on pipeline_steps + getRunDetail grouping"`

---

## Task 2: `reprocessRawItem` action (retry a failed item, bypassing dedup)

**Files:** Modify `lib/actions/pipeline-actions.ts`; Test `tests/reprocess.test.ts`

**Interfaces:**
- Consumes: `requireUser`, `requirePermission`, `hasRunningRun`, `stageItem`, `db` (`rawItems`, `feeds`, `wpCategories`, `pipelineRuns`, `pipelineSteps`).
- Produces: `reprocessRawItem(rawItemId): Promise<{ ok: boolean; message: string; articleId?: string | null }>` — RBAC `pipeline:configure`; overlap-guarded; re-runs the stage chain for the stored `raw_item` WITHOUT dedup; records a `triggered_by:"reprocess"` run + its steps (with `raw_item_id`); stages `pending` on success. Dynamic-import the jsdom-heavy `stageItem`/pipeline modules inside the body.

- [ ] **Step 1: RBAC + dedup-bypass guard test**

`tests/reprocess.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { can } from "@/lib/rbac";

describe("reprocess authz", () => {
  it("only admin may reprocess", () => {
    expect(can("admin", "pipeline", "configure")).toBe(true);
    expect(can("editor", "pipeline", "configure")).toBe(false);
    expect(can("journalist", "pipeline", "configure")).toBe(false);
  });
});
```
(An integration test in Step 4 exercises the real dedup-bypass + pending-stage.)

- [ ] **Step 2: Implement `reprocessRawItem`**

Append to `lib/actions/pipeline-actions.ts` (mirror `runPipelineNow`'s dynamic-import + RBAC pattern):
```ts
export async function reprocessRawItem(rawItemId: string) {
  const user = await requireUser();
  requirePermission(user.role, "pipeline", "configure");
  const { db, rawItems, feeds, wpCategories, pipelineRuns, pipelineSteps } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const { hasRunningRun } = await import("@/lib/pipeline/overlap");
  const { stageItem } = await import("@/lib/pipeline/stages");
  if (await hasRunningRun()) return { ok: false as const, message: "Une exécution est déjà en cours." };

  const [ri] = await db.select().from(rawItems).where(eq(rawItems.id, rawItemId));
  if (!ri) return { ok: false as const, message: "Élément introuvable." };
  const [feed] = await db.select().from(feeds).where(eq(feeds.id, ri.feedId));
  const cats = (await db.select({ name: wpCategories.name }).from(wpCategories)).map((c) => c.name);

  const [run] = await db.insert(pipelineRuns).values({ triggeredBy: "reprocess", status: "running", feedsRead: 0, newItems: 1, published: 0 }).returning();
  const item = { guid: ri.guid, url: ri.url, title: ri.rawTitle ?? "", contentSnippet: ri.rawBody ?? "", isoDate: null, contentHash: ri.contentHash };
  const { articleId, steps } = await stageItem(item as any, feed?.name ?? "Source", cats);
  if (steps.length) {
    await db.insert(pipelineSteps).values(steps.map((s) => ({
      runId: run.id, rawItemId, name: s.name, status: s.status, durationMs: s.durationMs,
      errorMessage: s.errorMessage ?? null, errorTechnical: s.errorTechnical ?? null,
    })));
  }
  const status = articleId ? "success" : "failed";
  await db.update(pipelineRuns).set({ status, finishedAt: new Date(), newItems: 1, published: 0 }).where(eq(pipelineRuns.id, run.id));

  const { revalidatePath } = await import("next/cache");
  revalidatePath("/runs"); revalidatePath("/queue"); revalidatePath("/dashboard");
  return articleId
    ? { ok: true as const, message: "Élément retraité — article déposé en revue.", articleId }
    : { ok: false as const, message: "Le retraitement a échoué (voir la trace de l'exécution)." };
}
```
> `stageItem` bypasses dedup by construction (we operate on the stored `raw_item`; we do NOT call `isSeen`/`recordRawItem`). It still only stages `pending`. Confirm `pipelineRuns.triggeredBy` accepts the free-text `"reprocess"` (it's a text column, default "scheduled").

- [ ] **Step 3: Run guard test → PASS** — `bun test tests/reprocess.test.ts`.

- [ ] **Step 4: Add a self-cleaning integration test (dedup-bypass + pending-stage)**

Extend `tests/reprocess.test.ts` with a DB test (network-free by forcing mock providers via absent keys — the `test-setup.ts` preload already deletes provider keys, so extraction→readability + MockLLM + MockEmbedder run): insert a temp `feed` + a `raw_items` row whose `url` points at a tiny `Bun.serve` HTML fixture; call the pipeline stage path the action uses (either call `reprocessRawItem` directly — but it needs a session; simpler: call `stageItem` directly with the fixture item to prove it stages a `pending` article even though a `raw_items` row with that guid/hash already exists, i.e. dedup is bypassed). Assert an `articles` row `status='pending'` was created for the already-"seen" item. Clean up (article → cascade, then temp raw_item/feed) in `afterAll`; reseed if needed.

- [ ] **Step 5: Run tests + typecheck + build** — `bun test tests/reprocess.test.ts && bun run typecheck && bun run build`. Reseed if rows mutated.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(runs): reprocessRawItem action — retry a failed item bypassing dedup, stages pending"`

---

## Task 3: Run-detail Sheet UI

**Files:** Create `components/pipeline/run-detail-sheet.tsx`, `components/ui/collapsible.tsx` (shadcn CLI); Test: manual (Task 5).

**Interfaces:**
- Consumes: `RunDetail` (from `getRunDetail`), `runPipelineNow`, `reprocessRawItem`, `RoleGate`, `pipelineStatusLabel`, status tokens, `formatDate`, shadcn `Sheet`/`Collapsible`, `sonner`.
- Produces: `<RunDetailSheet run={RunDetail|null} open onOpenChange />` — the drawer content.

- [ ] **Step 1: Add the collapsible primitive** — `bunx shadcn@latest add collapsible` (Base UI-based; use its real API — `render` not `asChild`).

- [ ] **Step 2: Build `run-detail-sheet.tsx` (client)**

A shadcn `Sheet` (side="right") rendering, when `run` is set:
- **Summary header:** pipeline status (colored label via `pipelineStatusLabel` + `--status-*` token), déclencheur, `formatDate(startedAt)` + durée (`finishedAt−startedAt` or "en cours"), flux lus / nouveaux. If any item step group carries a degraded flag context, a subtle "fournisseur dégradé" note (optional).
- **Recovery (top), in `RoleGate allow={["admin"]}`:** "Relancer l'exécution" → `runPipelineNow()` in a transition, toast result.
- **Feed-level steps:** a simple list (name · status badge · durée).
- **Per-item groups:** for each `items[]`, a `Collapsible` titled with the item `title` (+ external link to `url`) and an aggregate status badge (failed if `hasFailure`). Expanded: the ordered steps (name · status badge · durée); each **failed** step shows its French `errorMessage` prominently and a nested `Collapsible` "Voir les détails techniques" revealing `errorTechnical` in a `<pre>`. On a group with `hasFailure`, inside `RoleGate allow={["admin"]}`, a "Relancer cet élément" button → `reprocessRawItem(rawItemId)` in a transition, toast the outcome.
- **States:** if `run` has no steps → "Aucune étape enregistrée." French throughout.

Keep it presentational — data comes in via the `run` prop (fetched by the page/wrapper in Task 4). Provide the full component code following the Base UI `render`-prop patterns already used in `components/article/*` and `components/queue/*`.

- [ ] **Step 3: typecheck** — `bun run typecheck` clean.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(runs): run-detail Sheet with grouped step trace + technical disclosure + recovery"`

---

## Task 4: Runs view wrapper (clickable rows + drawer + auto-refresh)

**Files:** Create `components/pipeline/runs-view.tsx`; Modify `app/(app)/runs/page.tsx`; Test: manual (Task 5).

**Interfaces:**
- Consumes: the runs list rows (from the page's existing query) + `getRunDetail` (via a server action or an on-demand fetch) + `RunDetailSheet` + `RunNow` + `useRouter`.
- Produces: `<RunsView runs={RunRow[]} />` — client: renders the table (rows clickable), opens `RunDetailSheet` for the clicked run, and auto-refreshes while any run is `running`.

- [ ] **Step 1: A server action to fetch a run's detail on demand**

Add to `lib/actions/pipeline-actions.ts` a thin read action `getRunDetailAction(runId)` that dynamic-imports and returns `getRunDetail(runId)` (or fetch it in the page for all runs up front — but on-demand keeps the payload small). RBAC: `pipeline:read`. (Dynamic-import to stay build-safe.)

- [ ] **Step 2: Build `runs-view.tsx` (client)**

- Renders the runs table (move the table JSX from `page.tsx` here), each row `onClick` → sets `openRunId`, calls `getRunDetailAction(id)` (in a transition), and opens `<RunDetailSheet>`. Keep the header with `<RunNow/>` and the empty state.
- **Auto-refresh:** `useEffect` — if `runs.some(r => r.status === "running")`, `const t = setInterval(() => router.refresh(), 4000); return () => clearInterval(t);` (dependency on the running condition). No interval when nothing is running.

- [ ] **Step 3: Wire `page.tsx`**

`app/(app)/runs/page.tsx` (RSC) keeps `requireUser()` + `requirePermission(role,"pipeline","read")` + the runs list query, then renders `<RunsView runs={runs} />`. Header/`RunNow` moves into `RunsView`.

- [ ] **Step 4: typecheck + build** — `bun run typecheck && bun run build` clean (the page/action importing the pipeline stays build-safe via dynamic imports).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(runs): clickable rows, detail drawer wiring, auto-refresh while running"`

---

## Task 5: End-to-end verification

**Files:** none (verification).

- [ ] **Step 1: Green baseline** — `bun run typecheck && bun test && bun run build` all pass.

- [ ] **Step 2: Produce real data + a failure to inspect** — run a real bounded pipeline run (as in SP3 Task 10: `runPipeline({triggeredBy:"manual", feedIds:[<one active feed>]})` with `MAX_ITEMS_PER_RUN=3`) so there are runs with per-item steps (incl. any failed item). If no failure occurs naturally, temporarily point one item at an unreachable URL / force a provider error to get a failed step to inspect.

- [ ] **Step 3: Drive the app (run/verify skill)** — `bun run dev`, sign in as `admin@afrotiative.com`:
  1. Open **/runs**; while a run is in flight, confirm the list auto-refreshes (status/steps appear without manual reload) and stops when done.
  2. Click a run row → the Sheet opens with the summary + grouped step trace; expand a per-item group; for a failed step, confirm the **French message** shows and "Voir les détails techniques" reveals the technical detail.
  3. On a failed item, click **"Relancer cet élément"** → toast; open the Review Queue → the reprocessed article appears as `pending` (proving dedup was bypassed) — OR the toast explains the failure and a new `reprocess` run shows its trace.
  4. Click **"Relancer l'exécution"** → a new run appears.
  5. Confirm **nothing was published** by any of this.
- [ ] **Step 4: RBAC check** — sign in as `journaliste@afrotiative.com`: `/runs` is not in the sidebar and visiting it is refused; sign in as `editor@afrotiative.com`: can view runs + details but sees NO recovery buttons.

- [ ] **Step 5: Cleanup** — delete the rows the verification created (runs/steps/articles/embeddings/clusters/raw_items) or `bun run db:seed` to restore the baseline; confirm 25 articles. Remove any throwaway scripts.

- [ ] **Step 6: Final commit / tag** — `git add -A && git commit -m "chore: SP4 verified — pipeline observability drawer + reprocess end-to-end" || echo "nothing to commit"; git tag sp4-complete`

---

## Self-Review Notes (coverage map)

- **Spec §3 additive column** → Task 1 Step 1. **§4 step attribution** → Task 1 Step 2. **§5 getRunDetail/grouping** → Task 1 Steps 3–5. **§6 UI (Sheet, grouped trace, technical disclosure, states)** → Tasks 3–4. **§7 reprocess action (RBAC, dedup-bypass, pending-only)** → Task 2. **§8 auto-refresh** → Task 4 Step 2. **§9 RBAC (view read / actions configure)** → Tasks 2, 3, 4 (RoleGate + requirePermission + page gate). **§10 tests/verification** → each task + Task 5.
- **Human-review gate:** reprocess only stages `pending` (Task 2) — verified in Task 5 Step 5.
- **Additive-only migration** (Task 1 Step 1) — reviewer must confirm the generated SQL is ADD COLUMN only.
- **Deferred (not SP4):** WordPress publish (SP5); SP0+SP1 Tasks 14–15; real-time intra-step streaming (auto-refresh suffices).
```
