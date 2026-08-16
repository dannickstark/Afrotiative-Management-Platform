import { db, articles } from "@/db";
import { eq } from "drizzle-orm";
import { regenerateFieldsSchema, type RegenerateFieldsInput } from "@/lib/validation";
import { aiFailureMessage } from "@/lib/ai/failure-message";

// Cœur de la régénération, par article — extrait de regenerate() (lib/actions/article-actions.ts).
// Volontairement PLAIN (pas de "use server") : ni requireUser/requirePermission ni revalidatePath
// ici — l'appelant possède la garde RBAC et la revalidation (l'action unitaire regenerate et
// regenerateInQueue, appelé en boucle par la barre d'actions du /queue). Les imports RESTENT
// DYNAMIQUES (await import) pour que le graphe d'extraction/génération lourd (jsdom) n'entre jamais
// dans l'analyse statique des modules "use server" appelants — même raison que le commentaire
// d'origine au-dessus de regenerate(). Exception délibérée : l'import de `aiFailureMessage`
// (lib/ai/failure-message.ts) reste STATIQUE — ce module est pur (aucune dépendance DB/réseau/
// jsdom), il ne réintroduit donc rien de lourd dans l'analyse statique et n'a pas à suivre la
// règle des imports dynamiques ci-dessus.
//
// Retourne toujours `title` (le titre courant de l'article) pour un rapport d'échec lisible en lot.
export async function regenerateArticle(
  articleId: string,
  fields: RegenerateFieldsInput,
  actorId: string,
): Promise<{ ok: boolean; message: string; title: string }> {
  // Revalidation défensive : l'appelant valide déjà, mais on ne fait jamais confiance à une entrée
  // non revalidée avant d'écrire.
  const parsed = regenerateFieldsSchema.safeParse(fields);
  if (!parsed.success) return { ok: false, message: "Sélectionnez au moins un champ à régénérer.", title: articleId };

  const { articleSources, wpCategories } = await import("@/db");
  const [article] = await db.select().from(articles).where(eq(articles.id, articleId));
  if (!article) return { ok: false, message: "Article introuvable.", title: articleId };
  const sources = await db.select().from(articleSources).where(eq(articleSources.articleId, articleId));
  if (sources.length === 0) return { ok: false, message: "Aucune source à régénérer.", title: article.title };

  const { extractExternal } = await import("@/lib/extract");
  const extracted: { mediaName: string; url: string; text: string; images?: string[] }[] = [];
  const candidateImages: string[] = [];
  for (const s of sources) {
    try {
      const r = await extractExternal(s.url);
      if (r.text.trim().length > 0) { extracted.push({ mediaName: s.mediaName, url: s.url, text: r.text }); candidateImages.push(...r.images); }
    } catch (e) {
      console.warn(`[regenerate] extraction échouée pour ${s.url}: ${(e as Error).message}`);
    }
  }
  if (extracted.length === 0) return { ok: false, message: "Impossible d'extraire les sources (indisponibles ou extracteur non configuré).", title: article.title };

  const { generateArticle } = await import("@/lib/ai/generate-article");
  const categoryNames = (await db.select({ name: wpCategories.name }).from(wpCategories)).map((c) => c.name);
  // `fields` et `current` rendent la génération consciente de la sélection : quand « Corps » est
  // décoché, generateArticle ne demande plus la rédaction d'un article entier (>90 % des tokens de
  // sortie) et s'appuie sur le corps existant pour rester cohérent avec lui.
  const { draft, via, failure, failureDetail } = await generateArticle({
    sources: extracted, candidateImages, categories: categoryNames,
    fields: parsed.data, current: { title: article.title, bodyHtml: article.bodyHtml },
  });
  if (via === "mock") return { ok: false, message: aiFailureMessage(failure ?? "unconfigured", "régénération", failureDetail), title: article.title };

  const { applyRegeneration } = await import("@/lib/pipeline/regenerate");
  await applyRegeneration({
    articleId, prior: { title: article.title, bodyHtml: article.bodyHtml, featuredImageUrl: article.featuredImageUrl, confidenceFlags: article.confidenceFlags },
    draft, fields: parsed.data, sourceCount: extracted.length, categoryNames, actorId,
  });

  return { ok: true, message: "Article régénéré — déposé en revue.", title: article.title };
}
