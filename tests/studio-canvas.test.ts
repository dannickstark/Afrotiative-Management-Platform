import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Scene } from "@/lib/studio/scene";
import { Canvas } from "@/components/studio/canvas";

// Pas de DOM dans `bun test` (voir tests/use-persisted-filters.test.ts) : on rend le composant en
// chaîne HTML via react-dom/server, ce qui ne nécessite ni `document` ni `window`, et on inspecte
// la sortie. Suffisant pour tout ce que ce fichier vérifie : structure, ordre, et attributs style
// sérialisés — react-dom sérialise bel et bien `style={{...}}` en `style="prop:val;..."` côté
// serveur, y compris pour des propriétés « unitless » comme lineClamp (vérifié empiriquement).

function render(scene: Scene, selectedId: string | null = null) {
  const noop = () => {};
  return renderToStaticMarkup(
    React.createElement(Canvas, { scene, selectedId, dispatch: noop, scale: 1 }),
  );
}

// Isole le HTML d'UN calque (de son `data-layer-id="…"` jusqu'au prochain, ou la fin) — un slice à
// largeur fixe déborderait sur le nœud suivant pour un calque au balisage court.
function layerNode(html: string, id: string): string {
  const start = html.indexOf(`data-layer-id="${id}"`);
  if (start === -1) throw new Error(`calque « ${id} » absent du HTML rendu`);
  const openStart = html.lastIndexOf("<div", start);
  const next = html.indexOf("data-layer-id=", start + 1);
  const end = next === -1 ? html.length : html.lastIndexOf("<div", next);
  return html.slice(openStart, end);
}

function makeScene(): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 800, height: 600, background: "#000000" },
    layers: [
      {
        id: "bg", name: "Fond", visible: true, locked: false,
        frame: { x: 0, y: 0, w: 800, h: 600 },
        type: "shape", shape: "rect", fill: "#111111",
      },
      {
        id: "title", name: "Titre", visible: true, locked: false,
        frame: { x: 40, y: 40, w: 400, h: 120 },
        type: "text", content: "Un long titre d'article",
        font: { family: "Noto Sans", size: 48, weight: 700 },
        color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
        maxLines: 3, letterSpacing: 2,
      },
      {
        id: "hidden", name: "Masqué", visible: false, locked: false,
        frame: { x: 10, y: 10, w: 50, h: 50 },
        type: "shape", shape: "rect", fill: "#FF00FF",
      },
      {
        id: "qr1", name: "QR", visible: true, locked: false,
        frame: { x: 600, y: 400, w: 120, h: 120 },
        type: "qr", slot: "article.url", fg: "#000000", bg: "#FFFFFF", margin: 4,
      },
    ],
  };
}

describe("Canvas — rendu de la scène", () => {
  it("rend un nœud par calque VISIBLE, dans l'ordre de peinture ; un calque invisible ne rend rien", () => {
    const html = render(makeScene());

    // Les trois calques visibles sont présents…
    for (const id of ["bg", "title", "qr1"]) {
      expect(html).toContain(`data-layer-id="${id}"`);
    }
    // …le calque invisible n'a laissé AUCUNE trace (ni son id, ni son fill distinctif).
    expect(html).not.toContain(`data-layer-id="hidden"`);
    expect(html).not.toContain("#FF00FF");

    // Ordre de peinture = ordre de scene.layers (bg d'abord, qr1 en dernier).
    const iBg = html.indexOf('data-layer-id="bg"');
    const iTitle = html.indexOf('data-layer-id="title"');
    const iQr = html.indexOf('data-layer-id="qr1"');
    expect(iBg).toBeGreaterThan(-1);
    expect(iTitle).toBeGreaterThan(iBg);
    expect(iQr).toBeGreaterThan(iTitle);
  });

  it("un calque masqué ne produit aucun nœud même seul dans la scène", () => {
    const scene = makeScene();
    scene.layers = [scene.layers[2]]; // uniquement le calque "hidden"
    const html = render(scene);
    expect(html).not.toContain("data-layer-id");
  });

  it("la scène vide rend un canevas sans aucun calque", () => {
    const scene = makeScene();
    scene.layers = [];
    const html = render(scene);
    expect(html).not.toContain("data-layer-id");
  });
});

