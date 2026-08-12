// lib/studio/thumbnail-core.ts — Chantier A, Tâche 5 (spec §4) : le rendu en VIGNETTE d'un gabarit
// pour la galerie /studio (liste), pour components/studio/templates-gallery.tsx. Réutilise
// previewTemplateCore (lib/studio/preview-core.ts) — le MÊME moteur que l'aperçu de l'éditeur et le
// filmstrip (components/studio/render-mode.tsx#FilmstripThumb) — plutôt que d'appeler renderScene()
// une seconde fois indépendamment. Rendu au FORMAT D'ACCUEIL du gabarit (son format natif —
// render_templates.format/scene.canvas) : AUCUN relayout ici, la galerie montre le gabarit TEL
// QU'IL EST dans son brouillon, pas adapté à un autre format (ce n'est pas le filmstrip).
//
// CACHE — DÉLIBÉRÉMENT PAS lib/studio/store.ts (computeInputHash / findCachedRender / saveRender,
// le cache que renderForArticle et renderManualCore utilisent) : ce cache-là suppose un gabarit
// PUBLIÉ, identifié par un entier stable (`templateVersion`, colonne `integer` NOT NULL —
// db/schema.ts) — le contrat qu'une même (templateId, templateVersion) produit TOUJOURS la même
// image, donc peut être mise en cache indéfiniment ET auditée (chaque ligne `renders` trace un
// envoi réel — voir le commentaire de lib/studio/manual-core.ts). Un gabarit encore en BROUILLON
// (celui que /studio liste, publié ou non) n'a pas ce numéro : sa scène change à chaque édition,
// sous le MÊME templateId, sans jamais rien incrémenter. Le seul entier disponible serait
// `updatedAt` (un `Date`) — le forcer dans la colonne `integer` de `renders.templateVersion`
// déborderait purement et simplement (un epoch-ms tient sur ~41 bits, `integer` Postgres sur 32) :
// pas une limitation qu'on contourne proprement, une incompatibilité de TYPE. Réutiliser ce cache
// écrirait aussi un objet R2 + une ligne `renders` à chaque vignette de LISTE jamais demandée par un
// utilisateur pour être « générée » — polluant la table d'audit des rendus réellement
// envoyés/publiés (spec de renders.subjectType : 'article' | 'manual', jamais 'thumbnail').
//
// Cache maison, donc, EN MÉMOIRE PROCESS — mémoïsé sur la PROMESSE (même idiome que
// loadFallbackFonts, lib/studio/fonts.ts, et DbAssetLoader.fontCache, lib/studio/asset-loader.ts),
// clé = templateId + un hachage de la scène COURANTE (PAS un numéro de version) : un brouillon
// modifié change de clé automatiquement, sans la moindre invalidation explicite à écrire ni à
// oublier — exactement l'invariant qu'il faut pour un brouillon mutable. Réarmé sur ÉCHEC (même
// discipline que loadFallbackFonts) : une panne transitoire (réseau, police) ne doit pas
// empoisonner toutes les vignettes suivantes du même gabarit pour le reste du process.
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, renderTemplates } from "@/db";
import { previewTemplateCore, type PreviewResult } from "./preview-core";
import type { AssetLoader } from "./fonts";

const thumbnailCache = new Map<string, Promise<PreviewResult>>();

function thumbnailCacheKey(templateId: string, scene: unknown): string {
  return createHash("sha256").update(JSON.stringify([templateId, scene])).digest("hex");
}

export interface RenderTemplateThumbnailInput {
  templateId: string;
  // Injectés par les tests uniquement — même convention que previewTemplateCore
  // (lib/studio/preview-core.ts) : le vrai appelant (lib/actions/studio-thumbnail-actions.ts) ne
  // fournit jamais ces trois champs.
  fetchImpl?: typeof fetch;
  assets?: AssetLoader;
  /** Point d'injection de test UNIQUEMENT — permet de COMPTER les rendus réels sans mocker tout le
   * module previewTemplateCore (satori/resvg/sharp) : tests/studio-templates-gallery.test.ts
   * l'enveloppe d'un compteur pour prouver « deux appels, un seul rendu sous-jacent ». Défaut
   * previewTemplateCore, jamais fourni par renderTemplateThumbnail (le vrai appelant). */
  previewImpl?: typeof previewTemplateCore;
}

export async function renderTemplateThumbnailCore(input: RenderTemplateThumbnailInput): Promise<PreviewResult> {
  const [row] = await db
    .select({ scene: renderTemplates.scene })
    .from(renderTemplates)
    .where(eq(renderTemplates.id, input.templateId));
  if (!row) return { ok: false, message: "Gabarit introuvable." };

  const key = thumbnailCacheKey(input.templateId, row.scene);
  const cached = thumbnailCache.get(key);
  if (cached) return cached;

  const render = input.previewImpl ?? previewTemplateCore;
  const promise = render({
    templateId: input.templateId, scene: row.scene, fetchImpl: input.fetchImpl, assets: input.assets,
  }).then((res) => {
    // Repli sur échec (même discipline que loadFallbackFonts, fonts.ts) : un rendu raté (police
    // manquante, image injoignable…) ne doit pas rester collé en cache — le prochain appel doit
    // pouvoir retenter, pas rejouer indéfiniment le même échec.
    if (!res.ok) thumbnailCache.delete(key);
    return res;
  });
  thumbnailCache.set(key, promise);
  return promise;
}

// Test-only — vide le cache process ENTRE suites : sans lui, un templateId réutilisé par une suite
// PRÉCÉDENTE (même exécution `bun test`, un seul process) pourrait fausser un compte de rendus
// « un seul rendu sous-jacent » attendu par la suite SUIVANTE. Jamais appelé par du code de
// production.
export function clearThumbnailCache(): void {
  thumbnailCache.clear();
}
