"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { validateCategoryColor } from "@/lib/validation";

// The DB-upsert core (applyTaxonomySync) and the pure diff/slug helpers live in NON-"use server"
// modules (lib/taxonomy-sync-core.ts / lib/taxonomy-diff.ts) — NOT here. Every export from a
// file-level "use server" module is a callable Server Action with no auth of its own, so exporting
// the raw DB-writer here would be an unauthenticated write path. Keeping it out forces all callers
// through the RBAC-guarded syncTaxonomyFromWordPress below (mirrors the SP5 publishDueArticles
// fix). This file therefore exports ONLY guarded async actions.

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
  const { applyTaxonomySync } = await import("@/lib/taxonomy-sync-core");
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

// V2 Task 3 — the write path V1 documented as missing: wp_categories.color (db/schema.ts) and the
// {{category.color}} render read (lib/studio/articleTokenValues) both existed with no way to set
// the column, so every render fell back to DEFAULT_CATEGORY_COLOR regardless of the article's real
// category. Tags have no `color` column (kept off wpTags deliberately — see components/settings/
// taxonomy-tables.tsx), so this only ever targets wpCategories.
//
// Validation lives in lib/validation.ts (validateCategoryColor), not inline: same "use server"
// constraint as syncTaxonomyFromWordPress's neighbors (validateFeedInput, validateMemberInput) —
// this module may only export async functions, so a pure helper can't live here.
export async function setCategoryColor(
  id: string,
  color: string | null,
): Promise<{ ok: true } | { ok: false; message: string }> {
  await guard();

  const validated = validateCategoryColor(color);
  if (!validated.ok) return validated;

  const { db, wpCategories } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  await db.update(wpCategories).set({ color: validated.data }).where(eq(wpCategories.id, id));

  revalidatePath("/settings/taxonomy");
  return { ok: true as const };
}
