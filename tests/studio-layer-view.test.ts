// tests/studio-layer-view.test.ts — U4 Tâche 3 : le canevas de l'éditeur peint une couleur liée à
// un JETON avec la MÊME valeur d'échantillon que l'export.
//
// §0 du plan U4 (le défaut que cette tâche corrige) : `components/studio/layer-view.tsx` peint la
// scène BRUTE — avant cette tâche, un `text.color = "{{category.color}}"` arrive tel quel jusqu'au
// style React, une chaîne CSS invalide que le navigateur ABANDONNE silencieusement (le texte
// s'affiche sans couleur, jamais une erreur). Ce fichier RENFORCE : la première moitié (« §0 ») est
// le test EXIGÉ par le plan, RED avant l'implémentation — voir task-3-report.md pour la capture de
// l'échec. La seconde moitié (« garde d'éditabilité ») prouve que la résolution reste D'AFFICHAGE
// SEULEMENT : `state.scene` — ici, la même référence d'objet que celle passée en prop — ne bouge
// JAMAIS, gelée en profondeur pour qu'une mutation en place lève une TypeError immédiate plutôt que
// de se découvrir seulement après coup.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import React from "react";
import { installDom, mount } from "./dom-harness";
import type { Layer, Scene } from "@/lib/studio/scene";
import { resolveTokens } from "@/lib/studio/values";
import { sceneToElement } from "@/lib/studio/element";
import { SAMPLE_VALUES } from "@/lib/studio/sample-values";
import { DEFAULT_CATEGORY_COLOR } from "@/lib/studio/default-category-color";
import { LayerView } from "@/components/studio/layer-view";
import { Canvas } from "@/components/studio/canvas";

let teardownDom: () => void;
beforeAll(() => { teardownDom = installDom(); });
afterAll(() => { teardownDom(); });

const FONT = { family: "Noto Sans", size: 32, weight: 400 };
const FRAME = { x: 0, y: 0, w: 200, h: 100 };

function textLayer(overrides: Partial<Extract<Layer, { type: "text" }>> = {}): Layer {
  return {
    id: "txt", name: "Titre", visible: true, locked: false, frame: FRAME,
    type: "text", content: "Bonjour", font: FONT,
    color: "#000000", align: "left", vAlign: "top", lineHeight: 1.2,
    ...overrides,
  };
}

function shapeLayer(overrides: Partial<Extract<Layer, { type: "shape" }>> = {}): Layer {
  return {
    id: "shp", name: "Forme", visible: true, locked: false, frame: FRAME,
    type: "shape", shape: "rect", fill: "#000000",
    ...overrides,
  };
}

function qrLayer(overrides: Partial<Extract<Layer, { type: "qr" }>> = {}): Layer {
  return {
    id: "qr", name: "QR", visible: true, locked: false, frame: FRAME,
    type: "qr", slot: "article.url", fg: "#000000", bg: "#FFFFFF", margin: 4,
    ...overrides,
  };
}

function sceneWith(layer: Layer, background = "#FFFFFF"): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 400, height: 300, background },
    layers: [layer],
  };
}

// Gèle la scène RÉCURSIVEMENT (même technique que tests/studio-values.test.ts, « ne mute jamais la
// scène d'entrée ») : si l'implémentation de la résolution d'affichage tentait de MUTER `layer` en
// place (au lieu de cloner comme `setColorAtPath` le garantit), le rendu lèverait une TypeError
// IMMÉDIATE plutôt que de laisser une corruption silencieuse se découvrir seulement en comparant
// avant/après.
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

// ── Chemin EXPORT : le style réellement remis à Satori, APRÈS resolveTokens(scene, SAMPLE_VALUES) —
// exactement ce que lib/studio/render.ts fait avant d'appeler sceneToElement. Pas besoin d'un rendu
// satori réel (coûteux, testé en pixels ailleurs — tests/studio-render.test.ts) : seul le STYLE
// produit compte ici, comme tests/studio-element.test.ts le fait déjà.
function exportedStyleOf(scene: Scene, layerId: string): Record<string, unknown> {
  const resolved = resolveTokens(scene, SAMPLE_VALUES);
  const root = sceneToElement(resolved, new Map());
  const children = (root.props as { children: { props: { "data-layer": string; style: Record<string, unknown> } }[] }).children;
  const node = children.find((c) => c.props["data-layer"] === layerId);
  if (!node) throw new Error(`calque « ${layerId} » absent de l'export (invisible, ou sans image préparée)`);
  return node.props.style;
}

