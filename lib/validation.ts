import { z } from "zod";

export const saveDraftSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(3, "Titre trop court"),
  bodyHtml: z.string(),
  excerpt: z.string().optional(),
  categoryId: z.string().uuid().nullable(),
  tags: z.array(z.object({ tagName: z.string(), isNew: z.boolean() })),
  featuredImageUrl: z.string().url().nullable(),
  imageCredit: z.string().nullable(),
  imageSourceUrl: z.string().url().nullable(),
});

export type SaveDraftInput = z.infer<typeof saveDraftSchema>;
