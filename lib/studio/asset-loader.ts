// lib/studio/asset-loader.ts — Tâche 12 : l'implémentation RÉELLE de AssetLoader (lib/studio/
// fonts.ts), qui rend enfin `render_assets` (V1) accessible au moteur de rendu. Jusqu'ici,
// NullAssetLoader était la SEULE implémentation existante — tout gabarit retombait donc
// systématiquement sur la police embarquée, et aucune image ne pouvait référencer un asset.
//
// Contrat central (brief Tâche 12) : "A missing asset returns null, never throws." render.ts
// (renderScene) tolère déjà un magasin qui LÈVE sur font() — Finding 1, tests/studio-render.test.ts,
// "un magasin d'assets qui lève au lieu de renvoyer null dégrade quand même, sans planter" — donc ce
// n'est pas strictement nécessaire à la correction du PIPELINE de rendu. C'est néanmoins un invariant
// propre à CETTE classe (testé isolément par tests/studio-asset-loader.test.ts, pas seulement à
// travers renderScene) : chaque méthode encapsule donc elle-même ses échecs (ligne absente,
// connexion DB, téléchargement R2) plutôt que de compter sur la tolérance de l'appelant.
import { eq } from "drizzle-orm";
import { db, renderAssets } from "@/db";
import type { AssetLoader, LoadedFont } from "./fonts";

export class DbAssetLoader implements AssetLoader {
  // Mémoïsé sur la PROMESSE (comme loadFallbackFonts, fonts.ts), pas sur le résultat : deux appels
  // concurrents pour le même assetId (deux calques texte partageant la même police, avant même que
  // render.ts ne déduplique par `seen` — voir son commentaire) ne doivent télécharger l'objet R2
  // qu'une seule fois. Contrairement à loadFallbackFonts, PAS de réarmement sur rejet ici : une
  // instance de DbAssetLoader vit le temps d'UN SEUL rendu (renderForArticle/previewTemplateCore en
  // créent une fraîche à chaque appel, exactement comme R2RenderStore — lib/studio/index.ts), jamais
  // au niveau du process — un échec transitoire mis en cache ne peut donc jamais "empoisonner" un
  // futur rendu, qui repartira de toute façon d'une instance neuve.
  private readonly fontCache = new Map<string, Promise<LoadedFont | null>>();

  async font(assetId: string): Promise<LoadedFont | null> {
    let cached = this.fontCache.get(assetId);
    if (!cached) {
      cached = this.fetchFont(assetId);
      this.fontCache.set(assetId, cached);
    }
    return cached;
  }

  private async fetchFont(assetId: string): Promise<LoadedFont | null> {
    try {
      const [row] = await db.select().from(renderAssets).where(eq(renderAssets.id, assetId)).limit(1);
      // Absent, ou présent mais mal typé (un identifiant d'IMAGE passé par erreur à font()) : les
      // deux sont "manquant" du point de vue de l'appelant, jamais une exception.
      if (!row || row.kind !== "font") return null;

      const res = await fetch(row.url);
      if (!res.ok) {
        console.error(`[studio] téléchargement de la police d'asset « ${assetId} » échoué : HTTP ${res.status} (${row.url}).`);
        return null;
      }
      const data = await res.arrayBuffer();

      return {
        // La colonne font_family peut être vide sur d'anciennes lignes semées avant que ce champ ne
        // soit obligatoire côté formulaire (Tâche 11) — repli sur le nom d'affichage de l'asset,
        // jamais une chaîne vide transmise à satori.
        name: row.fontFamily?.trim() || row.name,
        data,
        weight: row.fontWeight ?? 400,
        style: row.fontStyle === "italic" ? "italic" : "normal",
      };
    } catch (e) {
      console.error(`[studio] chargement de la police d'asset « ${assetId} » échoué :`, e);
      return null;
    }
  }

  async imageUrl(assetId: string): Promise<string | null> {
    try {
      const [row] = await db
        .select({ url: renderAssets.url, kind: renderAssets.kind })
        .from(renderAssets).where(eq(renderAssets.id, assetId)).limit(1);
      if (!row || row.kind !== "image") return null;
      return row.url;
    } catch (e) {
      console.error(`[studio] résolution de l'URL de l'asset image « ${assetId} » échouée :`, e);
      return null;
    }
  }
}
