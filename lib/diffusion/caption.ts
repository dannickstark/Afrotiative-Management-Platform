// lib/diffusion/caption.ts — D1 §3's AI caption generation. NOT a "use server" module (same
// plain-core split as lib/studio/template-core.ts / lib/diffusion/settings-core.ts): this is
// called ONLY through the guarded lib/actions/diffusion-actions.ts action, never exposed directly.
//
// Reuses the EXACT provider-chain pattern already proven by lib/ai/improve-article.ts
// (generateText + buildModel + getPipelineConfig's llmOrder, two attempts per provider, fall
// through on throw/empty output) — the pipeline already runs credential-free via this chain, and
// this module must too (Task 4 brief: "fall back deterministically... rather than erroring").
import { generateText } from "ai";
import { and, eq } from "drizzle-orm";
import { buildModel, buildOpenRouterModel } from "@/lib/ai/providers";
import { getPipelineConfig } from "@/lib/config/pipeline-config";
import { runWithOpenRouterPool } from "@/lib/ai/with-token-pool";
import { db, articles, wpCategories, distributions } from "@/db";
import { getChannelSettings } from "./settings-core";
import { getWpConfig } from "@/lib/wp/config";
import { wpPostUrl } from "@/lib/wp/post-url";
import type { Channel } from "@/lib/studio";

export type GenerateCaptionInput = { articleId: string; channel: Channel };
export type GenerateCaptionResult = { ok: true; caption: string } | { ok: false; message: string };

const ELLIPSIS = "…";

// D7 Task 5 (spec §2) — the blank line between the generated text and the appended permalink.
// Kept deliberately plain: spec §2 shows a blank line, and Task 4's linkedin.ts already strips
// EVERY URL anywhere in the caption to derive alt text — exotic separator formatting would only
// interact with that stripping for no benefit.
const URL_SEPARATOR = "\n\n";

// LinkedIn only (spec §2, "Scope of the change") — Facebook and Instagram captions are untouched:
// links are not clickable on Instagram, and Facebook's behaviour is deliberately left as D2 shipped
// it. Returns null (not an error) whenever there is nothing to append: article not yet published to
// WordPress, or WordPress itself not configured — the exact same graceful absence
// lib/studio/bindings.ts's articleTokenValues already implements for the {{article.url}} token,
// which this derivation deliberately mirrors rather than reinventing.
async function articlePermalink(articleId: string, channel: Channel): Promise<string | null> {
  if (channel !== "linkedin") return null;

  const [dist] = await db
    .select({ externalId: distributions.externalId })
    .from(distributions)
    .where(and(eq(distributions.articleId, articleId), eq(distributions.channel, "wordpress")))
    .limit(1);

  const baseUrl = getWpConfig()?.baseUrl ?? null;
  return wpPostUrl(baseUrl, dist?.externalId ?? null);
}

// PURE — defensive backstop applied to EVERY caption this module returns (real provider output
// AND the deterministic fallback alike): "a model does not reliably obey a character limit" (Task
// 4 brief), so the limit is enforced HERE, not trusted from the prompt instruction alone.
//
// Truncates on a WORD boundary: cutting exactly at `maxChars` would routinely ship a mangled
// half-word ("…progresse forteme…"). The one subtlety (see tests/diffusion-caption.test.ts for the
// hand-verified boundary case): if the hard cut at `budget` chars lands EXACTLY on a space in the
// original text, the slice already ends on a complete word — backing up further would needlessly
// drop that whole last word. Only back up when the cut genuinely landed mid-word.
//
// `.length`/`.slice` count UTF-16 CODE UNITS, not visible characters — most emoji (realistic in an
// X/Instagram caption) are a SURROGATE PAIR, two code units wide. A hard cut at `budget` can land
// exactly between a pair's high and low half, leaving a lone unpaired surrogate at the end — not
// mangled text but genuinely INVALID UTF-16 (renders as a replacement character, or worse, once
// re-encoded by a real channel adapter's own request encoding). Detected and backed up ONE MORE
// code unit before the word-boundary check above even runs, so a split pair never reaches it.
export function truncateCaption(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;

  const budget = Math.max(0, maxChars - ELLIPSIS.length);
  if (budget === 0) return ELLIPSIS.slice(0, Math.max(0, maxChars));

  let effectiveBudget = budget;
  const codeAtCut = trimmed.charCodeAt(effectiveBudget - 1);
  if (codeAtCut >= 0xd800 && codeAtCut <= 0xdbff) effectiveBudget -= 1; // high surrogate, pair split by the cut

  let cut = trimmed.slice(0, effectiveBudget);
  if (trimmed[effectiveBudget] !== " ") {
    const lastSpace = cut.lastIndexOf(" ");
    // lastSpace > 0 (not just >= 0): a space at index 0 would leave an EMPTY word before it — no
    // real boundary to back up to, so the hard cut stands (a single word longer than the budget).
    if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  }
  return `${cut.trimEnd()}${ELLIPSIS}`;
}

