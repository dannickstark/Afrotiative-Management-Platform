// PURE — no I/O, importable from bun test without pulling in the DB client (unlike
// lib/queries/published.ts, which instantiates `db` at module load). Clickable column headers
// for the /published table (task B3) → this module is the allowlist that guards the ORDER BY
// from injection: an arbitrary `?sort=` must never reach SQL without being filtered here.
// Mirrors lib/queries/queue-sort.ts.
export type PublishedSortCol = "title" | "category" | "publishedAt" | "author";

const VALID_COLUMNS: readonly PublishedSortCol[] = [
  "title", "category", "publishedAt", "author",
];

function isPublishedSortCol(v: string | undefined): v is PublishedSortCol {
  return v !== undefined && (VALID_COLUMNS as readonly string[]).includes(v);
}

/**
 * `?sort=`/`?dir=` raw params → typed column + direction. Unknown/missing column falls back to
 * the table's current default (most recently published first) rather than failing.
 */
export function resolvePublishedSort(
  sort?: string,
  dir?: string,
): { column: PublishedSortCol; direction: "asc" | "desc" } {
  const column: PublishedSortCol = isPublishedSortCol(sort) ? sort : "publishedAt";
  const direction: "asc" | "desc" = dir === "asc" ? "asc" : "desc";
  return { column, direction };
}
