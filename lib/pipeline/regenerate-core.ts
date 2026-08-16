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
  actorId: string | null,
  opts: { timeoutMs?: number } = {},
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

  // extract() et NON extractExternal() : ce sont les URLs des sources de l'article, déjà crawlées
  // telles quelles à l'ingestion par extract() (voir la justification à lib/pipeline/stages.ts:192).
  // extractExternal coupait le backfill d'images par fetch direct (lib/extract/index.ts:173-178) et
  // ne laissait que Crawl4AI : c'est ce qui rendait la liste de candidats vide et provoquait
  // l'effacement de l'image en régénération « image seule ».
  const { extract } = await import("@/lib/extract");
  const { withTimeout } = await import("@/lib/pipeline/timeout");
  const { getPipelineSettings } = await import("@/lib/queries/settings");
  const timeoutMs = opts.timeoutMs ?? (await getPipelineSettings()).perOperationTimeoutMs;

  // EN PARALLÈLE : les sources sont indépendantes, et la boucle séquentielle d'origine faisait
  // payer la somme des latences réseau avant le moindre retour à l'éditeur. Chaque source est
  // bornée par le même délai par opération que le chemin d'ingestion (lib/pipeline/run.ts:448) —
  // une source pendue ne peut plus bloquer la régénération indéfiniment. Un échec (ou un
  // dépassement) est best-effort : la source est ignorée, jamais fatale, tant qu'il en reste une.
  const results = await Promise.all(sources.map(async (s) => {
    try {
      const r = await withTimeout(extract(s.url), timeoutMs, "Extraction du contenu");
      if (r.text.trim().length === 0) return null;
      return { mediaName: s.mediaName, url: s.url, text: r.text, images: r.images };
    } catch (e) {
      console.warn(`[regenerate] extraction échouée pour ${s.url}: ${(e as Error).message}`);
      return null;
    }
  }));

  const extracted: { mediaName: string; url: string; text: string }[] = [];
  const candidateImages: string[] = [];
  for (const r of results) {
    if (r === null) continue;
    extracted.push({ mediaName: r.mediaName, url: r.url, text: r.text });
    candidateImages.push(...r.images);
  }
  if (extracted.length === 0) return { ok: false, message: "Impossible d'extraire les sources (indisponibles ou extracteur non configuré).", title: article.title };

  const { generateArticle } = await import("@/lib/ai/generate-article");
  const categoryNames = (await db.select({ name: wpCategories.name }).from(wpCategories)).map((c) => c.name);
  const { draft, via, failure, failureDetail } = await generateArticle({ sources: extracted, candidateImages, categories: categoryNames });
  if (via === "mock") return { ok: false, message: aiFailureMessage(failure ?? "unconfigured", "régénération", failureDetail), title: article.title };

  const { applyRegeneration } = await import("@/lib/pipeline/regenerate");
  await applyRegeneration({
    articleId, prior: { title: article.title, bodyHtml: article.bodyHtml, featuredImageUrl: article.featuredImageUrl, confidenceFlags: article.confidenceFlags },
    draft, fields: parsed.data, sourceCount: extracted.length, categoryNames, actorId,
  });

  return { ok: true, message: "Article régénéré — déposé en revue.", title: article.title };
}
