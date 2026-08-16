#!/usr/bin/env bun
// scripts/test-fast.ts — a faster local test runner. `bun test` runs all 143 files in ONE serial
// process; on a 10-core machine that leaves the cores idle while the suite waits ~10 min, most of it
// on remote-Neon round-trips.
//
// This runner splits the suite into two lanes that run CONCURRENTLY:
//   • PURE lane — files that touch neither the DB nor the network. They have no shared state, so we
//     shard them across the cores and run the shards in parallel. Spawned with TEST_LANE=pure, which
//     makes test-setup.ts skip loading DATABASE_URL and skip the stray-run reap (see the comment
//     there): the lane opens ZERO DB connections, so concurrent shards cannot contend.
//     It also runs `bun test --isolate`: one fresh `globalThis` per file, so a file that installs
//     jsdom/DOM globals (or leaves one half-torn-down) cannot poison a neighbour sharing its process.
//     Without this, lane results depended on shard COMPOSITION — which files the round-robin below
//     happened to co-locate — rather than on the code under test; adding or removing an unrelated
//     PURE_FILES entry could flip an unrelated file red. See tests/studio-interactions.test.ts for the
//     full account of the pollution this guards against.
//   • DB lane — everything else. These hit the shared Neon dev DB, where a single-running interlock on
//     `pipeline_runs` plus cross-row contention forces them to run SERIALLY (test-setup.ts documents
//     this). So the DB lane stays one serial `bun test`; it just runs alongside the pure lane, so the
//     pure lane's wall time is absorbed into the DB lane's rather than added to it.
//
// The DB lane is the floor: the full run is ~max(db-lane, pure-lane). The big everyday win is
// `--pure`, which runs ONLY the parallel lane (~18s) — most studio work never touches the DB.
//
// IMPORTANT — the DEFAULT (full, both-lane) mode is NOT recommended for a green/red verdict. The DB
// lane is ~96% of the wall time (remote-Neon latency, unparallelizable here), so the full run saves
// almost nothing over plain `bun test`; worse, grouping all DB files into one lane REORDERS them and
// surfaces latent shared-DB state coupling as extra flaky failures (measured: wp-publish passes 23/0
// alone but failed 9x inside the block). Use plain `bun test` as the canonical full suite. The value
// of this script is `--pure`: a fast, deterministic inner-loop over the DB-free files.
//
// SAFETY / STALENESS: PURE_FILES below is an ALLOWLIST. Anything not listed defaults to the DB lane
// (serial, always correct — worst case it is merely slower than it could be). If a listed file later
// grows a DB dependency, it runs under TEST_LANE=pure with no DATABASE_URL and FAILS LOUDLY with a
// connection error on the next run that hits it — self-policing, no silent wrong result. Regenerate
// the list with:  ls tests/*.test.ts | xargs -P10 -I{} sh -c 'TEST_LANE=pure bun test {} >/dev/null 2>&1 && echo {}'
//
// `bun test` (plain) and CI are unchanged: they never set TEST_LANE, so test-setup.ts behaves exactly
// as before. This runner is an additive convenience, not a replacement for the canonical suite.

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { cpus } from "node:os";

