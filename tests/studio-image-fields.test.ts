// tests/studio-image-fields.test.ts — Properties Pro P1, Tâche 4 : l'APERÇU (Montage) rend le même
// CSS de fond que l'EXPORT (satori, element.ts#imageNode).
//
// §0 de ce sous-projet (le défaut que cette tâche corrige) : `ImageContent` (layer-view.tsx) peignait
// un `<img objectFit={layer.fit}>` — un mécanisme de mise à l'échelle ENTIÈREMENT DIFFÉRENT de celui
// qu'utilise désormais le moteur d'export (Tâche 3, un `<div>` de fond `background-image` /
// `background-size` / `background-repeat` / `background-position`). Un designer qui règle `sizing`,
// `focal` ou `tile` dans le panneau de propriétés (Tâche 6, hors périmètre ici) verrait donc un
// aperçu qui MENT sur ce que l'export produit — exactement le défaut que ce fichier ferme.
//
// Modelé sur tests/studio-layer-view.test.ts : `installDom()` + `mount()` (harnais U0), un calque
// monté via `LayerView`, et une lecture du style RÉELLEMENT posé par React sur le DOM jsdom — jamais
// une inspection de props React.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import React from "react";
import { installDom, mount } from "./dom-harness";
import type { Layer } from "@/lib/studio/scene";
import { LayerView } from "@/components/studio/layer-view";

let teardownDom: () => void;
beforeAll(() => { teardownDom = installDom(); });
afterAll(() => { teardownDom(); });

const FRAME = { x: 0, y: 0, w: 200, h: 100 };
const SRC = "https://x.test/photo.png";

function imageLayer(overrides: Partial<Extract<Layer, { type: "image" }>> = {}): Layer {
  return {
    id: "img", name: "Image", visible: true, locked: false, frame: FRAME,
    type: "image", source: { kind: "url", url: SRC }, fit: "cover",
    ...overrides,
  } as Layer;
}

// Monte le calque via LayerView (le seul point d'entrée public de ce fichier — ImageContent lui-même
// n'est pas exporté, exactement comme TextContent/ShapeContent/QrContent) et renvoie le nœud
// `data-testid="image-content"` peint à l'intérieur. `firstElementChild` suffirait (comme le fait déjà
// tests/studio-layer-view.test.ts#paintedChildStyle) mais le sélecteur explicite documente le contrat
// que la Tâche 4 introduit : CE data-testid, posé par le brief, est désormais un point de couture
// stable pour tout futur test — pas un détail d'implémentation.
async function mountImageContent(layer: Layer): Promise<{ el: HTMLElement; unmount: () => void }> {
  const { container, unmount } = await mount(
    React.createElement(LayerView, { layer, frame: FRAME, rotation: 0, selected: false }),
  );
  const el = container.querySelector('[data-testid="image-content"]') as HTMLElement | null;
  if (!el) throw new Error("aucun [data-testid=\"image-content\"] peint pour ce calque");
  return { el, unmount };
}

