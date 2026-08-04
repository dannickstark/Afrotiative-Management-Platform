import { z } from "zod";

export const confidenceSchema = z.object({
  categoryUncertain: z.boolean(), imageMissing: z.boolean(), clusterUncertain: z.boolean(),
});

export function buildArticleSchema(categoryNames: string[]) {
  const category = categoryNames.length >= 1
    ? z.enum(categoryNames as [string, ...string[]])
    : z.string();
  return z.object({
    title: z.string().min(5),
    bodyHtml: z.string().min(1),
    excerpt: z.string(),
    category,
    tags: z.array(z.string()).max(8),
    // .nullish() (= .nullable().optional()) rather than .nullable(): real providers
    // (OpenRouter/OpenAI structured output) frequently OMIT these keys entirely instead of
    // sending null when there's no image, and a merely-.nullable() field still requires the
    // key to be present, so omission fails validation and needlessly falls through to the
    // mock. sanitizeDraft() in generate-article.ts normalizes undefined to null before persist.
    featuredImageUrl: z.string().url().nullish(),
    imageCredit: z.string().nullish(),
    imageSourceUrl: z.string().url().nullish(),
    confidence: confidenceSchema,
  });
}
export type ArticleDraft = z.infer<ReturnType<typeof buildArticleSchema>> & { category: string };
