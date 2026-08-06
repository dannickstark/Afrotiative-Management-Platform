export type PublishedFilters = {
  search?: string; categoryId?: string; from?: Date; to?: Date;
  author?: "ai" | "human"; page: number; pageSize: number;
};
export type PublishedRow = {
  id: string; title: string; categoryName: string | null;
  publishedAt: Date; imageUrl: string | null; aiAuthor: boolean;
  wpUrl: string | null; // live WP link, computed server-side (see getPublishedArticles)
};
export type PublishedPage = { rows: PublishedRow[]; total: number; page: number; pageCount: number };

export const PUBLISHED_PAGE_SIZE = 25;

// Pure: map raw URL search params → typed filters (no DB/DOM). Invalid dates / unknown author /
// blank strings are dropped; page clamps to >= 1; pageSize is fixed. Mirrors filterRuns/resolveRunParams.
export function parsePublishedSearchParams(
  sp: Record<string, string | string[] | undefined>,
): PublishedFilters {
  const str = (v: string | string[] | undefined): string | undefined => {
    const s = Array.isArray(v) ? v[0] : v;
    return s && s.trim() ? s.trim() : undefined;
  };
  const date = (v: string | string[] | undefined): Date | undefined => {
    const s = str(v);
    if (!s) return undefined;
    const t = Date.parse(s);
    return Number.isNaN(t) ? undefined : new Date(t);
  };
  const pageRaw = Number(str(sp.page));
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
  const authorRaw = str(sp.author);
  const author = authorRaw === "ai" || authorRaw === "human" ? authorRaw : undefined;
  return {
    search: str(sp.q), categoryId: str(sp.cat), from: date(sp.from), to: date(sp.to),
    author, page, pageSize: PUBLISHED_PAGE_SIZE,
  };
}
