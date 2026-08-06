import { db, feeds, pipelineRuns, pipelineSteps, wpCategories } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { parseFeed } from "@/lib/rss/parse-feed";
import { isSeen, recordRawItem } from "./dedup";
import { stageSources, type SourceInput } from "./stages";
import { withTimeout } from "./timeout";
import { extract, extractExternal, hasExternalExtractor } from "@/lib/extract";
import { embed, cosine } from "@/lib/embeddings";
import { hasRunningRun } from "./overlap";
import { updateFeedHealth } from "./feed-health";
import { getPipelineSettings } from "@/lib/queries/settings";
import { createAlert } from "@/lib/alerts/notify";
import { searchRelated } from "@/lib/search";
import type { RawItem } from "@/lib/rss/parse-feed";
import type { RunCheckpoint, RunParams } from "@/db";
import { isWithinRecency, narrowByRecency } from "./recency";
import { cutoffDate, resolveRunParams } from "./run-params";

// A same-story group can in principle grow past any sane article/prompt size (a viral story might
// match dozens of candidates in one run) — cap how many of its members actually become
// article_sources rows. Members beyond the cap are still recordRawItem()'d (marked seen, per the
// dedup-tension fix below) but are never extracted/synthesized — "capped as sources, not dropped
// from dedup".
const STORY_GROUP_CAP = 6;

export type RunTrigger = "manual" | "scheduled";
// SP5 Task 3 adds "cancelled" — a run stopped mid-flight via cancelRun(), distinct from the
// computed success/partial/failed tally (which is never used when the run was cancelled).
// SP5 Task 4 adds "paused" — a run parked mid-flight via pauseRun(), holding a checkpoint of its
// remaining stories; also never reaches the computed tally.
export type RunStatus = "success" | "partial" | "failed" | "skipped" | "cancelled" | "paused";
export type RunResult = { runId: string | null; status: RunStatus; produced: number };

