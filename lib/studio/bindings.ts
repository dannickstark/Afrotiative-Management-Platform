import { and, eq } from "drizzle-orm";
import { db, articles, articleSources, wpCategories, distributions } from "@/db";
import { getWpConfig } from "@/lib/wp/config";
import { wpPostUrl } from "@/lib/wp/post-url";
import type { TokenValues } from "./values";
import { CONTEXT_TOKENS, type TemplateContext, type TokenId } from "./tokens";
// Définie dans son propre module sans import (voir ce fichier pour pourquoi) — réexportée ici pour
// que les imports existants de DEFAULT_CATEGORY_COLOR depuis "./bindings" continuent de fonctionner.
export { DEFAULT_CATEGORY_COLOR } from "./default-category-color";
import { DEFAULT_CATEGORY_COLOR } from "./default-category-color";

// Lue À L'INTÉRIEUR de la fonction, PAS capturée au chargement du module : une capture au niveau
// module fige la valeur au premier import (donc avant que les tests n'aient eu l'occasion de poser
// process.env.STUDIO_BRAND_LOGO_URL) et rend la variable intestable sans redémarrer le process.
// Documentée dans .env.example et docs/DEPLOYMENT.md, aux côtés des cinq R2_* — sans elle,
// {{brand.logo}} est simplement absent des valeurs (comme tout jeton non calculé) et tout gabarit
// qui l'utilise échoue avec « Valeurs manquantes pour : brand.logo. ».
export function brandLogoUrl(): string {
  return process.env.STUDIO_BRAND_LOGO_URL ?? "";
}

// Construit les valeurs de jetons pour un article, PUIS les filtre par contexte. Le filtrage final
// est ce qui garantit qu'un jeton indisponible (article.url en article_image) ne peut pas se
// glisser dans un rendu même si le code de liaison le calculait par mégarde.
export async function articleTokenValues(
  articleId: string,
  context: TemplateContext,
): Promise<TokenValues> {
  const [row] = await db
    .select({ article: articles, categoryName: wpCategories.name, categoryColor: wpCategories.color })
    .from(articles)
    .leftJoin(wpCategories, eq(articles.categoryId, wpCategories.id))
    .where(eq(articles.id, articleId));
  if (!row) throw new Error("Article introuvable.");

  const sources = await db.select().from(articleSources).where(eq(articleSources.articleId, articleId));

  // article.url n'existe qu'après publication WordPress. distributions.externalId ne porte que
  // l'ID du billet, PAS son URL — wpPostUrl (lib/wp/post-url.ts) reconstruit le permalien
  // « ?p=<id> », qui résout sur n'importe quel WordPress quel que soit le réglage de permaliens.
  // getWpConfig() renvoie null si WordPress n'est pas configuré ; wpPostUrl renvoie alors null
  // aussi, et article.url est simplement absent des valeurs — exactement comme n'importe quel
  // autre jeton indisponible. On ne construit PAS l'URL autrement.
  const [dist] = await db
    .select()
    .from(distributions)
    .where(and(eq(distributions.articleId, articleId), eq(distributions.channel, "wordpress")))
    .limit(1);
  const baseUrl = getWpConfig()?.baseUrl ?? null;

  const date = row.article.publishedAt ?? row.article.generatedAt ?? row.article.createdAt;

  const all: TokenValues = {
    "article.title": row.article.title,
    "article.excerpt": row.article.excerpt ?? undefined,
    "article.date": date.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }),
    "article.byline": row.article.aiAuthor ? "Afrotiative Media" : undefined,
    "article.image": row.article.featuredImageUrl ?? undefined,
    "article.url": wpPostUrl(baseUrl, dist?.externalId ?? null) ?? undefined,
    "category.name": row.categoryName ?? undefined,
    "category.color": row.categoryColor ?? DEFAULT_CATEGORY_COLOR,
    "source.names": sources.length ? sources.map((s) => s.mediaName).join(", ") : undefined,
    "brand.logo": brandLogoUrl() || undefined,
  };

  const allowed = new Set<string>(CONTEXT_TOKENS[context]);
  const filtered: TokenValues = {};
  for (const [key, value] of Object.entries(all)) {
    if (value !== undefined && allowed.has(key)) filtered[key as TokenId] = value;
  }
  return filtered;
}
