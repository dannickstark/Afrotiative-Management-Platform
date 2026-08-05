// SP4 Task 4 — pure article quality scoring. No DB access: computeArticleScore() takes plain
// values so it can be unit-tested without Neon and reused verbatim once SP4 Task 6 wires it into
// stageItem's insert (score set from the draft + sourceCount + decideCluster's bestScore +
// confidence flags). SP6's auto-publish gate later reads the resulting articles.score column
// against pipelineSettings.scoreThreshold.

export type ArticleScoreInput = {
  /** Number of article_sources rows this article will have — the cross-check payoff signal. */
  sourceCount: number;
  /** decideCluster()'s cosine-similarity best match, 0-1 (0 = new/unrelated cluster, 1 = identical). */
  bestScore: number;
  /** The (pre-sanitize) generated bodyHtml — used to check length and subheading structure. */
  bodyHtml: string;
  /** Whether a featuredImageUrl was resolved for the article. */
  hasImage: boolean;
  confidence: {
    categoryUncertain?: boolean;
    imageMissing?: boolean;
    clusterUncertain?: boolean;
    aiDegraded?: boolean;
  };
};

// ---- weights (documented; positive components sum to 100 before penalties) ----

// Corroboration: 1 source is the baseline (10 pts); each additional corroborating source adds 10
// pts, capped at 3 sources (30 pts) — this is the cross-check payoff SP4 Task 6's multi-source
// synthesis is built for, but the marginal value of a 5th or 6th source is small so it's capped.
const CORROBORATION_BASE = 10;
const CORROBORATION_PER_EXTRA_SOURCE = 10;
const CORROBORATION_MAX = 30;

// Cluster cohesion: decideCluster's bestScore (0-1 cosine similarity to the nearest recent
// article) scaled linearly. Clamped defensively — callers pass a raw pgvector similarity that
// should already be in [0,1], but never trust an external number blindly.
const COHESION_MAX = 15;

// Completeness: a well-formed, cross-checked article should be substantial AND structured.
// Length is measured on the tag-stripped text, not raw HTML, so markup doesn't inflate it.
const COMPLETENESS_MIN_CHARS = 500;
const COMPLETENESS_LENGTH_POINTS = 15;
const COMPLETENESS_SUBHEADING_POINTS = 5; // >=1 <h2> — SP4 Task 3's prompt asks for these

// Image present: a chosen featuredImageUrl.
const IMAGE_POINTS = 15;

// Category: full marks only when the pipeline was confident in its category pick; a partial
// credit (not zero) reflects that a category was still assigned, just flagged as uncertain.
const CATEGORY_CERTAIN_POINTS = 20;
const CATEGORY_UNCERTAIN_POINTS = 5;

// ---- confidence-flag penalties (subtracted after the positive sum) ----
// These mark conditions a human reviewer should distrust regardless of the positive signals
// above (e.g. a mock LLM fallback can still emit a long, well-structured, multi-source-looking
// draft — aiDegraded penalizes that on principle, not just on the symptom).
const PENALTY_CATEGORY_UNCERTAIN = 8;
const PENALTY_IMAGE_MISSING = 5;
const PENALTY_CLUSTER_UNCERTAIN = 8; // usually paired with a mock embedding — clustering was meaningless
const PENALTY_AI_DEGRADED = 20; // mock LLM/embedding fallback — the whole draft is suspect

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function plainTextLength(bodyHtml: string): number {
  return bodyHtml.replace(/<[^>]+>/g, "").trim().length;
}

function hasSubheading(bodyHtml: string): boolean {
  return /<h2[\s>]/i.test(bodyHtml);
}

function corroborationScore(sourceCount: number): number {
  if (sourceCount <= 0) return 0;
  const raw = CORROBORATION_BASE + (sourceCount - 1) * CORROBORATION_PER_EXTRA_SOURCE;
  return Math.min(CORROBORATION_MAX, raw);
}

/** Computes a 0-100 article quality score from weighted signals. Pure — no I/O. */
export function computeArticleScore(input: ArticleScoreInput): number {
  const corroboration = corroborationScore(input.sourceCount);
  const cohesion = clamp(input.bestScore, 0, 1) * COHESION_MAX;
  const completeness =
    (plainTextLength(input.bodyHtml) >= COMPLETENESS_MIN_CHARS ? COMPLETENESS_LENGTH_POINTS : 0) +
    (hasSubheading(input.bodyHtml) ? COMPLETENESS_SUBHEADING_POINTS : 0);
  const image = input.hasImage ? IMAGE_POINTS : 0;
  const category = input.confidence.categoryUncertain ? CATEGORY_UNCERTAIN_POINTS : CATEGORY_CERTAIN_POINTS;

  const positive = corroboration + cohesion + completeness + image + category;

  let penalty = 0;
  if (input.confidence.categoryUncertain) penalty += PENALTY_CATEGORY_UNCERTAIN;
  if (input.confidence.imageMissing) penalty += PENALTY_IMAGE_MISSING;
  if (input.confidence.clusterUncertain) penalty += PENALTY_CLUSTER_UNCERTAIN;
  if (input.confidence.aiDegraded) penalty += PENALTY_AI_DEGRADED;

  return clamp(Math.round(positive - penalty), 0, 100);
}
