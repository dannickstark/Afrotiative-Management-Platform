import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import React from "react";
import { installDom, mount, pointer } from "./dom-harness";

// tests/studio-panel-resize-handle.test.ts — Chantier A Tâche 3 (spec §2/§3) : le câblage DOM réel
// de la poignée de glisser (components/studio/panel-resize-handle.tsx), via le harnais U0
// (tests/dom-harness.ts) — un VRAI `pointerdown`/`pointermove` DOM, pas un appel direct au handler
// React comme le ferait un test qui se contenterait d'introspecter les props. Même convention que
// tests/studio-interactions.test.ts (le seul autre test de glisser du dépôt) : composants dynamiquement
// importés APRÈS `installDom()`.
let teardownDom: () => void;
let PanelResizeHandle: typeof import("@/components/studio/panel-resize-handle").PanelResizeHandle;

beforeAll(async () => {
  teardownDom = installDom();
  ({ PanelResizeHandle } = await import("@/components/studio/panel-resize-handle"));
});

afterAll(() => {
  teardownDom();
});

describe("PanelResizeHandle — glisser réel via pointerdown/pointermove DOM (chantier A Tâche 3)", () => {
  it("sign=+1 (rail-panel↔canevas) : glisser vers la DROITE AGRANDIT le panneau, dans les bornes", async () => {
    const widths: number[] = [];
    const { container, unmount } = await mount(
      React.createElement(PanelResizeHandle, {
        currentWidth: 212, min: 180, max: 360, sign: 1,
        onResize: (w: number) => widths.push(w),
        label: "Redimensionner le panneau", testId: "rail-panel-resize-handle",
      }),
    );
    const handle = container.querySelector('[data-testid="rail-panel-resize-handle"]') as HTMLElement;
    expect(handle).not.toBeNull();

    await pointer(handle, "pointerdown", { clientX: 100, clientY: 0 });
    await pointer(handle, "pointermove", { clientX: 140, clientY: 0 }); // +40px vers la droite
    expect(widths.at(-1)).toBe(252); // 212 + 40

    await pointer(handle, "pointerup", { clientX: 140, clientY: 0 });
    unmount();
  });

  it("sign=-1 (canevas↔inspecteur) : glisser vers la DROITE RÉTRÉCIT le panneau (signe inversé)", async () => {
    const widths: number[] = [];
    const { container, unmount } = await mount(
      React.createElement(PanelResizeHandle, {
        currentWidth: 300, min: 240, max: 480, sign: -1,
        onResize: (w: number) => widths.push(w),
        label: "Redimensionner l'inspecteur", testId: "inspector-resize-handle",
      }),
    );
    const handle = container.querySelector('[data-testid="inspector-resize-handle"]') as HTMLElement;

    await pointer(handle, "pointerdown", { clientX: 100, clientY: 0 });
    await pointer(handle, "pointermove", { clientX: 140, clientY: 0 }); // +40px vers la droite
    expect(widths.at(-1)).toBe(260); // 300 - 40

    unmount();
  });

  // Mutation « drop the clamp » (brief, Étape 4) : un glisser qui dépasse largement les bornes ne
  // doit JAMAIS produire une largeur hors de [min, max] — sans l'appel à `clampPanelWidth` à chaque
  // `pointermove`, ce test rougirait (widths.at(-1) vaudrait 212 + 5000, pas 360).
  it("un glisser qui dépasse largement les bornes est RAMENÉ dans les bornes à chaque mouvement, jamais reçu tel quel", async () => {
    const widths: number[] = [];
    const { container, unmount } = await mount(
      React.createElement(PanelResizeHandle, {
        currentWidth: 212, min: 180, max: 360, sign: 1,
        onResize: (w: number) => widths.push(w),
        label: "Redimensionner le panneau", testId: "rail-panel-resize-handle",
      }),
    );
    const handle = container.querySelector('[data-testid="rail-panel-resize-handle"]') as HTMLElement;

    await pointer(handle, "pointerdown", { clientX: 0, clientY: 0 });
    await pointer(handle, "pointermove", { clientX: 5000, clientY: 0 }); // délire, bien au-delà de max
    expect(widths.at(-1)).toBe(360);

    await pointer(handle, "pointermove", { clientX: -9000, clientY: 0 }); // délire dans l'autre sens
    expect(widths.at(-1)).toBe(180);

    unmount();
  });

  it("aucun appel après pointerup — un pointermove tardif (écouteur déjà retiré) ne redimensionne plus rien", async () => {
    const widths: number[] = [];
    const { container, unmount } = await mount(
      React.createElement(PanelResizeHandle, {
        currentWidth: 212, min: 180, max: 360, sign: 1,
        onResize: (w: number) => widths.push(w),
        label: "Redimensionner le panneau", testId: "rail-panel-resize-handle",
      }),
    );
    const handle = container.querySelector('[data-testid="rail-panel-resize-handle"]') as HTMLElement;

    await pointer(handle, "pointerdown", { clientX: 0, clientY: 0 });
    await pointer(handle, "pointermove", { clientX: 20, clientY: 0 });
    await pointer(handle, "pointerup", { clientX: 20, clientY: 0 });
    const countAfterUp = widths.length;

    await pointer(handle, "pointermove", { clientX: 999, clientY: 0 }); // aucun écouteur natif ne reste posé
    expect(widths.length).toBe(countAfterUp);

    unmount();
  });
});
