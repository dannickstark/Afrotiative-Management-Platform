// Palette par défaut pour les 8 catégories de démonstration (CATS dans db/seed.ts). Couleurs
// catégorielles distinctes (palette D3 category10), SANS le vert de la palette d'origine : ce vert
// est trop proche de DEFAULT_CATEGORY_COLOR (lib/studio/default-category-color.ts) pour servir de
// preuve visuelle qu'une couleur EXPLICITE a bien été posée plutôt que le repli silencieux.
//
// Source unique utilisée par deux points d'entrée :
//   - db/seed.ts (reseed complet, destructif) — pose la couleur dès l'insertion.
//   - db/seed-category-colors.ts (backfill idempotent, non destructif) — pose la couleur sur des
//     catégories déjà seedées, sans passer par un reseed complet.
export const DEFAULT_CATEGORY_COLORS: Record<string, string> = {
  "Économie": "#1F77B4",
  "Finance": "#FF7F0E",
  "Marchés": "#9467BD",
  "Startups & Tech": "#17BECF",
  "Énergie": "#D62728",
  "Politique économique": "#7F7F7F",
  "Entreprises": "#8C564B",
  "International": "#E377C2",
};