// Files proven to touch neither DB nor network — the parallel lane. See the regenerate command above.
const PURE_FILES = new Set<string>([
  "ai-failure-message.test.ts", "ai-fallback.test.ts", "ai-improve.test.ts", "ai-prompt.test.ts", "ai-schema.test.ts",
  "article-preview-incomplete.test.ts", "auto-publish.test.ts", "brand-mark.test.ts",
  "completeness.test.ts", "dedup.test.ts", "diffusion-channels.test.ts", "diffusion-panel.test.ts",
  "diffusion-settings-ui.test.ts", "diffusion-setup-guide.test.ts", "dom-harness.test.ts",
  "embeddings.test.ts", "empty-state.test.ts", "extract-chain.test.ts", "extract-crawl4ai.test.ts", "extract-images.test.ts", "extract-ssrf.test.ts", "format-utc.test.ts",
  "interval-picker.test.ts", "live-panel.test.ts",
  "mcp-registry.test.ts", "mcp-schema.test.ts", "mcp-settings-ui.test.ts", "mcp-token.test.ts", "mock-llm.test.ts", "nav-sections.test.ts", "page-header.test.ts", "pipeline-actions.test.ts", "pipeline-config.test.ts",
  "published.test.ts", "queue-queries.test.ts", "rbac.test.ts", "resend.test.ts", "rss-parse.test.ts",
  "run-config-dialog.test.ts", "run-detail.test.ts", "run-outcome.test.ts", "run-params-schema.test.ts", "run-params.test.ts", "sanitize.test.ts",
  "schedule-expr.test.ts", "schedule-field.test.ts", "score.test.ts", "search.test.ts",
  "session-guard.test.ts", "settings-rbac.test.ts",
  "shell-nav.test.ts", "smoke.test.ts", "stat-card.test.ts",
  "status.test.ts", "studio-align.test.ts", "studio-asset-picker.test.ts", "studio-asset-validate.test.ts",
  "studio-canvas.test.ts", "studio-config.test.ts", "studio-constraints-field.test.ts",
  "studio-drag.test.ts", "studio-dynamic-text.test.ts",
  "studio-editor-prefs.test.ts", "studio-editor-shell.test.ts", "studio-editor-state.test.ts",
  "studio-element.test.ts", "studio-elements-panel.test.ts", "studio-field-scrub.test.ts", "studio-fonts.test.ts",
  "studio-format-focus.test.ts",
  "studio-geometry-strip.test.ts", "studio-images.test.ts",
  "studio-interactions.test.ts", "studio-layer-geometry.test.ts", "studio-layer-panel.test.ts",
  "studio-marque-panel.test.ts", "studio-mode-switch.test.ts", "studio-mode.test.ts", "studio-no-r2.test.ts",
  "studio-preview-cache.test.ts", "studio-proof-sheet.test.ts", "studio-property-panel.test.ts", "studio-public-api.test.ts", "studio-rail.test.ts",
  "studio-relayout.test.ts", "studio-constraints.test.ts",
  "studio-render-clippath.test.ts", "studio-render-export.test.ts", "studio-render-mode.test.ts",
  "studio-render-mode-refresh.test.ts", "studio-render.test.ts",
  "studio-save-indicator.test.ts", "studio-scene.test.ts", "studio-server-import.test.ts",
  "studio-shape-gallery.test.ts", "studio-shape-render.test.ts", "studio-shapes.test.ts",
  "studio-snap.test.ts", "studio-texte-panel.test.ts", "studio-token-picker.test.ts",
  "studio-tokens.test.ts", "studio-use-preview.test.ts", "studio-values.test.ts", "timing-safe.test.ts", "use-persisted-filters.test.ts",
  "video-beat-list.test.ts", "video-brief-panel.test.ts", "video-brief.test.ts", "video-contract.test.ts",
  "video-diff-review.test.ts", "video-duration.test.ts", "video-import-merge.test.ts", "video-import-parse.test.ts",
  "video-project-list.test.ts", "video-rbac-nav.test.ts", "video-schema-db.test.ts", "video-settings.test.ts",
  "with-token-pool.test.ts", "wp-client.test.ts", "wp-config.test.ts",
]);

const arg = process.argv[2];
const onlyPure = arg === "--pure";
const onlyDb = arg === "--db";
const WORKERS = Number(process.env.TEST_WORKERS) || Math.max(2, cpus().length - 2);

const allFiles = readdirSync("tests").filter((f) => f.endsWith(".test.ts"));
const pure = allFiles.filter((f) => PURE_FILES.has(f)).map((f) => `tests/${f}`);
const db = allFiles.filter((f) => !PURE_FILES.has(f)).map((f) => `tests/${f}`);

type LaneResult = { label: string; code: number; pass: number; fail: number; skip: number; output: string };

function runBun(files: string[], label: string, pureLane: boolean): Promise<LaneResult> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (pureLane) {
      env.TEST_LANE = "pure";
      delete env.DATABASE_URL; // belt-and-suspenders: the lane must open no DB connection
      delete env.DIRECT_URL;
    }
    const child = spawn("bun", ["test", ...(pureLane ? ["--isolate"] : []), ...files], { env });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (code) => {
      const num = (re: RegExp) => Number(output.match(re)?.[1] ?? 0);
      resolve({
        label,
        code: code ?? 1,
        pass: num(/(\d+) pass/),
        fail: num(/(\d+) fail/),
        skip: num(/(\d+) skip/),
        output,
      });
    });
  });
}

// Round-robin the pure files into WORKERS shards so each core gets a fair mix of light and heavy files.
function shard(files: string[], n: number): string[][] {
  const groups: string[][] = Array.from({ length: Math.min(n, files.length) }, () => []);
  files.forEach((f, i) => groups[i % groups.length].push(f));
  return groups.filter((g) => g.length > 0);
}

const started = Date.now();
const jobs: Promise<LaneResult>[] = [];

if (!onlyDb && pure.length > 0) {
  shard(pure, WORKERS).forEach((files, i) => jobs.push(runBun(files, `pure#${i + 1}`, true)));
}
if (!onlyPure && db.length > 0) {
  jobs.push(runBun(db, "db", false));
}

const results = await Promise.all(jobs);
const wall = ((Date.now() - started) / 1000).toFixed(1);

let pass = 0, fail = 0, skip = 0, anyBad = false;
for (const r of results) {
  pass += r.pass; fail += r.fail; skip += r.skip;
  if (r.code !== 0 || r.fail > 0) anyBad = true;
}

// Surface the full output of any lane/shard that failed, so failures are never hidden by the summary.
for (const r of results) {
  if (r.code !== 0 || r.fail > 0) {
    console.log(`\n───── ${r.label} FAILED (exit ${r.code}) ─────`);
    console.log(r.output.trimEnd());
  }
}

const mode = onlyPure ? "pure only" : onlyDb ? "db only" : `full (${jobs.length} procs, ${WORKERS} pure workers)`;
console.log(`\n═════ test-fast: ${mode} ═════`);
console.log(`pure files: ${pure.length}   db files: ${db.length}`);
console.log(`${pass} pass   ${fail} fail   ${skip} skip   —   wall ${wall}s`);
process.exit(anyBad ? 1 : 0);
