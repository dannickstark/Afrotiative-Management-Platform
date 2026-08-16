// lib/studio/preview-cache.ts — le mémo CLIENT de l'aperçu (refonte « Rendu réel », spec §4).
//
// Pourquoi ce fichier existe : previewTemplate() n'est jamais gratuit — chaque appel est un VRAI
// rendu satori/resvg/sharp, et AUCUN cache serveur ne l'absorbe (previewTemplateCore appelle
// renderScene directement, jamais renderForArticle ; voir la garantie structurelle de
// tests/studio-preview.test.ts). Avant ce cache, entrer en Rendu réel coûtait jusqu'à huit rendus,
// refaits À CHAQUE aller-retour de mode.
//
// PORTÉE MODULE, délibérément : c'est ce qui fait survivre la mémo au DÉMONTAGE de RenderMode
// (quand `mode` repasse à "montage", editor-shell.tsx démonte tout l'arbre). Un `useRef` ou un
// contexte React mourraient avec lui et ne résoudraient donc pas le problème visé.
//
// PUR : aucun accès à `window`/DOM, aucun import React — même discipline que lib/studio/editor-prefs.ts
// et lib/studio/studio-mode.ts. C'est ce qui le rend testable dans la voie parallèle.
import type { Scene } from "./scene";
import type { FormatKey } from "./formats";

export type CachedPreview = {
  dataUri: string;
  degraded: boolean;
  overflowingLayerIds: string[];
  lowResLayerIds: string[];
};

// FNV-1a 32 bits sur la sérialisation de la scène. Un hachage 32 bits COLLISIONNE (et une collision
// ici afficherait la mauvaise image, pas seulement un cache raté), donc la clé ne se réduit JAMAIS
// au seul hachage : elle porte AUSSI la longueur de la sérialisation. Deux scènes distinctes
// doivent alors collisionner sur le hachage ET faire exactement la même longueur d'octets pour se
// confondre — un régime bien plus sûr, pour un coût nul.
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export function previewCacheKey(
  templateId: string,
  scene: Scene,
  format: FormatKey | undefined,
  articleId: string | null | undefined,
): string {
  const serialized = JSON.stringify(scene);
  // `articleId` : `undefined` et `null` désignent tous deux « valeurs d'exemple » côté
  // previewTemplate — ils DOIVENT donc produire la même clé, sans quoi le même rendu serait calculé
  // deux fois selon la façon dont l'appelant a exprimé « aucun article ».
  return [
    templateId,
    format ?? "-",
    articleId ?? "-",
    serialized.length,
    fnv1a(serialized),
  ].join("|");
}

// Estimation des octets réels derrière une data-URI base64 : 4 caractères encodent 3 octets.
// Approximatif (l'en-tête « data:image/png;base64, » et le remplissage `=` ne sont pas défalqués),
// mais c'est un BUDGET, pas une comptabilité — une erreur de quelques pourcents est sans effet.
function estimateBytes(v: CachedPreview): number {
  return Math.ceil(v.dataUri.length * 0.75);
}

export interface PreviewCache {
  get(key: string): CachedPreview | undefined;
  set(key: string, value: CachedPreview): void;
  delete(key: string): void;
  clear(): void;
  /** Total estimé actuellement retenu, en octets. */
  bytes(): number;
  /** Clés dans l'ordre LRU, de la plus ancienne à la plus récente. */
  keys(): string[];
}

// Bornée en OCTETS et non en entrées : un PNG 1080×1920 en data-URI pèse 1 à 2 Mo, quand une
// vignette 1200×630 en pèse une fraction. Un plafond exprimé en NOMBRE d'entrées retiendrait donc,
// selon les formats consultés, entre quelques mégaoctets et plusieurs centaines — un budget qui ne
// veut rien dire. `Map` conserve l'ordre d'insertion : un `delete` suivi d'un `set` suffit à
// remettre une clé en tête de récence, sans structure chaînée séparée.
export function createPreviewCache(maxBytes: number): PreviewCache {
  const map = new Map<string, CachedPreview>();
  let total = 0;

  function drop(key: string): void {
    const existing = map.get(key);
    if (existing === undefined) return;
    total -= estimateBytes(existing);
    map.delete(key);
  }

  return {
    get(key) {
      const hit = map.get(key);
      if (hit === undefined) return undefined;
      map.delete(key);
      map.set(key, hit); // rafraîchit la récence — c'est ce qui en fait une LRU et non une FIFO.
      return hit;
    },
    set(key, value) {
      drop(key); // réécriture : on retire l'ancien poids avant d'ajouter le nouveau, jamais les deux.
      const size = estimateBytes(value);
      // Une entrée plus grosse à elle seule que le budget ne peut pas y tenir : la mettre en cache
      // reviendrait à vider tout le reste ET à dépasser quand même. On la laisse simplement passer
      // sans la retenir — l'appelant l'affiche, elle n'est juste pas mémoïsée.
      if (size > maxBytes) return;
      map.set(key, value);
      total += size;
      while (total > maxBytes) {
        const oldest = map.keys().next();
        if (oldest.done === true) break;
        drop(oldest.value);
      }
    },
    delete: drop,
    clear() { map.clear(); total = 0; },
    bytes: () => total,
    keys: () => [...map.keys()],
  };
}

export const PREVIEW_CACHE_MAX_BYTES = 48 * 1024 * 1024;

// L'instance PARTAGÉE. Voir l'en-tête du fichier : c'est sa portée module qui porte toute la valeur.
export const previewCache = createPreviewCache(PREVIEW_CACHE_MAX_BYTES);
