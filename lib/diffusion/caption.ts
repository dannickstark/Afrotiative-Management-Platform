// lib/diffusion/caption.ts — D1 §3's AI caption generation. NOT a "use server" module (same
// plain-core split as lib/studio/template-core.ts / lib/diffusion/settings-core.ts): this is
// called ONLY through the guarded lib/actions/diffusion-actions.ts action, never exposed directly.
//
// Reuses the EXACT provider-chain pattern already proven by lib/ai/improve-article.ts
// (generateText + buildModel + getPipelineConfig's llmOrder, two attempts per provider, fall
// through on throw/empty output) — the pipeline already runs credential-free via this chain, and
// this module must too (Task 4 brief: "fall back deterministically... rather than erroring").
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { buildModel } from "@/lib/ai/providers";
import { getPipelineConfig } from "@/lib/config/pipeline-config";
import { db, articles, wpCategories } from "@/db";
import { getChannelSettings } from "./settings-core";
import type { Channel } from "@/lib/studio";

export type GenerateCaptionInput = { articleId: string; channel: Channel };
export type GenerateCaptionResult = { ok: true; caption: string } | { ok: false; message: string };

const ELLIPSIS = "…";

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
  const fallback = () => truncateCaption(row.title, maxChars);

  const cfg = getPipelineConfig();
  const prompt = buildCaptionPrompt({
    title: row.title, excerpt: row.excerpt, category: categoryName, maxChars,
    promptOverride: settings.captionPrompt,
  });

  for (const name of cfg.llmOrder) {
    const model = buildModel(name, cfg);
    if (!model) continue;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { text } = await generateText({ model, prompt });
        const caption = text.trim();
        if (caption.length > 0) return { ok: true, caption: truncateCaption(caption, maxChars) };
        break; // empty output → next provider
      } catch (e) {
        console.warn(`[diffusion] fournisseur ${name} a échoué pour la légende de l'article ${articleId} : ${(e as Error).message}`);
        if (attempt === 1) break; // exhausted this provider's retries → next provider
      }
    }
  }

  return { ok: true, caption: fallback() };
}
