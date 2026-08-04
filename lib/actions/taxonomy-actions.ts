"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { diffTaxonomy, slugifyTaxonomyName, type ExistingTaxonomyTerm } from "@/lib/taxonomy-diff";

// diffTaxonomy itself lives in lib/taxonomy-diff.ts (a plain, non-"use server" module) — see the
// comment there for why a synchronous pure helper can't be exported alongside a file-level
// "use server" directive.

type ExistingMirrorRow = ExistingTaxonomyTerm & { id: string };
type WpTermWithCount = { id: number; name: string; count?: number };

// The DB-touching half of the sync: given the current mirror rows for ONE taxonomy (categories OR
// tags) and the WP terms fetched for it, applies diffTaxonomy's split via caller-supplied
// insert/update primitives. Takes closures instead of a drizzle table reference so the exact same
// code path works for both wp_categories and wp_tags (two structurally-identical but distinctly
// typed tables) without fighting drizzle's per-table branded column types — and so
// tests/taxonomy-sync.test.ts can exercise this against the real DB directly, bypassing
// requireUser()/requirePermission() (which need a real Next.js request context unavailable under
// plain `bun test` — same constraint documented in tests/team-actions.test.ts).
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

async function guard() {
  const u = await requireUser();
  requirePermission(u.role, "taxonomy", "manage");
  return u;
}

// Pulls categories + tags from WordPress and mirrors them into wp_categories/wp_tags: new WP-side
// names are inserted, names that already exist here (case-insensitively) have their wpId +
// articleCount backfilled from WordPress — including replacing a seeded placeholder wpId with the
// real one. Never deletes a mirror row that WordPress no longer lists (out of scope per the
// brief — this is a one-way "pull + upsert", not a full reconciliation).
export async function syncTaxonomyFromWordPress(): Promise<
  { ok: true; categories: number; tags: number } | { ok: false; message: string }
> {
  await guard();

  const { getWpConfig } = await import("@/lib/wp/config");
  const cfg = getWpConfig();
  if (!cfg) return { ok: false as const, message: "WordPress non configuré." };

  const { WordPressClient, decodeWpEntities } = await import("@/lib/wp/client");
  const { db, wpCategories, wpTags } = await import("@/db");
  const { eq } = await import("drizzle-orm");

  const wp = new WordPressClient(cfg);
  const [wpCats, wpTagsList] = await Promise.all([wp.getCategories(), wp.getTags()]);

  // WordPress returns entity-encoded names (e.g. "Bourse &amp; Marchés") — decode before diffing
  // so the case-insensitive name match doesn't miss an existing row (same convention as
  // WordPressClient.resolveOrCreate and lib/wp/publish.ts's resolveTaxonomy).
  const decodedCats = wpCats.map((t) => ({ id: t.id, name: decodeWpEntities(t.name), count: t.count }));
  const decodedTags = wpTagsList.map((t) => ({ id: t.id, name: decodeWpEntities(t.name), count: t.count }));

  const [existingCats, existingTags] = await Promise.all([
    db.select({ id: wpCategories.id, name: wpCategories.name, wpId: wpCategories.wpId }).from(wpCategories),
    db.select({ id: wpTags.id, name: wpTags.name, wpId: wpTags.wpId }).from(wpTags),
  ]);

  await applyTaxonomySync(existingCats, decodedCats, {
    insert: (rows) => db.insert(wpCategories).values(rows),
    update: (id, patch) => db.update(wpCategories).set(patch).where(eq(wpCategories.id, id)),
  });
  await applyTaxonomySync(existingTags, decodedTags, {
    insert: (rows) => db.insert(wpTags).values(rows),
    update: (id, patch) => db.update(wpTags).set(patch).where(eq(wpTags.id, id)),
  });

  revalidatePath("/settings/taxonomy");
  return { ok: true as const, categories: wpCats.length, tags: wpTagsList.length };
}
