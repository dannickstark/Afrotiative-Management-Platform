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
import type { TemplateContext } from "./tokens";

export type RenderForArticleResult =
  | { ok: true; url: string; renderId: string; degraded: boolean }
  | { ok: true; url: null; renderId: null; degraded: false }
  | { ok: false; message: string };

// API publique de V1. V3 (onglet Aperçu) et D1 (panneau Diffusion) n'appellent que ceci.
export async function renderForArticle(
  articleId: string,
  o: { context: TemplateContext; channel?: string | null; store?: RenderStore },
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

    const out = await renderScene({ scene: template.scene, values });
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
export { validateScene, CONTEXT_TOKENS, TOKEN_KINDS, TEMPLATE_CONTEXTS, CHANNELS } from "./tokens";
export { parseScene, type Scene } from "./scene";
export { FORMAT_PRESETS, type FormatKey } from "./formats";
export { MemoryRenderStore, type RenderStore } from "./store";