describe("Canvas — style de texte via textStyleFor", () => {
  it("le style du calque texte vient de textStyleFor (lineClamp dérivé de maxLines)", () => {
    const html = render(makeScene());
    // `maxLines: 3` sur le calque "title" ; SEULE textStyleFor produit `lineClamp` (voir
    // lib/studio/element.ts). Si le composant redérivait son propre style au lieu d'appeler
    // textStyleFor, rien dans son code ne produirait cette chaîne précise.
    expect(html).toContain("line-clamp:3");
    // `letterSpacing: 2` — également une propriété propre à textStyleFor, avec unité px cette fois
    // (contrairement à lineClamp) : re-vérifie qu'on ne l'a pas oubliée, exactement le bug V1 que
    // l'extraction de textStyleFor a corrigé (voir le commentaire en tête de element.ts).
    expect(html).toContain("letter-spacing:2px");
  });

  it("un calque texte sans maxLines/letterSpacing ne produit ni lineClamp ni letterSpacing", () => {
    const scene = makeScene();
    scene.layers = [scene.layers[1]];
    (scene.layers[0] as { maxLines?: number }).maxLines = undefined;
    (scene.layers[0] as { letterSpacing?: number }).letterSpacing = undefined;
    const html = render(scene);
    expect(html).not.toContain("line-clamp");
    expect(html).not.toContain("letter-spacing");
  });
});

describe("Canvas — sélection et verrouillage", () => {
  it("marque le calque sélectionné et lui seul", () => {
    const html = render(makeScene(), "title");
    expect(layerNode(html, "title")).toContain('data-selected="true"');
    expect(layerNode(html, "bg")).not.toContain('data-selected="true"');
  });

  it("un calque verrouillé est marqué visuellement ET non-interactif (pointer-events: none)", () => {
    const scene = makeScene();
    scene.layers[0] = { ...scene.layers[0], locked: true } as typeof scene.layers[0];
    const html = render(scene);
    const bgNode = layerNode(html, "bg");
    expect(bgNode).toContain('data-locked="true"');
    expect(bgNode).toContain("pointer-events:none");
  });

  it("un calque non verrouillé ne porte pas pointer-events:none", () => {
    const html = render(makeScene());
    const bgNode = layerNode(html, "bg");
    expect(bgNode).not.toContain('data-locked="true"');
    expect(bgNode).not.toContain("pointer-events:none");
  });
});

describe("Canvas — image, forme, QR", () => {
  it("une image {{slot}} non résolue affiche un espace réservé explicite, jamais une balise <img> cassée", () => {
    const scene = makeScene();
    scene.layers.push({
      id: "img1", name: "Image", visible: true, locked: false,
      frame: { x: 0, y: 0, w: 100, h: 100 },
      type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover",
    });
    const html = render(scene);
    expect(html).not.toContain("<img");
    expect(html).toContain("article.image");
  });

  it("une image avec une URL littérale s'affiche directement", () => {
    const scene = makeScene();
    scene.layers.push({
      id: "img2", name: "Image", visible: true, locked: false,
      frame: { x: 0, y: 0, w: 100, h: 100 },
      type: "image", source: { kind: "url", url: "https://example.com/x.png" }, fit: "cover",
    });
    const html = render(scene);
    expect(html).toContain('src="https://example.com/x.png"');
  });

  it("une forme peint sa couleur de remplissage", () => {
    const html = render(makeScene());
    expect(html).toContain("#111111");
  });

  it("un calque QR se rend de façon représentative (pas de <img> sans image fournie)", () => {
    const html = render(makeScene());
    expect(layerNode(html, "qr1")).not.toContain("<img");
  });
});
