// PURE — no DB/session I/O. Extracted from lib/actions/taxonomy-actions.ts because that module
// needs a file-level "use server" directive (so components/settings/taxonomy-tables.tsx, a Client
// Component, can import syncTaxonomyFromWordPress directly), and Next.js 16 only allows
// async-function exports from a file-level "use server" module — a synchronous export like
// diffTaxonomy would silently disappear from the client-importable surface (`bun run build` fails
// with "export diffTaxonomy doesn't exist in target module" if declared there). Same reasoning as
// lib/validation.ts's validateFeedInput/validateMemberInput (Task 2) and lib/team-password.ts's
// generateTempPassword (Task 3).

export type ExistingTaxonomyTerm = { name: string; wpId: number | null };
export type WpTaxonomyTerm = { id: number; name: string };

export type TaxonomyDiff = {
  inserts: { name: string; wpId: number }[];
  updates: { name: string; wpId: number }[];
};

// Splits WordPress terms into inserts (no matching name in `existing`) and updates (a matching
// name already exists — its row should have wpId/articleCount backfilled, never a duplicate row
// created). Matching is by NAME only, case-insensitively — never by the old/placeholder wpId — so
// a seeded placeholder id (e.g. wp_categories.wpId set to a throwaway 1-based index by db/seed.ts)
// is correctly replaced by the real WordPress id on first sync instead of producing a duplicate row.
export function diffTaxonomy(existing: ExistingTaxonomyTerm[], wpTerms: WpTaxonomyTerm[]): TaxonomyDiff {
  const existingNames = new Set(existing.map((e) => e.name.toLowerCase()));
  const inserts: TaxonomyDiff["inserts"] = [];
  const updates: TaxonomyDiff["updates"] = [];
  for (const term of wpTerms) {
    const key = term.name.toLowerCase();
    if (existingNames.has(key)) updates.push({ name: term.name, wpId: term.id });
    else inserts.push({ name: term.name, wpId: term.id });
  }
  return { inserts, updates };
}

const COMBINING_DIACRITICS = new RegExp("[̀-ͯ]", "g"); // marks left by NFD decomposition

// Slug for a newly-inserted mirror row (wp_categories.slug / wp_tags.slug are NOT NULL). Mirrors
// the accent-stripping approach already used by lib/wp/publish.ts's slugify (not exported from
// there, so re-implemented here rather than reaching into an unrelated module for a private
// helper) — e.g. "Économie" -> "economie", not the seed script's ASCII-only strip which drops
// leading accented letters entirely (e.g. "-conomie").
export function slugifyTaxonomyName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_DIACRITICS, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "terme";
}
