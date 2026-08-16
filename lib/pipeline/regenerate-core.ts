import { db, articles } from "@/db";
import { eq } from "drizzle-orm";
import { regenerateFieldsSchema, type RegenerateFieldsInput } from "@/lib/validation";
import { aiFailureMessage } from "@/lib/ai/failure-message";
import { planRegeneration } from "@/lib/pipeline/regen-plan";
import type { RegenStage } from "@/lib/pipeline/regen-live";

// Cœur de la régénération, par article — appelé depuis lib/pipeline/regen-job.ts pour chaque
// article du job de renvoi à l'IA (lot ET unitaire, voir lib/actions/regen-actions.ts).
// Volontairement PLAIN (pas de "use server") : ni requireUser/requirePermission ni revalidatePath
// ici — l'appelant (startRegenJob) possède la garde RBAC, et c'est le job lui-même qui pilote la
// revalidation. Les imports RESTENT DYNAMIQUES (await import) pour que le graphe d'extraction/
// génération lourd (jsdom) n'entre jamais dans l'analyse statique des modules "use server"
// appelants. Exception délibérée : l'import de `aiFailureMessage`
// (lib/ai/failure-message.ts) reste STATIQUE — ce module est pur (aucune dépendance DB/réseau/
// jsdom), il ne réintroduit donc rien de lourd dans l'analyse statique et n'a pas à suivre la
// règle des imports dynamiques ci-dessus.
//
// Retourne toujours `title` (le titre courant de l'article) pour un rapport d'échec lisible en lot.
export async function regenerateArticle(
  articleId: string,
  fields: RegenerateFieldsInput,
  actorId: string | null,
  opts: { timeoutMs?: number; imageMode?: "auto" | "manual"; onStage?: (stage: RegenStage) => void | Promise<void> } = {},
): Promise<{ ok: boolean; message: string; title: string; awaitingImage?: boolean }> {
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
  await opts.onStage?.("extracting");
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

  // Le plan tranche AVANT de payer un appel LLM : une régénération « image seule » sans le moindre
  // candidat n'a plus d'objet, et une régénération mixte doit épargner l'image sans renoncer aux
  // autres champs. Voir lib/pipeline/regen-plan.ts.
  const plan = planRegeneration({ fields: parsed.data, candidateCount: candidateImages.length });
  if (plan.abort !== null) return { ok: false, message: plan.abort, title: article.title };

  await opts.onStage?.("generating");
  const { generateArticle } = await import("@/lib/ai/generate-article");
  const categoryNames = (await db.select({ name: wpCategories.name }).from(wpCategories)).map((c) => c.name);
  // `fields` et `current` rendent la génération consciente de la sélection : quand « Corps » est
  // décoché, generateArticle ne demande plus la rédaction d'un article entier (>90 % des tokens de
  // sortie) et s'appuie sur le corps existant pour rester cohérent avec lui.
  //
  // On transmet `plan.effectiveFields` et NON `parsed.data` : le plan a pu retirer `image` de la
  // sélection (aucune image candidate n'a été trouvée, voir lib/pipeline/regen-plan.ts). Demander
  // au modèle un champ qu'on a déjà décidé de ne pas appliquer gaspillerait précisément les tokens
  // que ce chemin partiel existe pour économiser — et ferait choisir une image dans une liste vide.
  const { draft, via, failure, failureDetail } = await generateArticle({
    sources: extracted, candidateImages, categories: categoryNames,
    fields: plan.effectiveFields, current: { title: article.title, bodyHtml: article.bodyHtml },
  });
  if (via === "mock") return { ok: false, message: aiFailureMessage(failure ?? "unconfigured", "régénération", failureDetail), title: article.title };

  await opts.onStage?.("writing");
  const { applyRegeneration } = await import("@/lib/pipeline/regenerate");
  await applyRegeneration({
    articleId, prior: { title: article.title, bodyHtml: article.bodyHtml, featuredImageUrl: article.featuredImageUrl, confidenceFlags: article.confidenceFlags },
    draft, fields: plan.effectiveFields, sourceCount: extracted.length, categoryNames, actorId,
  });

  const message = plan.warning !== null
    ? `Article régénéré — déposé en revue. ${plan.warning}`
    : "Article régénéré — déposé en revue.";
  return { ok: true, message, title: article.title };
}
