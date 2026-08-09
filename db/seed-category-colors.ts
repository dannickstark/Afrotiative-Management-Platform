import { and, eq, isNull } from "drizzle-orm";
import { db, wpCategories } from "./index";
import { DEFAULT_CATEGORY_COLORS } from "./default-category-colors";

// IDEMPOTENT et NON destructif — même contrat que db/studio-templates.ts (seedStudioTemplates).
// Contrairement à db/seed.ts (qui EFFACE toutes les tables), ce script backfille les couleurs par
// défaut sur des catégories DÉJÀ présentes en base, sans toucher au reste des données.
//
// N'écrit QUE là où `color IS NULL` : une couleur déjà posée par un admin depuis /settings/taxonomy
// (setCategoryColor) n'est jamais écrasée — c'est ce qui rend le script sûr à relancer et sûr à
// exécuter après que quelqu'un a commencé à personnaliser ses couleurs. Correspondance par NOM
// exact contre DEFAULT_CATEGORY_COLORS ; une catégorie absente de cette liste (par ex. importée
// depuis WordPress) est laissée telle quelle — aucune couleur inventée.
export async function seedDefaultCategoryColors(): Promise<{ updated: number; skipped: number }> {
  let updated = 0;
  let skipped = 0;

  for (const [name, color] of Object.entries(DEFAULT_CATEGORY_COLORS)) {
    const rows = await db.update(wpCategories)
      .set({ color })
      .where(and(eq(wpCategories.name, name), isNull(wpCategories.color)))
      .returning({ id: wpCategories.id });
    if (rows.length) updated += rows.length;
    else skipped++;
  }

  return { updated, skipped };
}

if (import.meta.main) {
  seedDefaultCategoryColors()
    .then((r) => {
      console.log(`Couleurs de catégorie — posées : ${r.updated}, déjà présentes/introuvables : ${r.skipped}`);
      process.exit(0);
    })
    .catch((e) => { console.error(e); process.exit(1); });
}
