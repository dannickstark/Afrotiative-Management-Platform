import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import * as React from "react";
import { act } from "react";
import { installDom, mount, click } from "./dom-harness";
import type { StubIntersectionObserverInstance } from "./dom-harness";
import { previewCache } from "@/lib/studio/preview-cache";
import { parseScene, type Scene } from "@/lib/studio/scene";
import { FORMAT_KEYS } from "@/lib/studio/formats";
import type { PreservedView } from "@/lib/studio/studio-mode";

// tests/studio-render-mode-refresh.test.ts — revue finale du chantier « Rendu réel », Critique 1 :
// « Actualiser » (render-mode.tsx#refreshAll) ne relançait RIEN — ni `key` (fonction pure des props
// inchangées), ni `enabled`, ni le `nonce` privé de chaque instance de `usePreview` ne changeaient —
// et effaçait la pastille d'alerte sans jamais la reconstruire (`setOutcomes({})`, dont l'effet de
// report de proof-sheet.tsx ne se redéclenche que si `ready`/`overflow`/`lowRes` CHANGENT — rien ne
// les faisait changer puisqu'aucune tuile ne refetchait). La revue avait mesuré : calls=8 après le
// premier rendu, une pastille visible, puis calls=8 (INCHANGÉ) et pastille absente après le clic. Ce
// fichier reproduit cette mesure et pin le correctif : calls DOUBLE (un second rendu PAR tuile) et la
// pastille reste visible.
//
// Un VRAI DOM est nécessaire — IntersectionObserver pour la visibilité de chaque tuile de la planche
// (proof-sheet.tsx#ProofTile), et les effets réels de hooks/use-preview.ts (react-dom/server, utilisé
// par tests/studio-render-mode.test.ts, n'exécute AUCUN effet). previewTemplate est mocké (aucun
// réseau, aucune base), RESTAURÉ en `afterAll` — même recette que tests/studio-use-preview.test.ts et
// tests/studio-templates-gallery.test.ts : `mock.module` est un effet GLOBAL qui survivrait à ce
// fichier et fuirait vers les autres fichiers du même shard de la voie pure
// (scripts/test-fast.ts:PURE_FILES) sans cette restauration.
type Call = { format: string | undefined };
const calls: Call[] = [];

const realPreviewActions = await import("@/lib/actions/studio-preview-actions");

mock.module("@/lib/actions/studio-preview-actions", () => ({
  previewTemplate: async (input: { format?: string }) => {
    calls.push({ format: input.format });
    return {
      ok: true,
      dataUri: "data:image/png;base64,QUFB",
      degraded: false,
      overflowingLayerIds: ["title"], // TOUS les formats débordent — reproduit la mesure de la revue.
      lowResLayerIds: [] as string[],
    };
  },
}));

afterAll(() => {
  mock.module("@/lib/actions/studio-preview-actions", () => realPreviewActions);
});

const { RenderMode } = await import("@/components/studio/render-mode");
const { PREVIEW_DEBOUNCE_MS } = await import("@/hooks/use-preview");

function fixtureScene(): Scene {
  return parseScene({
    schemaVersion: 1,
    canvas: { width: 1080, height: 1350, background: "#101010" },
    layers: [
      {
        id: "title", name: "Titre", visible: true, locked: false,
        frame: { x: 40, y: 40, w: 1000, h: 100 },
        type: "text", content: "Titre de test",
        font: { family: "Noto Sans", size: 48, weight: 700 },
        color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
      },
    ],
  });
}

// Laisse le vrai chronomètre avancer de `ms`, à l'intérieur d'`act()` pour que toute mise à jour
// d'état déclenchée par un `setTimeout`/une promesse résolue pendant l'attente soit bien flushée —
// même idiome que tests/studio-use-preview.test.ts.
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

// Déclenche l'intersection de TOUTES les tuiles créées jusqu'ici — la planche en crée 8, une par
// format (proof-sheet.tsx#ProofTile), chacune son propre IntersectionObserver (gating de visibilité,
// conservé de l'ancien FilmstripThumb). Le stub de tests/dom-harness.ts ne déclenche jamais lui-même
// son callback (`.observe()` est un no-op délibéré) — c'est donc à l'appelant de simuler l'entrée
// dans le viewport, exactement comme tests/studio-templates-gallery.test.ts le fait pour GalleryThumb.
async function revealAllTiles(): Promise<void> {
  const Ctor = globalThis.IntersectionObserver as unknown as {
    instances: StubIntersectionObserverInstance[];
  };
  await act(async () => {
    for (const observer of Ctor.instances) {
      observer.callback([{ isIntersecting: true } as IntersectionObserverEntry], observer);
    }
  });
}

describe("RenderMode — « Actualiser » relance RÉELLEMENT les tuiles (revue finale, Critique 1)", () => {
  let teardownDom: () => void;

  beforeAll(() => {
    teardownDom = installDom();
  });
  afterAll(() => {
    teardownDom();
  });

  it("un clic sur Actualiser DOUBLE les appels réseau (un second rendu par tuile) et laisse la pastille d'alerte VISIBLE", async () => {
    calls.length = 0;
    previewCache.clear();
    const templateId = "test-render-mode-refresh";
    const view: PreservedView = { selectedId: null, zoom: "fit", scrollX: 0, scrollY: 0 };

    const { container, unmount } = await mount(React.createElement(RenderMode, {
      templateId, context: "article_image", scene: fixtureScene(), format: "ig_portrait",
      view, onViewChange: () => {},
    }));

    await revealAllTiles();
    await advance(PREVIEW_DEBOUNCE_MS + 50);

    // Base de référence, avant tout clic : les huit tuiles ont bien été rendues, et la pastille
    // d'agrégation (render-mode.tsx) est visible puisque le mock signale un débordement partout.
    expect(calls.length).toBe(FORMAT_KEYS.length);
    const badgeBefore = container.querySelector('[data-testid="render-warning-summary"]');
    expect(badgeBefore).not.toBeNull();
    expect(badgeBefore?.textContent).toContain("à vérifier");

    const refreshBtn = container.querySelector('[data-testid="render-refresh-all"]') as HTMLButtonElement;
    expect(refreshBtn).not.toBeNull();
    await click(refreshBtn);
    // `refresh()` (hooks/use-preview.ts) contourne le différé de 800 ms — la requête part quasi
    // immédiatement, comme un clic manuel ordinaire. Une marge large (100 ms, bien en-deçà des 800 ms
    // du chemin ordinaire) laisse les huit appels et leurs résolutions se stabiliser.
    await advance(100);

    // LE CŒUR DU CORRECTIF : sans lui, `calls.length` resterait à FORMAT_KEYS.length (rien n'était
    // relancé) — ce test rougit contre l'implémentation d'origine (voir le rapport final : vérifié en
    // le faisant échouer contre `refreshAll` non corrigé avant d'appliquer le correctif).
    expect(calls.length).toBe(FORMAT_KEYS.length * 2);

    // La pastille SURVIT : contrairement à l'ancien `setOutcomes({})`, qui la faisait disparaître
    // PERMANENTMENT (aucune tuile ne changeait `ready`/`overflow`/`lowRes`, donc rien ne redéclenchait
    // le report à `onTileOutcome`) — ici chaque tuile a réellement refetché et re-signalé son propre
    // débordement.
    const badgeAfter = container.querySelector('[data-testid="render-warning-summary"]');
    expect(badgeAfter).not.toBeNull();
    expect(badgeAfter?.textContent).toContain("à vérifier");

    unmount();
  });
});