// PURE — exported for direct prompt-content testing, same convention as buildArticlePrompt
// (lib/ai/generate-article.ts) / buildImprovePrompt (lib/ai/improve-article.ts). French, fed the
// title/excerpt/category, and instructs the model to respect maxChars (defensively re-enforced by
// truncateCaption above regardless of whether the model actually complies).
export function buildCaptionPrompt(input: {
  title: string;
  excerpt: string | null;
  category: string | null;
  maxChars: number;
  promptOverride?: string | null;
}): string {
  const { title, excerpt, category, maxChars, promptOverride } = input;
  const lines = [
    "Tu rédiges la légende d'un post social pour Afrotiative, média panafricain business & finance francophone.",
    promptOverride?.trim()
      ? promptOverride.trim()
      : "Rédige une légende accrocheuse et factuelle en français, qui donne envie de lire l'article, sans jamais inventer de fait.",
    `La légende ne doit JAMAIS dépasser ${maxChars} caractères (espaces compris). Réponds UNIQUEMENT avec le texte de la légende : pas de guillemets, pas de préambule, pas de hashtags sauf s'ils sont naturels au propos.`,
    `\nTitre : ${title}`,
  ];
  if (excerpt) lines.push(`Chapô : ${excerpt}`);
  if (category) lines.push(`Catégorie : ${category}`);
  return lines.join("\n");
}

