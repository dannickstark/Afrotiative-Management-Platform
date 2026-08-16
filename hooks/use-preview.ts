"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { previewTemplate } from "@/lib/actions/studio-preview-actions";
import { previewCache, previewCacheKey, type CachedPreview } from "@/lib/studio/preview-cache";
import type { Scene } from "@/lib/studio/scene";
import type { FormatKey } from "@/lib/studio/formats";

// hooks/use-preview.ts — le cœur SANS UI de l'aperçu réel, extrait de components/studio/preview-pane.tsx
// lors de la refonte du mode « Rendu réel ».
//
// Pourquoi l'extraction : avant elle, il existait DEUX chemins de rendu — le <PreviewPane> complet
// (différé, garde anti-périmé, sélecteur d'article) et l'appel previewTemplate() écrit à la main
// dans les vignettes du filmstrip, sans cache et sans le même différé. Deux chemins pour une seule
// question, qui pouvaient diverger. Il n'en reste qu'un.
//
// Différé 800 ms après stabilisation, exactement comme avant : l'aperçu n'écrit rien côté serveur,
// un différé plus court que l'autosauvegarde (1500 ms) n'a donc pas le même coût. Et la scène
// ENVOYÉE est toujours celle des props — jamais le brouillon en base, qui peut avoir ~700 ms de
// retard (voir le correctif « Critique 1, revue Lot 2 » documenté dans preview-pane.tsx).
export const PREVIEW_DEBOUNCE_MS = 800;

export type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; dataUri: string; degraded: boolean; overflow: boolean; lowRes: boolean }
  | { status: "error"; message: string };

function readyFrom(v: CachedPreview): PreviewState {
  return {
    status: "ready",
    dataUri: v.dataUri,
    degraded: v.degraded,
    overflow: v.overflowingLayerIds.length > 0,
    lowRes: v.lowResLayerIds.length > 0,
  };
}

export interface UsePreviewInput {
  templateId: string;
  scene: Scene;
  /** Fait calculer `overflowingLayerIds` côté serveur pour CE format (voir PreviewTemplateInput.format). */
  format?: FormatKey;
  /** `null`/`undefined` = valeurs d'exemple. Les deux produisent la même clé de cache. */
  articleId?: string | null;
  /** `false` : aucun appel réseau, aucune transition d'état. Porte à la fois la lecture seule
   *  (stockage R2 absent) et le gating de visibilité des tuiles de la planche. Défaut : `true`. */
  enabled?: boolean;
}

export function usePreview(input: UsePreviewInput): { state: PreviewState; refresh: () => void } {
  const { templateId, scene, format, articleId, enabled = true } = input;
  const key = previewCacheKey(templateId, scene, format, articleId);

  // Un succès de cache doit être visible DÈS LE PREMIER RENDU sous la nouvelle clé — sinon revenir
  // de l'inspection vers la planche, ou faire un aller-retour Montage⇄Rendu, ferait clignoter huit
  // squelettes pour des images déjà en mémoire. D'où l'ajustement d'état PENDANT le rendu (patron
  // documenté par React pour « dériver un état d'un changement de props ») plutôt qu'un effet, qui
  // ne s'exécuterait qu'après une première peinture vide.
  const [renderedKey, setRenderedKey] = useState(key);
  const [state, setState] = useState<PreviewState>(() => {
    const hit = previewCache.get(key);
    return hit ? readyFrom(hit) : { status: "idle" };
  });
  if (key !== renderedKey) {
    setRenderedKey(key);
    const hit = previewCache.get(key);
    setState(hit ? readyFrom(hit) : { status: "loading" });
  }

  const requestIdRef = useRef(0);
  const [nonce, setNonce] = useState(0);

  // « Actualiser » : purge l'entrée de CETTE clé puis relance. Utile pour le seul cas qu'un hachage
  // de scène ne peut pas voir — une image source modifiée à distance, dont l'URL n'a pas changé.
  const keyRef = useRef(key);
  keyRef.current = key;
  const refresh = useCallback(() => {
    previewCache.delete(keyRef.current);
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const hit = previewCache.get(key);
    if (hit) { setState(readyFrom(hit)); return; }

    const id = ++requestIdRef.current;
    setState({ status: "loading" });
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await previewTemplate({
            templateId, scene, format, articleId: articleId ?? undefined,
          });
          // Garde anti-périmé : une requête plus récente est repartie entre-temps, sa réponse ne
          // doit pas être écrasée par celle-ci, arrivée en second à cause de la latence.
          if (id !== requestIdRef.current) return;
          if (res.ok) {
            const value: CachedPreview = {
              dataUri: res.dataUri, degraded: res.degraded,
              overflowingLayerIds: res.overflowingLayerIds, lowResLayerIds: res.lowResLayerIds,
            };
            previewCache.set(key, value);
            setState(readyFrom(value));
          } else {
            setState({ status: "error", message: res.message });
          }
        } catch (e) {
          if (id !== requestIdRef.current) return;
          setState({ status: "error", message: e instanceof Error ? e.message : "Aperçu impossible." });
        }
      })();
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `scene`/`templateId`/`format`/`articleId` sont TOUS déjà encodés dans `key` (par contenu, pas
    // par identité d'objet) — les lister en plus ferait re-déclencher l'effet à chaque nouveau rendu
    // du parent, puisque `sceneForFormat` renvoie un objet neuf à chaque appel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, nonce]);

  return { state, refresh };
}
