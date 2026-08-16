import { describe, it, expect, mock, beforeAll, beforeEach, afterAll } from "bun:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { installDom, mount, click, flush } from "./dom-harness";
import { previewCache, previewCacheKey, type CachedPreview } from "@/lib/studio/preview-cache";
import type { Scene } from "@/lib/studio/scene";

// tests/studio-use-preview.test.ts — revue de la Tâche 3 (chantier « Rendu réel »). Deux défauts
// introduits par l'EXTRACTION de hooks/use-preview.ts (aucun des deux n'existait dans
// components/studio/preview-pane.tsx d'avant), couverts ici avec un VRAI DOM (tests/dom-harness.ts)
// et la Server Action `previewTemplate` mockée (aucun réseau, aucune base) :
//
//   1. CRITIQUE — le chemin cache-hit de l'effet (`if (hit) { setState(...); return; }`) ne
//      bumpait pas `requestIdRef`, donc une requête encore en vol pour une clé DÉPASSÉE pouvait
//      atterrir APRÈS un hit de cache plus récent et écraser la bonne image avec la mauvaise.
//   2. IMPORTANT — `refresh()` ne faisait que purger le cache et faire basculer `nonce` : la
//      requête réelle repassait par le MÊME différé de 800 ms que le chemin ordinaire, imposant à
//      un clic « Actualiser » — le cas où l'utilisateur a justement déjà choisi d'attendre — une
//      attente qu'il n'avait jamais eue avant l'extraction.
//
// PAS dans PURE_FILES malgré le nom de fichier « studio-… » : ce fichier a besoin d'un DOM
// (installDom()) mais JAMAIS de base de données ni de réseau (previewTemplate est entièrement
// mocké) — il appartient donc à la voie parallèle rapide (scripts/test-fast.ts:PURE_FILES).

// ─────────────────────────────────────────────────────────────────────────────
// Mock de la Server Action AVANT tout import de hooks/use-preview.ts (même recette que
// tests/studio-templates-gallery.test.ts#GalleryThumb pour renderTemplateThumbnail) : chaque appel
// est capturé dans `pending` SANS être résolu — c'est le test qui décide QUAND (et dans quel ordre)
// chaque promesse se dénoue, pour reproduire une réponse lente arrivée en second.
//
// RESTAURÉ en `afterAll` (même recette que tests/studio-templates-gallery.test.ts, lignes 51-53 et
// 320-321) : `mock.module` est un effet GLOBAL, pas scopé à ce fichier — scripts/test-fast.ts
// regroupe plusieurs fichiers de la voie pure dans le MÊME process `bun test` (fragmentation en
// shards). Un mock jamais restauré survivrait donc à ce fichier et serait vu par tout autre fichier
// du même shard qui atteint la même Server Action (directement, ou via usePreview/PreviewPane) —
// notamment tests/studio-render-mode.test.ts et tests/studio-no-r2.test.ts. Sans restauration, l'un
// ou l'autre recevrait ce stub qui ne se résout JAMAIS au lieu de la vraie action, selon la
// composition du shard — un échec intermittent, différent d'une machine à l'autre, pour une raison
// n'ayant rien à voir avec le fichier qui échoue.
type PendingCall = { input: unknown; resolve: (result: unknown) => void };
const pending: PendingCall[] = [];

const realPreviewActions = await import("@/lib/actions/studio-preview-actions");

mock.module("@/lib/actions/studio-preview-actions", () => ({
  previewTemplate: (input: unknown) =>
    new Promise((resolve) => {
      pending.push({ input, resolve });
    }),
}));

afterAll(() => {
  mock.module("@/lib/actions/studio-preview-actions", () => realPreviewActions);
});

const { usePreview, PREVIEW_DEBOUNCE_MS } = await import("@/hooks/use-preview");

function okResult(dataUri: string) {
  return { ok: true, dataUri, degraded: false, overflowingLayerIds: [] as string[], lowResLayerIds: [] as string[] };
}

function scene(width: number): Scene {
  return {
    schemaVersion: 1,
    canvas: { width, height: 100, background: "#000000" },
    layers: [],
  };
}

function cachedEntry(dataUri: string): CachedPreview {
  return { dataUri, degraded: false, overflowingLayerIds: [], lowResLayerIds: [] };
}

// Composant-sonde minimal : rend l'état ET la fonction `refresh` du hook sous des `data-testid`
// interrogeables, sans rien réimplémenter du hook lui-même — même idiome que ViewHarness dans
// tests/studio-templates-gallery.test.ts (« teste le HOOK RÉEL, pas une réimplémentation »).
function Harness(props: { templateId: string; scene: Scene; articleId?: string | null }) {
  const { state, refresh } = usePreview(props);
  return React.createElement(
    "div",
    null,
    React.createElement("span", { "data-testid": "status" }, state.status),
    React.createElement("span", { "data-testid": "datauri" }, state.status === "ready" ? state.dataUri : ""),
    React.createElement("button", { "data-testid": "refresh-btn", onClick: refresh }),
  );
}