// generateCaption({ articleId, channel }) — Task 4's contract. Loads the article (title/excerpt/
// category) and the channel's configured captionMaxChars, then walks the SAME provider chain as
// generateArticle/improveArticleBody. `{ ok: true, caption }` covers BOTH a real provider result
// AND the deterministic fallback (title truncated to the limit) — Task 4 is explicit that "no
// usable provider" is not an error state for this function. Only a genuinely missing article
// (nothing to caption) returns `{ ok: false }`.
export async function generateCaption({ articleId, channel }: GenerateCaptionInput): Promise<GenerateCaptionResult> {
  const [row] = await db
    .select({ title: articles.title, excerpt: articles.excerpt, categoryId: articles.categoryId })
    .from(articles)
    .where(eq(articles.id, articleId));
  if (!row) return { ok: false, message: "Article introuvable." };

  let categoryName: string | null = null;
  if (row.categoryId) {
    const [cat] = await db.select({ name: wpCategories.name }).from(wpCategories).where(eq(wpCategories.id, row.categoryId));
    categoryName = cat?.name ?? null;
  }

  const settings = await getChannelSettings(channel);
  const maxChars = settings.captionMaxChars;

  // D7 Task 5 (spec §2, "the crux") — the permalink's length is reserved BEFORE truncation, never
  // appended after it: appending after the clamp would produce either a caption over budget or a
  // truncated link, depending on which side of the clamp the append landed on. `captionBudget` is
  // what every truncateCaption call below actually clamps against; `finalize` then appends the
  // (untouched, never-truncated) permalink afterward. When there is no permalink (not LinkedIn, or
  // the article has no WordPress distribution yet), captionBudget === maxChars and finalize is a
  // no-op passthrough to truncateCaption — this is what keeps Facebook/Instagram captions untouched.
  const permalink = await articlePermalink(articleId, channel);
  // Issue 6 (D7 final review) — when the permalink ALONE does not fit inside maxChars (a tiny
  // captionMaxChars, or an unusually long permalink), the previous `Math.max(0, …)` floor let the
  // reserved budget hit exactly 0. truncateCaption(text, 0) then returns "", and finalize still
  // appended the untouched permalink anyway — producing "\n\n<permalink>", LONGER than maxChars, the
  // exact invariant this budget dance exists to guarantee (spec §2). Reproduced concretely: maxChars
  // = 20, a 30-char permalink → budget 0 → final caption 32 chars. LinkedIn's own captionLimits.min
  // is 1, so an admin reaches this from the settings form alone, no LLM misbehavior required. Fixed
  // the only way that keeps the invariant unconditionally: when the permalink cannot fit even on its
  // own, it is not appended at all — the caption falls back to a plain, full-budget truncation,
  // exactly like the "no permalink" case (not LinkedIn, or no WordPress distribution yet).
  const permalinkFits = permalink !== null && maxChars - (permalink.length + URL_SEPARATOR.length) > 0;
  const linkToAppend = permalinkFits ? permalink : null;
  const captionBudget = linkToAppend ? maxChars - (linkToAppend.length + URL_SEPARATOR.length) : maxChars;
  const finalize = (text: string): string => {
    const truncated = truncateCaption(text, captionBudget);
    return linkToAppend ? `${truncated}${URL_SEPARATOR}${linkToAppend}` : truncated;
  };

  const fallback = () => finalize(row.title);

  const cfg = getPipelineConfig();
  const prompt = buildCaptionPrompt({
    // captionBudget (not the raw maxChars) — when a permalink will be appended, the model should be
    // told the SAME, already-reduced target its own output is actually clamped against; asking it
    // for the full channel budget only to truncate the result further would routinely mangle prose
    // that would otherwise have fit comfortably in the room actually available to it.
    title: row.title, excerpt: row.excerpt, category: categoryName, maxChars: captionBudget,
    promptOverride: settings.captionPrompt,
  });

  // Flaky here mirrors the OLD "empty output → next provider" check below: an empty/blank caption
  // isn't usable, so it should trigger rotation to the next pooled OpenRouter token.
  const isFlaky = (text: string): boolean => text.trim().length === 0;

  for (const name of cfg.llmOrder) {
    if (name === "openrouter") {
      // See lib/ai/generate-article.ts's identical gate + fallback for the full rationale: this
      // buildModel() call is the SAME availability check the pre-pool code used (non-null iff
      // cfg.openrouter is configured in real, unmocked code), kept so tests that mock buildModel
      // directly (tests/diffusion-caption.test.ts, predating the token pool) keep working unmodified.
      const gateModel = buildModel(name, cfg);
      if (!gateModel) continue;

      if (!cfg.openrouter) {
        // UNREACHABLE with the real buildModel — see generate-article.ts's twin comment. Exists
        // only for callers that module-mock buildModel directly, bypassing cfg.openrouter (the
        // token pool would otherwise always be empty for them).
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const { text } = await generateText({ model: gateModel, prompt });
            const caption = text.trim();
            if (caption.length > 0) return { ok: true, caption: finalize(caption) };
            break;
          } catch (e) {
            console.warn(`[diffusion] fournisseur openrouter a échoué pour la légende de l'article ${articleId} : ${(e as Error).message}`);
            if (attempt === 1) break;
          }
        }
        continue;
      }

      const r = await runWithOpenRouterPool(async (apiKey) => {
        const model = buildOpenRouterModel(cfg, apiKey);
        const { text } = await generateText({ model, prompt });
        return text.trim();
      }, isFlaky);
      if (r.ok) return { ok: true, caption: finalize(r.value) };
      continue;
    }

    const model = buildModel(name, cfg);
    if (!model) continue;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { text } = await generateText({ model, prompt });
        const caption = text.trim();
        if (caption.length > 0) return { ok: true, caption: finalize(caption) };
        break; // empty output → next provider
      } catch (e) {
        console.warn(`[diffusion] fournisseur ${name} a échoué pour la légende de l'article ${articleId} : ${(e as Error).message}`);
        if (attempt === 1) break; // exhausted this provider's retries → next provider
      }
    }
  }

  return { ok: true, caption: fallback() };
}
