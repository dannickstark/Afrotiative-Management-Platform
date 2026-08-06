import type { ArticleDraft } from "@/lib/ai/schema";
import type { RegenerateFieldsInput } from "@/lib/validation";

// Pure: given a freshly generated draft + the checked fields, return the exact article-column patch
// (only the checked SCALAR columns), the raw body to sanitize+write (or null), the category NAME to
// resolve (or null), and the tags to replace (or null). No DB/DOM — the caller sanitizes the body and
// resolves the category id. Keeping this pure makes the "only checked fields change" contract
// directly unit-testable.
export function selectRegenerationColumns(draft: ArticleDraft, fields: RegenerateFieldsInput): {
  columns: Partial<{ title: string; excerpt: string; featuredImageUrl: string | null; imageCredit: string | null; imageSourceUrl: string | null }>;
  bodyHtml: string | null;
  categoryName: string | null;
  tags: string[] | null;
  bodyChanged: boolean;
} {
  const columns: Record<string, unknown> = {};
  if (fields.title) columns.title = draft.title;
  if (fields.excerpt) columns.excerpt = draft.excerpt;
  if (fields.image) {
    columns.featuredImageUrl = draft.featuredImageUrl ?? null;
    columns.imageCredit = draft.imageCredit ?? null;
    columns.imageSourceUrl = draft.imageSourceUrl ?? null;
  }
  return {
    columns,
    bodyHtml: fields.body ? draft.bodyHtml : null,
    categoryName: fields.category ? draft.category : null,
    tags: fields.tags ? draft.tags : null,
    bodyChanged: fields.body,
  };
}
