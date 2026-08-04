import { diffTaxonomy, slugifyTaxonomyName, type ExistingTaxonomyTerm } from "@/lib/taxonomy-diff";

// NON-"use server" module. The DB-upsert core lives here — NOT in the "use server"
// taxonomy-actions.ts — so it can never be reached as an unauthenticated Server Action. Every
// export from a file-level "use server" module is a callable Server Action with no auth of its
// own; a bare DB-writer there would be an unguarded write path (only accidentally safe because its
// params are closures). Keeping the writer here forces all callers through the RBAC-guarded
// syncTaxonomyFromWordPress action in taxonomy-actions.ts (which imports this after guarding).
// Mirrors the SP5 publishDueArticles fix (guarded action wraps a plain-module core) and the
// Task-2/3 pattern (pure helpers in lib/validation.ts / lib/taxonomy-diff.ts, not in the action
// file). The integration test imports applyTaxonomySync directly from here.

type ExistingMirrorRow = ExistingTaxonomyTerm & { id: string };
type WpTermWithCount = { id: number; name: string; count?: number };

// The DB-touching half of the sync: given the current mirror rows for ONE taxonomy (categories OR
// tags) and the WP terms fetched for it, applies diffTaxonomy's split via caller-supplied
// insert/update primitives. Takes closures instead of a drizzle table reference so the exact same
// code path works for both wp_categories and wp_tags (two structurally-identical but distinctly
// typed tables) without fighting drizzle's per-table branded column types.
export async function applyTaxonomySync(
  existing: ExistingMirrorRow[],
  wpTerms: WpTermWithCount[],
  ops: {
    insert: (rows: { name: string; slug: string; wpId: number; articleCount: number }[]) => Promise<unknown>;
    update: (id: string, patch: { wpId: number; articleCount: number }) => Promise<unknown>;
  },
): Promise<{ inserted: number; updated: number }> {
  const { inserts, updates } = diffTaxonomy(existing, wpTerms);
  if (inserts.length === 0 && updates.length === 0) return { inserted: 0, updated: 0 };

  const byLowerName = new Map(existing.map((e) => [e.name.toLowerCase(), e]));
  const countByWpId = new Map(wpTerms.map((t) => [t.id, t.count ?? 0]));

  if (inserts.length > 0) {
    await ops.insert(
      inserts.map((ins) => ({
        name: ins.name,
        slug: slugifyTaxonomyName(ins.name),
        wpId: ins.wpId,
        articleCount: countByWpId.get(ins.wpId) ?? 0,
      })),
    );
  }
  for (const upd of updates) {
    const row = byLowerName.get(upd.name.toLowerCase());
    if (!row) continue; // unreachable — diffTaxonomy only returns an update for a name found in `existing`
    await ops.update(row.id, { wpId: upd.wpId, articleCount: countByWpId.get(upd.wpId) ?? 0 });
  }
  return { inserted: inserts.length, updated: updates.length };
}