// ── Chemin ÉDITEUR : lit une déclaration CSS RÉELLEMENT posée par React sur le DOM jsdom monté —
// jamais une inspection des props React (ce serait un raccourci qui contournerait exactement ce que
// ce fichier doit prouver : que le NAVIGATEUR reçoit une couleur valide).
function paintedChildStyle(container: HTMLElement, layerId: string): CSSStyleDeclaration {
  const wrapper = container.querySelector(`[data-layer-id="${layerId}"]`);
  if (!wrapper) throw new Error(`calque « ${layerId} » absent du DOM monté`);
  const child = wrapper.firstElementChild as HTMLElement | null;
  if (!child) throw new Error(`calque « ${layerId} » n'a peint aucun enfant`);
  return child.style;
}

// jsdom NORMALISE toute couleur CSS assignée à une déclaration de style (un hex devient
// `rgb(r, g, b)`) — donc comparer directement une chaîne hex à `element.style.color` échoue même
// quand les DEUX couleurs sont identiques. On normalise les DEUX côtés par le MÊME mécanisme jsdom
// plutôt que de coder en dur une table de conversion hex -> rgb : `toBrowserColor("#1B7F4A")`
// produit TOUJOURS la même chaîne que ce que React fait peindre pour ce même hex.
function toBrowserColor(value: string): string {
  const probe = document.createElement("div");
  probe.style.color = value;
  return probe.style.color;
}

describe("LayerView — §0 du plan U4 : une couleur liée rend la MÊME valeur d'échantillon dans l'éditeur et à l'export", () => {
  it("text.color = «{{category.color}}» : le navigateur peint DEFAULT_CATEGORY_COLOR, comme l'export", async () => {
    const layer = textLayer({ color: "{{category.color}}" });
    const scene = deepFreeze(sceneWith(layer));

    const exported = exportedStyleOf(scene, "txt");
    expect(exported.color).toBe(DEFAULT_CATEGORY_COLOR);

    const { container, unmount } = await mount(
      React.createElement(LayerView, { layer: scene.layers[0], frame: FRAME, rotation: 0, selected: false }),
    );
    const painted = paintedChildStyle(container, "txt").color;

    expect(painted).toBe(toBrowserColor(DEFAULT_CATEGORY_COLOR));
    expect(painted).toBe(toBrowserColor(exported.color as string));
    unmount();
  });
});

