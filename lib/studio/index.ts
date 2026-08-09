import { articles, db } from "@/db";
import { eq } from "drizzle-orm";
import { getStudioConfig } from "./config";
import { resolveTemplate } from "./resolve";
import { articleTokenValues } from "./bindings";
import { renderScene, RenderError } from "./render";
import {
  R2RenderStore, computeInputHash, storageKeyFor, findCachedRender, saveRender,
  type RenderStore,
} from "./store";
import { MissingTokensError } from "./values";
import { ImageFetchError } from "./images";
import { SceneError } from "./scene";
import type { TemplateContext, Channel } from "./tokens";
import type { AssetLoader } from "./fonts";

export type RenderForArticleResult =
  | { ok: true; url: string; renderId: string; degraded: boolean }
  | { ok: true; url: null; renderId: null; degraded: false }
  | { ok: false; message: string };

// API publique de V1. V3 (onglet Aperçu) et D1 (panneau Diffusion) n'appellent que ceci.
export async function renderForArticle(
  articleId: string,
  o: {
    // Channel, PAS string : render_templates.channel est du texte libre en base (aucun enum
    // Postgres, voir db/schema.ts) et resolveTemplate retombe SILENCIEUSEMENT sur le gabarit par
    // défaut du contexte quand aucune ligne ne correspond au canal demandé — une faute de frappe
    // D1 ("Facebook" au lieu de "facebook") ne lèverait alors AUCUNE erreur nulle part, juste le
    // mauvais gabarit rendu sans avertissement. Typer ce paramètre en Channel fait échouer une
    // telle faute de frappe à la COMPILATION plutôt que d'en faire un bug silencieux à l'exécution.
    context: TemplateContext; channel?: Channel | null; store?: RenderStore;
    // Injecté par les tests uniquement — voir lib/studio/images.ts : le garde SSRF n'est levé que
    // si fetchImpl est fourni ET process.env.NODE_ENV === "test", jamais par sa seule présence.
    fetchImpl?: typeof fetch;
    // Optionnel — défaut NullAssetLoader (voir fonts.ts) : V1 n'a pas de bibliothèque d'assets, V2
    // la peuplera (render_assets). Point d'injection pour que V2 branche un vrai chargeur sans
    // toucher à cette fonction.
    assets?: AssetLoader;
  },
): Promise<RenderForArticleResult> {
  const store = o.store ?? new R2RenderStore();
  if (!o.store && !getStudioConfig()) {
    return { ok: false, message: "Stockage R2 non configuré." };
  }

  const [article] = await db
    .select({ categoryId: articles.categoryId })
    .from(articles)
    .where(eq(articles.id, articleId));
  if (!article) return { ok: false, message: "Article introuvable." };

  const template = await resolveTemplate({
    context: o.context, channel: o.channel ?? null, categoryId: article.categoryId,
  });
  // Aucun gabarit n'est un cas NORMAL, pas une erreur : l'appelant garde l'image brute.
  if (!template) return { ok: true, url: null, renderId: null, degraded: false };

  try {
    const values = await articleTokenValues(articleId, o.context);
    const inputHash = computeInputHash({
      templateId: template.templateId, templateVersion: template.version, values,
    });

    // Court-circuit AVANT tout rendu : un appel identique (même gabarit, même version, mêmes
    // valeurs) renvoie la ligne déjà en cache plutôt que de re-rendre.
    const cached = await findCachedRender(inputHash);
    if (cached) return { ok: true, url: cached.url, renderId: cached.id, degraded: cached.degraded };

    const out = await renderScene({ scene: template.scene, values, fetchImpl: o.fetchImpl, assets: o.assets });
    const key = storageKeyFor(inputHash, out.mime, new Date());
    const url = await store.put(key, out.bytes, out.mime);

    const saved = await saveRender({
      templateId: template.templateId,
      templateVersion: template.version,
      context: o.context,
      subjectType: "article",
      subjectId: articleId,
      inputHash,
      storageKey: key,
      url,
      width: out.width,
      height: out.height,
      bytes: out.bytes.byteLength,
      degraded: out.degraded,
    });

    return { ok: true, url: saved.url, renderId: saved.id, degraded: saved.degraded };
  } catch (e) {
    // Échec DUR et message français : chaque rendu est déclenché par une action humaine délibérée
    // (« Approuver & publier », « Publier sur Facebook »). Diffuser silencieusement une carte au
    // fond manquant est pire qu'une erreur claire et réessayable. RenderError couvre désormais
    // TOUT échec natif de renderScene (satori/resvg/sharp/qrcode) — ajoutée après ce module,
    // elle doit être attrapée ici au même titre que les trois erreurs typées d'origine.
    //
    // Le message affiché à l'éditeur reste français et sans détail natif (voir les branches
    // ci-dessous) ; ce log est la SEULE trace qui survit en production — sans lui, un échec
    // franc n'existe nulle part ailleurs que dans une phrase affichée une fois à l'écran.
    console.error(`[studio] renderForArticle échoué (article ${articleId}) :`, e);
    if (
      e instanceof MissingTokensError || e instanceof ImageFetchError ||
      e instanceof SceneError || e instanceof RenderError
    ) {
      return { ok: false, message: `Génération de l'image échouée — ${e.message}` };
    }
    return { ok: false, message: `Génération de l'image échouée : ${(e as Error).message}` };
  }
}

export { resolveTemplate } from "./resolve";
export {
  validateScene, extractTokens, CONTEXT_TOKENS, TOKEN_KINDS, TEMPLATE_CONTEXTS, CHANNELS,
  TOKEN_IDS, type TokenId, type TemplateContext, type Channel,
} from "./tokens";
export {
  parseScene, sceneSchema, type Scene, type Layer, type ImageLayer, type TextLayer,
  type ShapeLayer, type QrLayer, type Frame, type Gradient, type ImageSource,
} from "./scene";
export { FORMAT_PRESETS, FORMAT_KEYS, type FormatKey } from "./formats";
export { MemoryRenderStore, type RenderStore } from "./store";
// renderScene rend une SCÈNE déjà résolue (pas un article) : c'est ce dont V2 a besoin pour
// prévisualiser un BROUILLON — renderForArticle ne rend jamais que l'instantané PUBLIÉ, V2 ne peut
// donc pas s'en servir pour l'aperçu de l'éditeur de gabarits.
export { renderScene, RenderError } from "./render";
export type { AssetLoader, LoadedFont } from "./fonts";
// Au-delà de la liste demandée : exporter renderScene sans exporter les erreurs typées qu'il lève
// laisserait V2 incapable de distinguer un MissingTokensError d'un SceneError autrement qu'en
// inspectant .constructor.name — exactement le contournement fragile que ces classes existent pour
// éviter. Elles sont déjà importées ici (voir en haut de ce fichier) pour le catch de
// renderForArticle ; les réexporter ne coûte rien.
export { MissingTokensError } from "./values";
export { ImageFetchError } from "./images";
export { SceneError } from "./scene";