// Drizzle wraps driver errors in DrizzleQueryError, so the pg SQLSTATE lives on `.cause` (not the
// top-level error) — walk the cause chain to find it.
function pgErrorCode(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur != null; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

// pg unique-violation SQLSTATE — raised by the pipeline_runs_one_running partial unique index
// when a second run tries to open a "running" row while one already exists.
function isUniqueViolation(e: unknown): boolean {
  return pgErrorCode(e) === "23505";
}

// Best-effort human-readable label for a web-search source when no feed name applies — the
// hostname (without a leading "www.") reads better in the references list than a raw URL. Falls
// back to the search hit's own title if the URL doesn't parse (defensive; searchRelated's hits
// always carry a real HTTP(S) URL, but this is cheap insurance against a malformed one).
function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

// Best-effort single-step insert (observability only — never block the run). Steps are now
// inserted incrementally as they happen (live progress), rather than batched at the end.
async function insertStep(row: {
  runId: string; name: string; status: "success" | "failed" | "partial";
  durationMs: number | null; errorMessage?: string; errorTechnical?: string; rawItemId?: string | null;
}): Promise<void> {
  try { await db.insert(pipelineSteps).values(row); } catch { /* observability only */ }
}

// Best-effort progress write (observability only — never fail or skew a real run). A transient DB
// error on a pure-progress UPDATE must NOT surface: inside the per-feed try it would be miscounted
// as a feed-read failure (double-counting the feed as read AND failed), and the phase-2 calls sit
// outside the per-item try, so an error there would abort the whole run as failed even if items
// already succeeded. The finalize update in executeRun's `finally` is deliberately NOT routed
// through here — that one must still propagate.
async function setProgress(runId: string, fields: Partial<{
  phase: string; feedsTotal: number; totalItems: number; processedItems: number;
  currentStage: string | null; currentItem: string | null; feedsRead: number;
}>): Promise<void> {
  try { await db.update(pipelineRuns).set(fields).where(eq(pipelineRuns.id, runId)); } catch { /* observability only */ }
}

// SP5 Task 3/4 — cooperative control-flag check: a FRESH re-read of this run's cancel_requested
// AND pause_requested flags (one select), never a closed-over local. Both flags are flipped
// out-of-process by the cancelRun()/pauseRun() actions while executeRun is already mid-flight (a
// detached promise), so the only way executeRun can learn about either is by polling the row at
// safe boundaries. Best-effort like setProgress: a transient read failure must never abort (or
// falsely cancel/pause) an otherwise healthy run, so it degrades to "neither" rather than throwing
// — a flag that was truly set will simply be observed at the next boundary instead.
async function checkControlFlags(runId: string): Promise<{ cancelled: boolean; paused: boolean }> {
  try {
    const [row] = await db.select({
      cancelRequested: pipelineRuns.cancelRequested, pauseRequested: pipelineRuns.pauseRequested,
    }).from(pipelineRuns).where(eq(pipelineRuns.id, runId));
    return { cancelled: row?.cancelRequested ?? false, paused: row?.pauseRequested ?? false };
  } catch {
    return { cancelled: false, paused: false };
  }
}

/**
 * Opens a run row and holds the one-running slot. Returns the new run's id, or `null` if a run
 * is already active (either the app-level hasRunningRun() check, or the pipeline_runs_one_running
 * partial unique index losing a race on insert — both cases back off cleanly, never crash).
 */
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

/**
 * Two-phase execution of an already-opened run. ALWAYS finalizes the row to a terminal status —
 * a mid-run throw or process death can never strand it "running" (which would otherwise block
 * every future run via the pipeline_runs_one_running index).
 *
 * Phase 1 (reading_feeds): reads EVERY target feed — even past the item cap — so feed-health
 * signals (feedsRead) and totalItems are exact. Each item is first filtered by the recency cutoff
 * (isWithinRecency(item.isoDate, cutoff)): items published before the cutoff are skipped (counted
 * in tooOld) and never recorded; undated/unparseable-date items are kept (undated-include policy).
 * Surviving items become NEW candidates (dedup'd by isSeen() and an intra-batch hash set),
 * collected across ALL feeds WITHOUT an in-loop cap. Only once every feed has been read is the
 * item cap (maxItemsPerRun) applied, by narrowByRecency(candidates, ..., maxItems): it keeps the
 * most-recent maxItems candidates (undated ranked as oldest) and counts the rest in overCap. This
 * narrowing happens strictly BEFORE grouping/embedding (below), so embedding — and everything
 * downstream — stays bounded by maxItems, not by however many candidates survived recency
 * filtering. Both tooOld and overCap surface as their own visible "partial" pipeline_steps rows
 * (see below) — neither is a silent truncation.
 *
 * Grouping (SP4 Task 6a — corpus cross-check, no web search): each candidate is embedded on its
 * lightweight RSS metadata (title + snippet — cheap, no extraction/network fetch yet) and greedily
 * joined to an existing group when its cosine similarity to that group's FIRST member reaches
 * settings.clusterThreshold, else it starts a new group. This is a PURE in-memory JS cosine over
 * two same-dimension vectors — never a pgvector round-trip — because it's comparing THIS run's
 * candidates against each other, not against the persisted article corpus (that's decideCluster's
 * job, still used per-story below for cross-run cluster assignment/scoring).
 *
 * Phase 2 (processing_items): one STORY (group) per processed unit — total_items/processed_items
 * count GROUPS, not raw candidates. For every group: record EVERY member (recordRawItem) — this is
 * the dedup-tension fix: a candidate merged into a multi-source story is marked seen exactly once,
 * here, so it can never resurface as its own separate article on a later run — then extract each
 * member's content (up to STORY_GROUP_CAP; extra members are still recorded/seen but excluded from
 * extraction/synthesis) and hand the resulting sources to ONE stageSources() call, which
 * synthesizes ONE multi-source article. Live progress hooks still persist current_stage/each step
 * as they happen; current_item is the group's primary (first member's) title.
 *
 * A feed that fails to parse, or a group that fails at any stage, is recorded as a failed
 * pipeline_steps row and the run continues — a single failure never aborts the whole run.
 * Hitting the item cap is recorded explicitly (never a silent truncation).
 *
 * SP8 — each feed's health row (lastFetchAt/lastFetchStatus/consecutiveFailures/itemsCaptured7d)
 * is best-effort updated (lib/pipeline/feed-health.ts's updateFeedHealth) right after ITS OWN
 * parse outcome is known, inside phase 1's per-feed try/catch. Because phase 1 only runs on a
 * fresh (non-resume) call, feed health is updated ONLY on the initial run of a paused/resumed
 * pipeline, never again on the resume call itself — see the resume-path note below.
 *
 * SP5 Task 4 — resume path: when `opts.resumeStories` is passed (by resumeRun(), after a prior
 * call to this same function paused), phase 1 (feed read + grouping) is SKIPPED ENTIRELY — the
 * checkpoint's remaining stories become this call's phase-2 groups directly. total_items and the
 * processed_items starting point are read from the row (they belong to the ORIGINAL run and
 * already reflect progress made before the pause) rather than reset, so progress continues rather
 * than restarting at 0/0.
 */
export async function executeRun(
  runId: string,
  opts: { feedIds?: string[]; resumeStories?: RunCheckpoint["stories"] } = {},
): Promise<RunResult> {
  let feedsRead = 0, feedsFailed = 0, newItems = 0, produced = 0, itemFailures = 0, overCap = 0, tooOld = 0;
  let capHit = false, targetFeedsLength = 0;
  let status: RunStatus = "failed";
  // SP5 Task 3: set the moment a cooperative cancel check observes cancel_requested=true. Declared
  // here (not inside the try) so the `finally` below can see it and write the terminal status
  // "cancelled" instead of the computed success/partial/failed tally.
  let cancelled = false;
  // SP5 Task 4: set the moment a cooperative check observes pause_requested=true (and cancel was
  // NOT also set — cancel always takes precedence, see checkControlFlags call sites below).
  // remainingStories is captured at the SAME moment: exactly the stories not yet processed, in the
  // exact member shape (`{ feedId, feedName, item }`) the checkpoint column expects.
  let paused = false;
  let remainingStories: RunCheckpoint["stories"] = [];

  try {
    // Inside the try (not before it): if getPipelineSettings() ever throws, the finally below must
    // still finalize the row rather than leaving it stuck "running".
    // DB-backed (SP1): maxItemsPerRun is admin-editable at /settings/pipeline, not just env —
    // getPipelineConfig() stays for provider/secret/order config elsewhere in the pipeline.
    const settings = await getPipelineSettings();
    const categoryNames = (await db.select({ name: wpCategories.name }).from(wpCategories)).map((c) => c.name);

    // Params live on the run row (resolved at trigger). Read once; drives feed targeting, the item
    // cap, and the recency cutoff. Null for legacy rows / direct executeRun callers → no cutoff,
    // opts.feedIds fallback, settings.maxItemsPerRun.
    const [runRow] = await db.select({ params: pipelineRuns.params }).from(pipelineRuns).where(eq(pipelineRuns.id, runId));
    const params = runRow?.params ?? null;
    const cutoff = params ? cutoffDate(params) : null;
    const maxItems = params?.maxItems ?? settings.maxItemsPerRun;

    type Candidate = { item: RawItem; feedId: string; feedName: string };
    type Group = { members: Candidate[] };
    let groups: Group[];
    // Starting point for the processed-stories counter below — 0 for a fresh run, or the row's
    // current processed_items for a resume (see the resume branch).
    let processedStart = 0;

    if (opts.resumeStories) {
      // SP5 Task 4 resume path — SKIP phase 1 (no feed read, no grouping): the checkpoint's
      // remaining stories become this call's phase-2 groups directly.
      groups = opts.resumeStories.map((members) => ({ members }));
      // SP5 Task 5: the "Reprise de l'exécution" step is inserted by resumeRun() itself
      // (lib/actions/pipeline-actions.ts), BEFORE the status flip — while the run is still
      // "paused" — so a fresh step already exists the instant the row becomes "running" (see
      // resumeRun's doc comment for why that ordering, not started_at, is what keeps a resumed run
      // reaper-safe now that started_at is no longer refreshed on resume). Do NOT insert it again
      // here — that would double-insert it for every resume.
      // feedsRead/newItems are DB-persisted stats the `finally` below unconditionally overwrites —
      // seed them from the row so a resumed run's finalize doesn't regress stats accumulated
      // before the pause (this call itself reads zero feeds and may record zero NEW items if the
      // remaining stories all fail before recordRawItem). processedItems is the row's own resumable
      // progress counter — continue incrementing FROM it, never reset to 0.
      const [prior] = await db.select({
        processedItems: pipelineRuns.processedItems, feedsRead: pipelineRuns.feedsRead, newItems: pipelineRuns.newItems,
      }).from(pipelineRuns).where(eq(pipelineRuns.id, runId));
      processedStart = prior?.processedItems ?? 0;
      feedsRead = prior?.feedsRead ?? 0;
      newItems = prior?.newItems ?? 0;
      await setProgress(runId, { phase: "processing_items" }); // deliberately no totalItems/processedItems here
    } else {
      const paramFeedIds = params?.feedIds ?? opts.feedIds;
      const targetFeeds = paramFeedIds != null
        ? (paramFeedIds.length > 0 ? await db.select().from(feeds).where(inArray(feeds.id, paramFeedIds)) : [])
        : await db.select().from(feeds).where(eq(feeds.active, true));
      targetFeedsLength = targetFeeds.length;

      await setProgress(runId, { phase: "reading_feeds", feedsTotal: targetFeedsLength });

      // ---- Phase 1: read ALL feeds, collect candidates (no recording yet) ----
      const candidates: Candidate[] = [];
      const seenHashes = new Set<string>(); // intra-batch dedup across feeds in this run

      for (const feed of targetFeeds) {
        const t0 = Date.now();
        let items: RawItem[];
        try {
          items = await parseFeed(feed.feedUrl);
          feedsRead++;
          await insertStep({ runId, name: `Lecture du flux « ${feed.name} »`, status: "success", durationMs: Date.now() - t0 });
          await setProgress(runId, { feedsRead });
          // SP8 — best-effort feed-health update (never fails the run): recorded here, inside this
          // feed's own try, right after its parse outcome (success) is known. See
          // lib/pipeline/feed-health.ts's updateFeedHealth doc comment for exactly what it writes
          // and the itemsCaptured7d one-run-lag caveat. Note: the resume path (opts.resumeStories)
          // skips phase 1 entirely, so feed health is only ever updated on the INITIAL run, never
          // on a resume — acceptable per the SP8 plan (a resumed run reads no new feeds anyway).
          try { await updateFeedHealth(feed.id, feed.name, "success"); } catch { /* best-effort — never fail the run */ }
        } catch (e) {
          feedsFailed++;
          await insertStep({
            runId, name: `Lecture du flux « ${feed.name} »`, status: "failed", durationMs: Date.now() - t0,
            errorMessage: `La lecture du flux « ${feed.name} » a échoué : ${(e as Error).message}`, errorTechnical: (e as Error).stack,
          });
          // SP8 — same best-effort feed-health update, on the failure path (see note above).
          try { await updateFeedHealth(feed.id, feed.name, "failure"); } catch { /* best-effort — never fail the run */ }
          continue;
        }
        for (const item of items) {
          if (!isWithinRecency(item.isoDate, cutoff)) { tooOld++; continue; }  // published before cutoff
          if (seenHashes.has(item.contentHash)) continue;                       // duplicate within this run
          if (await isSeen(feed.id, item)) continue;                            // already processed by a prior run
          seenHashes.add(item.contentHash);
          candidates.push({ item, feedId: feed.id, feedName: feed.name });      // NO cap here — narrowed below
        }
      }

      // Apply the cap AFTER all filtering: keep the most-recent maxItems (undated = oldest). This
      // replaces the old running counter, which dropped items by feed-read order rather than recency.
      const narrowed = narrowByRecency(candidates, (c) => c.item.isoDate, maxItems);
      if (narrowed.dropped.length > 0) { capHit = true; overCap = narrowed.dropped.length; }
      const kept = narrowed.kept;

      // ---- Story grouping (SP4 Task 6a): greedily group candidates by cosine similarity of their
      // lightweight (title+snippet) embedding to each existing group's FIRST member. A hash-based
      // mock embedder (no embed provider configured) produces uncorrelated vectors for ANY differing
      // input, so in practice — and by design in tests — only genuinely identical/near-identical
      // metadata joins a group under the mock fallback; a real semantic embedder groups true
      // same-story duplicates. groupVectors is parallel to builtGroups (index i = its join target).
      const builtGroups: Group[] = [];
      const groupVectors: number[][] = [];
      for (const c of kept) {   // was: for (const c of candidates)
        const { vector } = await embed(`${c.item.title}\n${c.item.contentSnippet}`);
        let joinedIndex = -1;
        for (let i = 0; i < builtGroups.length; i++) {
          if (cosine(vector, groupVectors[i]) >= settings.clusterThreshold) { joinedIndex = i; break; }
        }
        if (joinedIndex >= 0) builtGroups[joinedIndex].members.push(c);
        else { builtGroups.push({ members: [c] }); groupVectors.push(vector); }
      }
      groups = builtGroups;

      await setProgress(runId, { phase: "processing_items", totalItems: groups.length, processedItems: 0 });
    }

    // SP5 Task 3/4 — cooperative cancel+pause check (a): safe boundary right after phase 1 (read +
    // collect + group) OR immediately on resume, before phase 2 begins processing stories. Cancel
    // takes precedence over pause when both are somehow set.
    //
    // SP5 Task 4 review C2 — only PAUSE if there is remaining work (groups.length > 0). Pausing a
    // zero-work run (a quiet run where every candidate was a duplicate, or every feed failed) would
    // park it forever: the checkpoint would be empty, so resumeRun refuses it, cancelRun's flag has
    // no in-flight executeRun to observe it (fixed separately, but still), and the reaper skips
    // paused — the run would hold the single active slot with no way to release it. A zero-work run
    // must instead finalize NORMALLY (the tally below → typically "success" for an all-duplicate
    // run), freeing the slot. Cancel has no such guard: a cancel of a zero-work run finalizes
    // terminally (finished_at set) regardless, so it never strands the slot.
    {
      const flags = await checkControlFlags(runId);
      if (flags.cancelled) cancelled = true;
      else if (flags.paused && groups.length > 0) { paused = true; remainingStories = groups.map((g) => g.members); }
    }

    // ---- Phase 2: process each STORY (group) — synthesize ONE multi-source article per group ----
    let processed = processedStart;
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      if (cancelled || paused) break;
      // SP5 Task 3/4 — cooperative cancel+pause check (b): safe boundary at the top of each story
      // iteration, so a cancelRun()/pauseRun() issued mid-phase-2 (between two stories) stops
      // further processing. Already-produced articles from earlier stories in this run stay as-is
      // (they're "pending"); this story's own members were never recordRawItem()'d, so — like
      // every other un-started story — they resurface as fresh candidates on the next run (cancel)
      // or are captured verbatim into the checkpoint for resumeRun() to replay later (pause).
      const flags = await checkControlFlags(runId);
      if (flags.cancelled) { cancelled = true; break; }
      if (flags.paused) { paused = true; remainingStories = groups.slice(groupIndex).map((g) => g.members); break; }

      const group = groups[groupIndex];
      const primary = group.members[0];
      await setProgress(runId, { currentItem: primary.item.title, currentStage: null });

      const inSources = group.members.slice(0, STORY_GROUP_CAP);
      const overflow = group.members.slice(STORY_GROUP_CAP);

      try {
        // Record EVERY member first (marks them seen — the dedup-tension fix: a member merged into
        // this story can never resurface as its own candidate on a later run) and take the FIRST
        // member's rawItemId as the story's single attribution key. ALL of this story's steps —
        // the one extraction step below AND the synthesis steps — are attributed to this ONE
        // primaryRawItemId, so groupSteps() (lib/queries/runs.ts) buckets the whole story as a
        // single run-detail item and the live panel renders its full 5-node stepper (rather than
        // splitting per-member and showing an extraction-only fragment for the flagship story).
        let primaryRawItemId: string | null = null;
        const memberRawIds: { m: Candidate; rawItemId: string }[] = [];
        for (const m of inSources) {
          const rawItemId = await recordRawItem(m.feedId, m.item);
          newItems++;
          if (primaryRawItemId === null) primaryRawItemId = rawItemId;
          memberRawIds.push({ m, rawItemId });
        }
        // Members beyond STORY_GROUP_CAP: still recorded/seen (dedup fix applies to every match),
        // but never extracted — "capped as sources, not dropped from dedup".
        for (const m of overflow) {
          await recordRawItem(m.feedId, m.item);
          newItems++;
        }

        // ONE "Extraction du contenu" step for the WHOLE story (exact name → maps to the stepper's
        // Extraction node), attributed to primaryRawItemId. It times ONLY member (feed-source)
        // extraction — web augmentation, when it runs, is a SEPARATE "Recherche web" step — and is
        // marked failed only if NO member yielded usable text: a single dead link in a multi-source
        // story just yields one fewer source, never a failed story.
        await setProgress(runId, { currentStage: "Extraction du contenu" });
        const t0 = Date.now();
        const sources: SourceInput[] = [];
        let lastExtractError: Error | null = null;
        for (const { m } of memberRawIds) {
          try {
            // SP5 Task 2: bounded by settings.perOperationTimeoutMs — a hung fetch/extract on one
            // member can't stall this story (let alone the whole run) forever. A timeout here is
            // caught by this same try/catch exactly like any other extraction failure: the member
            // is skipped (best-effort), never escaping to fail the group or the run.
            const r = await withTimeout(extract(m.item.url), settings.perOperationTimeoutMs, "Extraction du contenu");
            const text = (r.text || m.item.contentSnippet).trim();
            // Non-empty text only — falls back to the RSS snippet when extraction yields nothing
            // (r.via === "none" or empty body); a member with no usable text contributes no source
            // (rather than an empty article_sources row) but is still recorded/seen above.
            if (text.length > 0) sources.push({ mediaName: m.feedName, url: m.item.url, text, images: r.images });
          } catch (e) {
            lastExtractError = e as Error;
            // Best-effort skip (SP5 Task 2 review, Finding 3): a member whose extraction failed OR
            // timed out contributes no source but doesn't fail the story (unless it was the ONLY
            // member — see the sources.length === 0 branch below). Leave an operator trace, mirroring
            // the degradation warn in stages.ts, so a silently-dropped source is at least visible in logs.
            console.warn(`[pipeline] source ignorée (extraction échouée/expirée) : ${m.item.url} — ${(e as Error).message}`);
          }
        }
        // Captured HERE — before the optional web block — so the "Extraction du contenu" step's
        // duration reflects ONLY feed-source extraction (what admins expect that step to mean in
        // the run-detail sheet), not the extra latency of the "Recherche web" step.
        const memberExtractionMs = Date.now() - t0;

        if (sources.length === 0) {
          // Every member's extraction failed → the story fails exactly as in 6a. Web search is
          // ENRICHMENT/corroboration of an already-sourced story, NOT a rescue path: a story whose
          // feed sources all failed must fail, so web augmentation is deliberately NOT attempted
          // here (it lives in the else-branch below, gated on ≥1 usable member source).
          itemFailures++;
          await insertStep({
            runId, name: "Extraction du contenu", status: "failed", durationMs: memberExtractionMs,
            errorMessage: `Aucune source exploitable pour le groupe « ${primary.item.title} ».`,
            errorTechnical: lastExtractError?.stack, rawItemId: primaryRawItemId,
          });
        } else {
          await insertStep({ runId, name: "Extraction du contenu", status: "success", durationMs: memberExtractionMs, rawItemId: primaryRawItemId });

          // SP4 Task 6b — best-effort web-search ENRICHMENT of an ALREADY-sourced story. Reached
          // ONLY once ≥1 member yielded usable text (this is the else branch of the extraction
          // decision), so web coverage corroborates/tops up real feed sources and never rescues a
          // story whose feed sources all failed. Entirely opt-in (settings.webSearchEnabled) and
          // SSRF-safe: web-result URLs are UNTRUSTED (arbitrary internet, picked by a third-party
          // search API, never a feed we chose to follow), so they are ONLY ever extracted via
          // extractExternal() (jina reader / firecrawl — external infra, no SSRF surface from our
          // server) — never the direct-fetch readability path. Nothing here can fail the story or
          // the run: searchRelated() never throws by contract, every per-hit extraction is
          // individually try/caught, and the whole block is wrapped so even an unexpected throw
          // only marks this ONE observability step "failed" instead of aborting the group (the
          // member sources gathered above are untouched either way).
          if (settings.webSearchEnabled) {
            if (!hasExternalExtractor()) {
              console.warn(
                `[pipeline] recherche web ignorée pour « ${primary.item.title} » : aucun extracteur externe ` +
                `(Jina/Firecrawl) n'est configuré — les URLs web ne sont jamais récupérées directement (protection SSRF).`
              );
            } else {
              const tWeb = Date.now();
              let webAdded = 0;
              try {
                const memberUrls = new Set(inSources.map((m) => m.item.url));
                const remainingCap = STORY_GROUP_CAP - sources.length;
                if (remainingCap > 0) {
                  const hits = await searchRelated(primary.item.title, { limit: 3 });
                  for (const hit of hits) {
                    if (sources.length >= STORY_GROUP_CAP) break;
                    // Skip a web URL already covered by a member (or an earlier hit this same
                    // loop) — stageSources also dedupes by URL, but skipping here keeps the
                    // "N source(s) web ajoutée(s)" count below accurate.
                    if (memberUrls.has(hit.url) || sources.some((s) => s.url === hit.url)) continue;
                    try {
                      const r = await extractExternal(hit.url);
                      // Unlike a member's fallback to its RSS contentSnippet (a trusted feed's own
                      // description), a web hit's `snippet` is just a search-engine blurb — NOT a
                      // stand-in for the article's real content. A failed/empty extraction must
                      // skip this source outright rather than stage the search snippet as if it
                      // were extracted text.
                      const text = r.text.trim();
                      if (text.length > 0) {
                        sources.push({ mediaName: hostOf(hit.url) || hit.title, url: hit.url, text, images: r.images });
                        webAdded++;
                      }
                    } catch {
                      // Best-effort: a failed web fetch/extract just skips this one source.
                    }
                  }
                }
                await insertStep({
                  runId, name: "Recherche web", status: "success", durationMs: Date.now() - tWeb,
                  errorMessage: `${webAdded} source(s) web ajoutée(s).`, rawItemId: primaryRawItemId,
                });
              } catch (e) {
                await insertStep({
                  runId, name: "Recherche web", status: "failed", durationMs: Date.now() - tWeb,
                  errorMessage: `La recherche web a échoué : ${(e as Error).message}`,
                  errorTechnical: (e as Error).stack, rawItemId: primaryRawItemId,
                });
              }
            }
          }

          const { articleId } = await stageSources(sources, categoryNames, {
            onStageStart: (name) => setProgress(runId, { currentStage: name }),
            onStageEnd: (step) => insertStep({
              runId, name: step.name, status: step.status, durationMs: step.durationMs,
              errorMessage: step.errorMessage, errorTechnical: step.errorTechnical, rawItemId: primaryRawItemId,
            }),
          }, settings.perOperationTimeoutMs, {
            // SP6 — threaded the same way as perOperationTimeoutMs above: settings was already
            // read once at the top of this run, so this never triggers stageSources's own
            // getPipelineSettings() fallback read.
            enabled: settings.autoPublishEnabled,
            scoreThreshold: settings.scoreThreshold,
            minSources: settings.autoPublishMinSources,
          });
          if (articleId) produced++; else itemFailures++;
        }
      } catch (e) {
        itemFailures++;
        await insertStep({
          runId, name: "Traitement du groupe", status: "failed", durationMs: null,
          errorMessage: `Le traitement d'un groupe (« ${primary.item.title} ») a échoué : ${(e as Error).message}`,
          errorTechnical: (e as Error).stack,
        });
      }
      processed++;
      await setProgress(runId, { processedItems: processed });
    }

    // No silent truncation: hitting the cap gets its own visible, plain-language step.
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

    if (cancelled) {
      // SP5 Task 3: a neutral, best-effort observability step — recorded here (still inside the
      // outer try) rather than in the `finally`, so a failure to insert it can never interfere with
      // finalization. "partial" (not "failed"): a cancel is a deliberate admin action, not an error.
      // Already-produced articles from stories processed before the cancel stay as they are
      // (they're "pending" — the human-review barrier is untouched); this run's remaining/unstarted
      // stories were never recordRawItem()'d, so they resurface as fresh candidates next run.
      await insertStep({
        runId, name: "Exécution annulée par l'utilisateur", status: "partial", durationMs: null,
        errorMessage:
          `L'exécution a été annulée par l'utilisateur après le traitement de ${processed - processedStart} histoire(s) sur ${groups.length} (sur cet appel).`,
      });
    } else if (paused) {
      // SP5 Task 4: same best-effort observability placement as the cancel step above (still
      // inside the outer try, never in `finally`). "partial" — pausing is a deliberate admin
      // action, not an error, and there is nothing terminal to tally: the remaining stories are
      // captured verbatim in remainingStories/the checkpoint, untouched (no recordRawItem, no
      // extraction), for resumeRun() to replay later exactly like a fresh phase 2.
      await insertStep({
        runId, name: "Exécution mise en pause", status: "partial", durationMs: null,
        errorMessage:
          `L'exécution a été mise en pause par l'utilisateur après le traitement de ${processed - processedStart} `
          + `histoire(s) sur ${groups.length} (sur cet appel) ; ${remainingStories.length} histoire(s) restante(s) `
          + `seront reprises à la reprise de l'exécution.`,
      });
    } else {
      // Status tally:
      //  - failed  = every feed failed to parse, OR items were attempted and NONE succeeded.
      //  - partial = some feeds/items failed (or the cap was hit) but at least one item was produced.
      //  - success = no failures at all — including a quiet run where every item was a duplicate
      //              (itemsAttempted === 0), which must read as success, not failed.
      const itemsAttempted = produced + itemFailures;
      const allFeedsFailed = targetFeedsLength > 0 && feedsFailed === targetFeedsLength;
      const allItemsFailed = itemsAttempted > 0 && produced === 0;
      status =
        allFeedsFailed || allItemsFailed ? "failed"
        : feedsFailed > 0 || itemFailures > 0 || capHit ? "partial"
        : "success";
    }
  } catch (e) {
    // Catastrophic error outside the per-feed/per-item guards (e.g. the feeds/category query).
    status = "failed";
    await insertStep({
      runId, name: "Exécution du pipeline", status: "failed", durationMs: null,
      errorMessage: `L'exécution du pipeline a échoué : ${(e as Error).message}`, errorTechnical: (e as Error).stack,
    });
  } finally {
    if (paused && !cancelled) {
      // SP5 Task 4 — the THIRD finalize outcome: a paused run is a HELD, resumable state, NOT a
      // terminal one. Deliberately does NOT set finishedAt (that would free the
      // pipeline_runs_one_running interlock slot and let a second run start while this one is only
      // parked, not finished — a paused run intentionally keeps holding the slot) and does NOT
      // compute the success/partial/failed tally (nothing terminal to tally — the remaining
      // stories haven't been attempted at all). checkpoint holds exactly the stories still to
      // process, in the shape resumeRun()/executeRun's resume path expects back verbatim.
      status = "paused";
      await db.update(pipelineRuns).set({
        status: "paused", checkpoint: { stories: remainingStories } satisfies RunCheckpoint,
        feedsRead, newItems, phase: "finalizing", currentStage: null, currentItem: null,
      }).where(eq(pipelineRuns.id, runId));
    } else {
      // SP5 Task 3: a cancelled run ALWAYS finalizes to the "cancelled" terminal status — never the
      // computed success/partial/failed tally — even if something unexpected threw after the cancel
      // was observed (the outer `catch` above would otherwise have left `status` as "failed").
      if (cancelled) status = "cancelled";
      // Always land a terminal status AND clear the live pointer so a late poll can't show a stale
      // stage — this is what guarantees the row never stays "running" — this is the ONLY branch
      // that sets finishedAt, freeing the pipeline_runs_one_running interlock slot.
      await db.update(pipelineRuns).set({
        status, feedsRead, newItems, published: 0, finishedAt: new Date(),
        phase: "finalizing", currentStage: null, currentItem: null,
      }).where(eq(pipelineRuns.id, runId));

      // SP9a — best-effort run_failed alert: exactly ONE per finalize, only on a genuine terminal
      // 'failed' status — never 'partial'/'cancelled'/'success' (nor 'paused', which never reaches
      // this branch at all — see the `if (paused && !cancelled)` branch above). createAlert() never
      // throws by its own contract, but this call is wrapped defensively anyway per the SP9a
      // constraint that alerting must never affect finalization — which, by this point, has
      // ALREADY landed via the update just above, so even a hypothetical throw here couldn't
      // un-finalize the row.
      if (status === "failed") {
        try {
          await createAlert({
            type: "run_failed",
            title: "Exécution du pipeline échouée",
            detail:
              `${feedsFailed} flux en échec (sur ${feedsRead + feedsFailed} lu(s)), `
              + `${itemFailures} histoire(s) en échec (sur ${itemFailures + produced} traitée(s)).`,
            entityId: runId,
          });
        } catch { /* best-effort — must never affect an already-finalized run */ }
      }
    }
  }

  return { runId, status, produced };
}

/**
 * Runs one full pipeline pass: resolves run params from settings and persists them on the run row,
 * then opens the run (holding the one-running slot) and executes it. Preserved for the cron route
 * (app/api/pipeline/run/route.ts, via the scheduled trigger) + existing tests — behaviourally
 * identical to the previous single-function runPipeline (same overlap safety, same always-finalize
 * guarantee), just composed from openRun + executeRun under the hood. The manual-trigger action
 * (startPipelineRun, in lib/actions/pipeline-actions.ts) no longer calls this: it resolves/
 * validates its own params and composes openRun + executeRun directly, so it can return the
 * freshly-opened runId without awaiting executeRun to finish (see its own doc comment for why that
 * matters).
 */
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