describe("LayerView — garde d'éditabilité : la résolution reste D'AFFICHAGE SEULEMENT", () => {
  it("après un paint, le champ lié porte TOUJOURS le jeton brut — state.scene n'a jamais bougé", async () => {
    const layer = textLayer({ color: "{{category.color}}" });
    const scene = deepFreeze(sceneWith(layer)); // gelé : une mutation en place lèverait ICI, pendant le rendu.

    const { unmount } = await mount(
      React.createElement(LayerView, { layer: scene.layers[0], frame: FRAME, rotation: 0, selected: false }),
    );

    // La MÊME référence que celle passée en prop — pas une resélection depuis un état séparé —
    // c'est `state.scene` lui-même dans un éditeur réel (voir components/studio/canvas.tsx, qui
    // passe scene.layers[i] tel quel à LayerView).
    expect((scene.layers[0] as Extract<Layer, { type: "text" }>).color).toBe("{{category.color}}");
    unmount();
  });

  // Une couche de preuve INDÉPENDANTE du gel : même sans lui, deux montages successifs du MÊME
  // calque doivent peindre la MÊME couleur d'échantillon — une mutation en place ferait dériver le
  // second montage du premier (le champ aurait déjà été écrasé par la substitution précédente).
  it("deux montages successifs du même calque peignent la MÊME couleur — aucune dérive entre les deux", async () => {
    const layer = textLayer({ color: "{{category.color}}" });
    const scene = sceneWith(layer);

    const first = await mount(
      React.createElement(LayerView, { layer: scene.layers[0], frame: FRAME, rotation: 0, selected: false }),
    );
    const firstColor = paintedChildStyle(first.container, "txt").color;
    first.unmount();

    const second = await mount(
      React.createElement(LayerView, { layer: scene.layers[0], frame: FRAME, rotation: 0, selected: false }),
    );
    const secondColor = paintedChildStyle(second.container, "txt").color;
    second.unmount();

    expect(firstColor).toBe(toBrowserColor(DEFAULT_CATEGORY_COLOR));
    expect(secondColor).toBe(firstColor);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// COUVERTURE — les autres types de calque (Étape 4 de la tâche : « pour tous les types de calque »),
// plus le fond du canevas (canvas.tsx:214).
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("LayerView — couverture par type de calque", () => {
  it("shape.fill = «{{category.color}}» : le navigateur peint la couleur d'échantillon, comme l'export (plus de hachures)", async () => {
    const layer = shapeLayer({ fill: "{{category.color}}" });
    const scene = sceneWith(layer);

    const exported = exportedStyleOf(scene, "shp");
    expect(exported.backgroundColor).toBe(DEFAULT_CATEGORY_COLOR);

    const { container, unmount } = await mount(
      React.createElement(LayerView, { layer: scene.layers[0], frame: FRAME, rotation: 0, selected: false }),
    );
    const painted = paintedChildStyle(container, "shp").backgroundColor;
    expect(painted).toBe(toBrowserColor(DEFAULT_CATEGORY_COLOR));
    unmount();
  });

  it("qr.fg / qr.bg liés à des jetons : le navigateur peint les couleurs d'échantillon", async () => {
    const layer = qrLayer({ fg: "{{category.color}}", bg: "{{category.color}}" });
    const scene = sceneWith(layer);

    const { container, unmount } = await mount(
      React.createElement(LayerView, { layer: scene.layers[0], frame: FRAME, rotation: 0, selected: false }),
    );
    const style = paintedChildStyle(container, "qr");
    expect(style.color).toBe(toBrowserColor(DEFAULT_CATEGORY_COLOR));
    expect(style.backgroundColor).toBe(toBrowserColor(DEFAULT_CATEGORY_COLOR));
    unmount();
  });

  it("un calque IMAGE à jeton garde son espace réservé — la résolution ne touche PAS la source (hors périmètre)", async () => {
    const layer: Layer = {
      id: "img", name: "Image", visible: true, locked: false, frame: FRAME,
      type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover",
    };
    const scene = sceneWith(layer);

    const { container, unmount } = await mount(
      React.createElement(LayerView, { layer: scene.layers[0], frame: FRAME, rotation: 0, selected: false }),
    );
    // Toujours PAS de <img> : le slot n'a jamais de valeur dans l'éditeur (spec §2), résolution de
    // couleur ou pas — c'est une dimension entièrement différente (colorFieldsOf ne connaît pas `source`).
    expect(container.querySelector(`[data-layer-id="img"] img`)).toBeNull();
    expect(container.querySelector(`[data-layer-id="img"]`)!.textContent).toContain("article.image");
    unmount();
  });

  it("canvas.background = «{{category.color}}» : le navigateur peint la couleur d'échantillon, comme l'export", async () => {
    const layer = shapeLayer({ id: "bg-shape", fill: "#111111" });
    const scene = sceneWith(layer, "{{category.color}}");

    const resolved = resolveTokens(scene, SAMPLE_VALUES);
    const exportedRoot = sceneToElement(resolved, new Map());
    const exportedBackground = (exportedRoot.props as { style: Record<string, unknown> }).style.backgroundColor;
    expect(exportedBackground).toBe(DEFAULT_CATEGORY_COLOR);

    const { container, unmount } = await mount(
      React.createElement(Canvas, { scene, selectedIds: [], dispatch: () => {}, scale: 1 }),
    );
    const inner = container.querySelector('[data-testid="studio-canvas"] > div') as HTMLElement | null;
    if (!inner) throw new Error("conteneur mis à l'échelle du canevas absent du DOM monté");
    expect(inner.style.backgroundColor).toBe(toBrowserColor(DEFAULT_CATEGORY_COLOR));
    expect(inner.style.backgroundColor).toBe(toBrowserColor(exportedBackground as string));

    // Garde d'éditabilité : le fond BRUT de la scène n'a pas bougé non plus.
    expect(scene.canvas.background).toBe("{{category.color}}");
    unmount();
  });
});