// Laisse le vrai chronomètre avancer de `ms`, à l'intérieur d'`act()` pour que toute mise à jour
// d'état déclenchée par un `setTimeout`/une promesse résolue pendant l'attente soit bien flushée
// avant que l'assertion suivante ne lise le DOM.
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe("usePreview (hooks/use-preview.ts) — revue Tâche 3", () => {
  let teardownDom: () => void;

  beforeAll(() => {
    teardownDom = installDom();
  });
  afterAll(() => {
    teardownDom();
  });
  beforeEach(() => {
    pending.length = 0;
    previewCache.clear();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // CRITIQUE : le hit de cache pour une clé NEUVE doit invalider toute requête encore en vol pour
  // la clé PRÉCÉDENTE, faute de quoi sa réponse — arrivée en second, après le hit synchrone —
  // écraserait l'image correcte avec celle d'un AUTRE format/scène.
  it("une réponse lente pour une clé dépassée n'écrase PAS un résultat déjà peint par un hit de cache plus récent", async () => {
    const templateId = "test-use-preview-stale-guard";
    const sceneA = scene(100);
    const sceneB = scene(200);
    const keyB = previewCacheKey(templateId, sceneB, undefined, null);
    const cachedB = cachedEntry("data:image/jpeg;base64,B");

    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(Harness, { templateId, scene: sceneA, articleId: null }));
    });

    // Laisse le différé de sceneA s'écouler intégralement : la requête part réellement (capturée
    // dans `pending`, SANS être résolue — elle reste « en vol »).
    await advance(PREVIEW_DEBOUNCE_MS + 50);
    expect(pending.length).toBe(1);
    const callA = pending[0]!;

    // Le cache contient déjà une entrée pour sceneB — simule un rendu déjà consulté ailleurs
    // (aller-retour de mode, vignette du filmstrip déjà rendue…).
    previewCache.set(keyB, cachedB);

    // Bascule vers sceneB : la dérivation d'état PENDANT le rendu peint immédiatement depuis le
    // cache, puis l'effet qui suit doit invalider la requête A encore en vol.
    await act(async () => {
      root.render(React.createElement(Harness, { templateId, scene: sceneB, articleId: null }));
    });
    expect(container.querySelector('[data-testid="datauri"]')?.textContent).toBe(cachedB.dataUri);
    // Aucun second appel réseau : c'était bien un hit de cache, pas un nouveau rendu déclenché.
    expect(pending.length).toBe(1);

    // La réponse LENTE de A arrive maintenant, après coup. Sans la garde bumpée par le hit de
    // cache, `id !== requestIdRef.current` serait FAUX ici et cette réponse écraserait B.
    await act(async () => {
      callA.resolve(okResult("data:image/jpeg;base64,A"));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe("ready");
    expect(container.querySelector('[data-testid="datauri"]')?.textContent).toBe(cachedB.dataUri); // toujours B, jamais A.

    act(() => root.unmount());
  });

  // ───────────────────────────────────────────────────────────────────────────
  // IMPORTANT : un clic sur « Actualiser » doit partir SANS attendre le différé de 800 ms — c'est
  // le cas même où l'utilisateur vient de décider d'attendre. Le chemin ORDINAIRE (scène/article qui
  // change tout seul), lui, doit continuer d'attendre le différé complet — sinon chaque frappe
  // déclencherait un aller-retour réseau immédiat, exactement ce que le différé existe pour éviter.
  describe("refresh() contourne le différé, le chemin ordinaire ne le fait pas", () => {
    it("refresh() : la requête part quasi immédiatement, bien avant les 800 ms du différé", async () => {
      const templateId = "test-use-preview-refresh-immediate";
      const s = scene(300);
      const key = previewCacheKey(templateId, s, undefined, null);
      previewCache.set(key, cachedEntry("data:image/jpeg;base64,INIT"));

      const { container, unmount } = await mount(React.createElement(Harness, { templateId, scene: s, articleId: null }));
      // Hit de cache au montage : aucun appel réseau, état déjà « ready ».
      expect(pending.length).toBe(0);
      expect(container.querySelector('[data-testid="status"]')?.textContent).toBe("ready");

      await click(container.querySelector('[data-testid="refresh-btn"]')!);
      // Bien avant le différé complet (800 ms) : la requête doit déjà être partie.
      await advance(50);
      expect(pending.length).toBe(1);

      unmount();
    });

    it("un changement de scène ORDINAIRE (pas via refresh) attend le différé complet avant de partir", async () => {
      const templateId = "test-use-preview-ordinary-debounce";
      const sceneX = scene(400);
      const sceneY = scene(500);

      const container = document.createElement("div");
      const root = createRoot(container);
      await act(async () => {
        root.render(React.createElement(Harness, { templateId, scene: sceneX, articleId: null }));
      });
      // Laisse le premier différé (sceneX, cache vide) s'écouler pour établir une base de référence.
      await advance(PREVIEW_DEBOUNCE_MS + 50);
      const baseline = pending.length;
      expect(baseline).toBe(1);

      await act(async () => {
        root.render(React.createElement(Harness, { templateId, scene: sceneY, articleId: null }));
      });

      // Juste après le changement de scène, bien avant les 800 ms : AUCUNE nouvelle requête.
      await advance(50);
      expect(pending.length).toBe(baseline);

      // Le différé s'écoule ensuite : la requête part alors, pas avant.
      await advance(PREVIEW_DEBOUNCE_MS);
      expect(pending.length).toBe(baseline + 1);

      act(() => root.unmount());
    });
  });
});
