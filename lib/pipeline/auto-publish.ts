// SP6 — gated auto-publish (default OFF). This module is a PURE decision function: no DB, no
// settings lookup, no I/O of any kind. It answers exactly one question — "does this already-
// computed article qualify for the SP6 auto-approval exception?" — from values its caller
// (lib/pipeline/stages.ts's stageSources) has already loaded/computed.
//
// DESIGN PRINCIPLE (do not violate): this does NOT weaken the human-review barrier's enforcement
// point. `publishDueArticles()` (lib/wp/publish-due.ts) still publishes ONLY `status='approved'`
// articles, unchanged. Auto-publish instead adds a SECOND, gated way for an article to REACH
// `approved` without a human click: shouldAutoPublish() decides whether stageSources may set
// status:"approved" + scheduledAt:now instead of the default "pending" — the existing, unchanged
// publish-due cron takes it from there. A non-qualifying article is staged exactly as before
// (status:"pending"), so the human-review barrier is fully intact for every article that doesn't
// pass this gate — which, with the setting defaulted OFF, is every article until an admin
// deliberately opts in.

export type AutoPublishConfidence = {
  categoryUncertain?: boolean;
  imageMissing?: boolean;
  clusterUncertain?: boolean;
  // Set by stageSources when a provider outage forced a mock LLM/embedding fallback (see that
  // file's "aiDegraded" comment) — an article produced under degraded conditions must NEVER be
  // auto-published, no matter how high its score, since the score itself was computed from
  // possibly-fabricated content.
  aiDegraded?: boolean;
};

export type ShouldAutoPublishInput = {
  /** The admin-configured master switch — pipelineSettings.autoPublishEnabled. Defaults false (SP1). */
  enabled: boolean;
  /** The article's lib/pipeline/score.ts quality score (0-100), or null if not yet computed. */
  score: number | null;
  /** Minimum score to qualify — pipelineSettings.scoreThreshold. */
  scoreThreshold: number;
  /** Number of distinct (deduped) sources synthesized into this article. */
  sourceCount: number;
  /** Minimum source count to qualify — pipelineSettings.autoPublishMinSources. */
  minSources: number;
  /** Whether a featuredImageUrl was resolved for the article. */
  hasImage: boolean;
  confidence: AutoPublishConfidence;
};

/**
 * Returns true iff EVERY one of the following holds — all are required, none is a "nice to have":
 *
 *  1. `enabled` — the admin master switch is on. Defaults false; this alone makes auto-publish a
 *     fully opt-in exception rather than a behavior change for existing installs.
 *  2. `score` is not null AND `score >= scoreThreshold` — an article whose score hasn't been
 *     computed (null) can never qualify, regardless of the threshold's value.
 *  3. `sourceCount >= minSources` — the cross-check corroboration floor; a single-source story
 *     never auto-publishes even with a high score.
 *  4. `hasImage` — a featured image was resolved. No image, no auto-publish.
 *  5. NONE of the 4 confidence flags are set (categoryUncertain, imageMissing, clusterUncertain,
 *     aiDegraded) — any single low-confidence signal blocks auto-publish outright, even paired
 *     with a high score and plenty of sources: these flags mark exactly the conditions a human
 *     reviewer should distrust, so they must distrust an automatic approval too.
 *
 * Pure — safe to unit-test without a database, and safe to call on every article regardless of
 * whether auto-publish is enabled (condition 1 short-circuits everything else when it's off).
 */
export function shouldAutoPublish(input: ShouldAutoPublishInput): boolean {
  if (!input.enabled) return false;
  if (input.score == null || input.score < input.scoreThreshold) return false;
  if (input.sourceCount < input.minSources) return false;
  if (!input.hasImage) return false;
  const { categoryUncertain, imageMissing, clusterUncertain, aiDegraded } = input.confidence;
  if (categoryUncertain || imageMissing || clusterUncertain || aiDegraded) return false;
  return true;
}
