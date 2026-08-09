// lib/studio/manual-core.ts — le cœur (SANS "use server") de la génération ponctuelle (Tâche 14,
// spec §7). Même discipline que lib/studio/template-core.ts et lib/studio/preview-core.ts : ce
// module n'est appelable QUE depuis lib/actions/studio-manual-actions.ts (gardé requireUser() +
// requirePermission()), jamais directement depuis le client — exporter renderManualCore depuis un
// module "use server" en ferait un point d'entrée réseau non gardé (voir le commentaire en tête de
// lib/actions/taxonomy-actions.ts).
//
// Contraste avec previewTemplateCore, délibéré (spec §7) : ceci ÉCRIT — R2 + une ligne `renders`
// (subjectType: "manual", subjectId: null) — parce que l'utilisateur veut un fichier, pas un simple
// coup d'œil. La structure reprend donc celle de renderForArticle (lib/studio/index.ts), pas celle
// de previewTemplateCore : résoudre un gabarit PUBLIÉ (jamais un brouillon), court-circuiter sur un
// rendu déjà en cache par inputHash, rendre, téléverser, enregistrer.
import { resolveTemplate } from "./resolve";
import { renderScene, RenderError } from "./render";
import { getStudioConfig } from "./config";
import {
  R2RenderStore, computeInputHash, storageKeyFor, findCachedRender, saveRender,
  type RenderStore,
} from "./store";
import { MissingTokensError, type TokenValues } from "./values";
import { ImageFetchError } from "./images";
import { SceneError } from "./scene";
import type { TemplateContext, Channel } from "./tokens";
import type { AssetLoader } from "./fonts";
import { DbAssetLoader } from "./asset-loader";

export type RenderManualResult =
  | { ok: true; url: string; renderId: string; degraded: boolean }
  | { ok: false; message: string };

export interface RenderManualInput {
  context: TemplateContext;
  // Channel, PAS string — même raisonnement que renderForArticle (lib/studio/index.ts) : un typo
  // silencieux dans le canal ferait retomber resolveTemplate sur le gabarit par défaut du contexte
  // sans la moindre erreur. components/studio/manual-generate.tsx alimente ce champ depuis un
  // <Select> construit sur CHANNELS, donc aucune valeur libre ne peut de toute façon l'atteindre —
  // le typage ne fait que refuser à la COMPILATION ce que l'UI refuse déjà à l'écran.
  channel?: Channel | null;
  categoryId?: string | null;
  values: TokenValues;
  // Test-only — même motif que renderForArticle : une instance FRAÎCHE de R2RenderStore par appel
  // en production (jamais partagée), overridable pour observer les écritures sans toucher au vrai R2.
  store?: RenderStore;
  fetchImpl?: typeof fetch;
  assets?: AssetLoader;
}

export async function renderManualCore(input: RenderManualInput): Promise<RenderManualResult> {
  const store = input.store ?? new R2RenderStore();
  if (!input.store && !getStudioConfig()) {
    return { ok: false, message: "Stockage R2 non configuré." };
  }

  const template = await resolveTemplate({
    context: input.context, channel: input.channel ?? null, categoryId: input.categoryId ?? null,
  });
  // Contrairement à renderForArticle (où l'absence de gabarit est un cas NORMAL — l'appelant garde
  // l'image brute), un contexte à saisie manuelle n'a AUCUN repli : sans gabarit publié, il n'y a
  // rien à produire. Message explicite pointant vers l'éditeur (caution du brief Tâche 14) plutôt
  // qu'un état vide silencieux — aucun des trois gabarits de départ (db/studio-templates.ts) ne
  // couvre quote_card / newsletter_header / recap_card, donc ce chemin est le cas COURANT tant que
  // personne n'a créé et publié un gabarit pour ce contexte.
  if (!template) {
    return {
      ok: false,
      message:
        "Aucun gabarit publié pour ce contexte. Créez-en un et publiez-le depuis Studio → Gabarits avant de générer.",
    };
  }

  try {
    const inputHash = computeInputHash({
      templateId: template.templateId, templateVersion: template.version, values: input.values,
    });

    // Même court-circuit que renderForArticle : deux générations identiques (même gabarit, même
    // version, mêmes valeurs saisies) renvoient la ligne déjà en cache plutôt que de re-rendre et de
    // re-téléverser un objet R2 strictement identique.
    const cached = await findCachedRender(inputHash);
    if (cached) return { ok: true, url: cached.url, renderId: cached.id, degraded: cached.degraded };

    const out = await renderScene({
      scene: template.scene, values: input.values, fetchImpl: input.fetchImpl,
      assets: input.assets ?? new DbAssetLoader(),
    });
    const key = storageKeyFor(inputHash, out.mime, new Date());
    const url = await store.put(key, out.bytes, out.mime);

    const saved = await saveRender({
      templateId: template.templateId,
      templateVersion: template.version,
      context: input.context,
      subjectType: "manual",
      subjectId: null,
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
    // Message français SANS détail natif, journalisé côté serveur — même politique que
    // renderForArticle et previewTemplateCore. Contrairement à renderForArticle (qui préfixe
    // « Génération de l'image échouée — », un déclenchement automatique/en arrière-plan où le
    // rédacteur a besoin d'un peu de mise en contexte), ceci reprend le message BRUT du moteur, sans
    // préfixe — comme previewTemplateCore : l'utilisateur vient de soumettre CE formulaire à
    // l'instant, le nom des jetons manquants (MissingTokensError) est déjà suffisamment situé sans
    // framing supplémentaire. C'est aussi « le message français du moteur » que le brief Tâche 14
    // demande littéralement pour le cas des valeurs manquantes.
    console.error(`[studio] renderManual échoué (contexte ${input.context}) :`, e);
    if (
      e instanceof MissingTokensError || e instanceof ImageFetchError ||
      e instanceof SceneError || e instanceof RenderError
    ) {
      return { ok: false, message: e.message };
    }
    return { ok: false, message: `Génération impossible : ${(e as Error).message}` };
  }
}
