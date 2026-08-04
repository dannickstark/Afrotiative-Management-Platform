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
    featuredImageUrl: z.string().url().nullable(),
    imageCredit: z.string().nullable(),
    imageSourceUrl: z.string().url().nullable(),
    confidence: confidenceSchema,
  });
}
export type ArticleDraft = z.infer<ReturnType<typeof buildArticleSchema>> & { category: string };
