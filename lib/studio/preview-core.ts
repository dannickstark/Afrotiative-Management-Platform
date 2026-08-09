// lib/studio/preview-core.ts — le cœur (SANS "use server") de l'aperçu réel de l'éditeur (Tâche 10,
// spec §4). Même discipline que lib/studio/template-core.ts : ce module n'est appelable QUE depuis
// lib/actions/studio-preview-actions.ts (guardé requireUser()+requirePermission()), jamais
// directement depuis le client — exporter previewTemplateCore depuis un module "use server" en
// ferait un point d'entrée réseau non gardé (voir le commentaire en tête de
// lib/actions/taxonomy-actions.ts).
//
// Contrainte centrale de la spec : l'aperçu N'ÉCRIT RIEN — ni ligne `renders`, ni objet R2. Ce
// module appelle renderScene() DIRECTEMENT (jamais renderForArticle, jamais RenderStore/saveRender)
// — c'est structurellement impossible d'y écrire quoi que ce soit, pas seulement « non implémenté
// pour l'instant » (voir tests/studio-preview.test.ts, qui vérifie que ni la table `renders` ni un
// MemoryRenderStore témoin ne bougent).
import { eq } from "drizzle-orm";
import { db, renderTemplates } from "@/db";
import { parseScene, SceneError, type Scene } from "./scene";
import { CONTEXT_TOKENS, type TemplateContext } from "./tokens";
import { articleTokenValues } from "./bindings";
import { renderScene, RenderError } from "./render";
import { MissingTokensError, type TokenValues } from "./values";
import { ImageFetchError } from "./images";
import { SAMPLE_VALUES } from "./sample-values";
import type { AssetLoader } from "./fonts";

export type PreviewResult =
  | { ok: true; dataUri: string; degraded: boolean }
  | { ok: false; message: string };

export interface PreviewTemplateInput {
  templateId: string;
  /** Valeurs saisies par l'appelant (contextes à saisie manuelle, spec §4 source 2) — PRIORITAIRES
   * sur toute autre source, jeton par jeton. */
  values?: TokenValues;
  /** Article réel sélectionné (contextes article_image / social_post, spec §4 source 1). */
  articleId?: string | null;
  // Injectés par les tests uniquement (voir lib/studio/render.ts / images.ts).
  fetchImpl?: typeof fetch;
  assets?: AssetLoader;
}

// Fusionne les trois sources dans l'ORDRE DE PRIORITÉ requis (appelant > article > échantillon,
// jeton par jeton — PAS un remplacement en bloc d'une source par une autre) et complète tout jeton
// du contexte encore manquant avec SAMPLE_VALUES, pour qu'un gabarit tout juste créé, sans article
// choisi ni valeur saisie, se prévisualise quand même immédiatement (spec §4).
function resolvePreviewValues(context: TemplateContext, articleValues: TokenValues, caller?: TokenValues): TokenValues {
  const merged: TokenValues = { ...articleValues, ...caller };
  for (const id of CONTEXT_TOKENS[context]) {
    if (merged[id] === undefined && SAMPLE_VALUES[id] !== undefined) merged[id] = SAMPLE_VALUES[id];
  }
  return merged;
}

export async function previewTemplateCore(input: PreviewTemplateInput): Promise<PreviewResult> {
  const [row] = await db
    .select({ scene: renderTemplates.scene, context: renderTemplates.context })
    .from(renderTemplates)
    .where(eq(renderTemplates.id, input.templateId));
  if (!row) return { ok: false, message: "Gabarit introuvable." };

  const context = row.context as TemplateContext;

  let scene: Scene;
  try {
    // Le BROUILLON, jamais l'instantané publié — spec §4 : « appelle renderScene sur la scène
    // brouillon ». Une scène lue en base est une donnée non fiable (V1) : re-validée ici comme
        // partout ailleurs.
    scene = parseScene(row.scene);
  } catch (e) {
    return { ok: false, message: e instanceof SceneError ? e.message : "Scène invalide." };
  }

  let articleValues: TokenValues = {};
  if (input.articleId) {
    try {
      articleValues = await articleTokenValues(input.articleId, context);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "Article introuvable." };
    }
  }
  const values = resolvePreviewValues(context, articleValues, input.values);

  try {
    const out = await renderScene({
      scene, values, assets: input.assets, fetchImpl: input.fetchImpl, encode: "jpeg",
    });
    return { ok: true, dataUri: `data:${out.mime};base64,${Buffer.from(out.bytes).toString("base64")}`, degraded: out.degraded };
  } catch (e) {
    // Même politique que renderForArticle (lib/studio/index.ts) : message français sans détail
    // natif, journalisé côté serveur pour que l'incident reste traçable ailleurs qu'à l'écran.
    console.error(`[studio] aperçu du gabarit ${input.templateId} échoué :`, e);
    if (e instanceof MissingTokensError || e instanceof ImageFetchError || e instanceof SceneError || e instanceof RenderError) {
      return { ok: false, message: e.message };
    }
    return { ok: false, message: `Aperçu impossible : ${(e as Error).message}` };
  }
}
