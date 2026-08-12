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
// Chantier D, Tâche 6 (handoff H1) — voir PreviewTemplateInput.format ci-dessous. relayout-warn.ts
// reste, comme fonts.ts déjà importé juste au-dessus, un module NON client-safe (`node:fs/promises`
// via loadFallbackFonts) — mais previewTemplateCore, appelé UNIQUEMENT depuis un module "use server"
// gardé (lib/actions/studio-preview-actions.ts), n'a jamais eu cette contrainte : c'est
// components/studio/geometry-strip.tsx, "use client", qui devait s'en tenir écarté (voir son propre
// commentaire d'en-tête).
import { overflowingLayerIds } from "./relayout-warn";
import type { FormatKey } from "./formats";
// Tâche 12 (Lot 3) : importé directement de "./asset-loader", PAS du barrel "./index" — index.ts
// importe lib/studio/store.ts (R2RenderStore/saveRender), et
// tests/studio-preview.test.ts:"garantie structurelle" vérifie que preview-core.ts n'atteint JAMAIS
// store.ts ni index.ts, même transitivement, pour garder la garantie "l'aperçu n'écrit rien"
// vérifiable sur le GRAPHE réel plutôt que simulée. asset-loader.ts n'importe que @/db et ./fonts
// (types) — ni l'un ni l'autre ne remonte à store.ts ou index.ts — donc cet import ne menace pas
// cette garantie.
import { DbAssetLoader } from "./asset-loader";

export type PreviewResult =
  | {
      ok: true; dataUri: string; degraded: boolean;
      /** Chantier D, Tâche 6 (handoff H1) — les identifiants des calques texte dont le retour à la
       * ligne, une fois `input.scene` relayoutée vers `input.format`, dépasse leur `maxLines` —
       * `[]` quand `input.format` est absent (rien à mesurer POUR QUEL format) ou qu'aucun calque
       * ne déborde. FALLBACK-FONT-APPROXIMATIF (handoff H2, voir constrainedTextOverflows) : mesuré
       * avec la police de repli, jamais avec la police d'asset réellement peinte par CE rendu (elle,
       * chargée via `assets` juste au-dessus) — voir le commentaire de FilmstripThumb
       * (components/studio/render-mode.tsx) pour la portée exacte de cette approximation. */
      overflowingLayerIds: string[];
    }
  | { ok: false; message: string };

export interface PreviewTemplateInput {
  templateId: string;
  /** Scène COURANTE de l'éditeur, encore en mémoire côté client — pas forcément écrite en base
   * (correctif Critique 1, revue Lot 2). Fournie, elle l'emporte SANS EXCEPTION sur le brouillon lu
   * en base : c'est ce qui permet à l'aperçu de refléter l'édition en cours plutôt que de courir
   * contre l'autosauvegarde (800 ms de différé côté aperçu, 1500 ms côté autosave — sans ce champ,
   * l'aperçu pouvait se déclencher AVANT que l'édition n'atteigne la base et afficher la scène
   * PRÉ-édition, en retard d'un cran, voir components/studio/preview-pane.tsx). Non typée `Scene` :
   * c'est une donnée cliente non fiable comme n'importe quelle autre (voir parseScene ci-dessous),
   * revalidée avant tout usage — jamais de confiance aveugle sur une valeur envoyée par le client. */
  scene?: unknown;
  /** Valeurs saisies par l'appelant (contextes à saisie manuelle, spec §4 source 2) — PRIORITAIRES
   * sur toute autre source, jeton par jeton. */
  values?: TokenValues;
  /** Article réel sélectionné (contextes article_image / social_post, spec §4 source 1). */
  articleId?: string | null;
  // Injectés par les tests uniquement (voir lib/studio/render.ts / images.ts).
  fetchImpl?: typeof fetch;
  // Défaut DbAssetLoader (Tâche 12, comme renderForArticle — lib/studio/index.ts) : sans ce
  // branchement, un calque texte/image ajouté par le sélecteur d'assets (Tâche 13) se
  // prévisualiserait TOUJOURS comme s'il n'avait aucun asset (police de repli silencieuse, ou une
  // RenderError franche pour une image) — l'aperçu mentirait sur l'un des deux seuls chemins que
  // Lot 3 introduit. Toujours overridable, comme avant : les tests y injectent leurs propres
  // implémentations sans jamais toucher à R2.
  assets?: AssetLoader;
  /** Chantier D, Tâche 6 (handoff H1) — le format pour lequel signaler un débordement `maxLines`
   * (voir `PreviewResult.overflowingLayerIds`). N'INFLUENCE PAS le rendu lui-même : `input.scene`,
   * quand fourni, est déjà la scène que l'appelant veut peindre TELLE QUELLE (le filmstrip envoie sa
   * propre scène déjà relayoutée — components/studio/render-mode.tsx#sceneForFormat) ; ce champ ne
   * sert QU'À mesurer le débordement, indépendamment de ce que `scene` porte déjà. Absent, aucun
   * calcul n'a lieu — `overflowingLayerIds` vaut toujours `[]`, comportement inchangé pour tout
   * appelant antérieur à cette tâche (ex. PreviewPane, components/studio/preview-pane.tsx). */
  format?: FormatKey;
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
    // brouillon ». `input.scene`, quand fourni, est CE brouillon — juste pas encore écrit en base
    // (voir le commentaire sur PreviewTemplateInput.scene) — donc prioritaire sur `row.scene`.
    // Une scène venue du client OU lue en base est une donnée non fiable (V1) dans les deux cas :
    // re-validée ici comme partout ailleurs, quelle que soit sa provenance.
    scene = parseScene(input.scene ?? row.scene);
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
      scene, values, assets: input.assets ?? new DbAssetLoader(), fetchImpl: input.fetchImpl, encode: "jpeg",
    });
    // Chantier D, Tâche 6 (handoff H1) — après un rendu réussi, PAS avant : un débordement de texte
    // n'a de sens à signaler que pour une scène qui rend effectivement. `scene` ici est CELLE reçue
    // (voir PreviewTemplateInput.format sur pourquoi ce n'est délibérément pas un second relayout).
    const overflowIds = input.format ? await overflowingLayerIds(scene, input.format) : [];
    return {
      ok: true, dataUri: `data:${out.mime};base64,${Buffer.from(out.bytes).toString("base64")}`,
      degraded: out.degraded, overflowingLayerIds: overflowIds,
    };
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