describe("ImageContent — §0 : l'aperçu peint un <div> de fond, comme le moteur d'export (parité)", () => {
  it("sizing:\"tile\" (scale 1) : background-repeat: repeat, background-image posé — PAS un <img objectFit>", async () => {
    const layer = imageLayer({ sizing: "tile", tile: { scale: 1, axis: "both" } });
    const { el, unmount } = await mountImageContent(layer);

    expect(el.tagName).toBe("DIV");
    expect(el.style.backgroundRepeat).toBe("repeat");
    // jsdom NORMALISE `background-image` en citant l'URL (`url("…")`) même quand React lui passe une
    // chaîne non citée — comme `toBrowserColor` pour les couleurs (tests/studio-layer-view.test.ts),
    // on compare à ce que le NAVIGATEUR produit réellement plutôt qu'à la chaîne source.
    expect(el.style.backgroundImage).toBe(`url("${SRC}")`);
    // Le CHEMIN UNIQUE (Tâche 3, verdict soupape) : plus aucun <img> nulle part dans ce calque.
    expect(el.tagName).not.toBe("IMG");
    expect(el.querySelector("img")).toBeNull();

    unmount();
  });

  it("sizing:\"tile\", scale 1 : background-size: auto (taille intrinsèque, aucune lecture async nécessaire)", async () => {
    const layer = imageLayer({ sizing: "tile", tile: { scale: 1, axis: "x" } });
    const { el, unmount } = await mountImageContent(layer);

    expect(el.style.backgroundSize).toBe("auto");
    expect(el.style.backgroundRepeat).toBe("repeat-x");

    unmount();
  });

  it("sizing:\"cover\" : le CSS cover, la MÊME table que lib/studio/image-css.ts#imageCss", async () => {
    const layer = imageLayer({ sizing: "cover", focal: { x: 0.25, y: 0.75 } });
    const { el, unmount } = await mountImageContent(layer);

    expect(el.style.backgroundSize).toBe("cover");
    expect(el.style.backgroundRepeat).toBe("no-repeat");
    expect(el.style.backgroundPosition).toBe("25% 75%");

    unmount();
  });

  it("sizing:\"stretch\" : 100% 100%", async () => {
    const layer = imageLayer({ sizing: "stretch" });
    const { el, unmount } = await mountImageContent(layer);

    expect(el.style.backgroundSize).toBe("100% 100%");

    unmount();
  });

  it("sizing:\"custom\" : la taille explicite en pixels", async () => {
    const layer = imageLayer({ sizing: "custom", customSize: { w: 40, h: 30 } });
    const { el, unmount } = await mountImageContent(layer);

    expect(el.style.backgroundSize).toBe("40px 30px");

    unmount();
  });

  // §0 : un calque ÉCRIT AVANT cette tâche (aucun champ `sizing`/`focal`/`tile`/`customSize`, comme
  // tout gabarit existant en base) doit continuer à s'afficher ÉQUIVALEMMENT à avant — pas de
  // régression visible pour le designer qui n'a jamais ouvert le panneau de cadrage avancé (Tâche 6).
  // `fit:"cover"` retombe sur `sizing:"cover"` (imageCss.ts), `fit:"contain"` sur `sizing:"contain"` —
  // même repli que le moteur d'export (element.ts#imageNode), donc les DEUX chemins continuent de
  // s'accorder pour ce cas historique.
  describe("legacy : un calque qui ne porte QUE `fit` (aucun champ Tâche 2) reste équivalent à avant", () => {
    it("fit:\"cover\" → sizing implicite cover", async () => {
      const layer = imageLayer({ fit: "cover" });
      const { el, unmount } = await mountImageContent(layer);
      expect(el.style.backgroundSize).toBe("cover");
      expect(el.style.backgroundRepeat).toBe("no-repeat");
      expect(el.style.backgroundPosition).toBe("50% 50%");
      unmount();
    });

    it("fit:\"contain\" → sizing implicite contain", async () => {
      const layer = imageLayer({ fit: "contain" });
      const { el, unmount } = await mountImageContent(layer);
      expect(el.style.backgroundSize).toBe("contain");
      unmount();
    });
  });

  it("rayon et flou restent peints sur le même nœud (inchangé par le passage <img> → <div>)", async () => {
    const layer = imageLayer({ radius: 12, blur: 4 });
    const { el, unmount } = await mountImageContent(layer);

    expect(el.style.borderRadius).toBe("12px");
    expect(el.style.filter).toBe("blur(4px)");

    unmount();
  });

  it("source `slot` : toujours l'espace réservé, jamais de div de fond (hors périmètre de cette tâche)", async () => {
    const layer = imageLayer({ source: { kind: "slot", slot: "article.image" } });
    const { container, unmount } = await mount(
      React.createElement(LayerView, { layer, frame: FRAME, rotation: 0, selected: false }),
    );
    expect(container.querySelector('[data-testid="image-content"]')).toBeNull();
    expect(container.querySelector('[data-layer-id="img"]')!.textContent).toContain("article.image");
    unmount();
  });
});
