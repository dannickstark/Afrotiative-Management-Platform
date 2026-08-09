import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Scene, Layer } from "@/lib/studio/scene";
import { editorReducer, initEditorState, reorderLayer, type EditorAction } from "@/lib/studio/editor-state";
import { LayerPanel, layersTopFirst, nextIndexForMove } from "@/components/studio/layer-panel";

// Même convention que tests/studio-canvas.test.ts et tests/studio-drag.test.ts : pas de DOM dans
// `bun test`, donc pas de simulation de clic. La partie STRUCTURELLE (ordre affiché) se vérifie en
// rendant le composant en chaîne HTML (react-dom/server) ; la partie COMPORTEMENTALE (« déplacer
// vers le bas réordonne bien ») se vérifie en composant la fonction pure qui calcule l'index cible
// — la MÊME que le bouton "descendre" du composant appelle — avec le vrai réducteur (Tâche 4).

function makeScene(): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 800, height: 600, background: "#000000" },
    layers: [
      {
        id: "a", name: "Fond A", visible: true, locked: false,
        frame: { x: 0, y: 0, w: 800, h: 600 },
        type: "shape", shape: "rect", fill: "#111111",
      },
      {
        id: "b", name: "Milieu B", visible: true, locked: false,
        frame: { x: 10, y: 10, w: 100, h: 100 },
        type: "shape", shape: "rect", fill: "#222222",
      },
      {
        id: "c", name: "Dessus C", visible: false, locked: true,
        frame: { x: 20, y: 20, w: 50, h: 50 },
        type: "shape", shape: "rect", fill: "#333333",
      },
    ],
  };
}

function render(scene: Scene, selectedId: string | null = null) {
  const noop = () => {};
  return renderToStaticMarkup(
    React.createElement(LayerPanel, { scene, selectedId, dispatch: noop }),
  );
}

// Repère le bouton `disabled=""` (attribut booléen RÉEL, tel que sérialisé par react-dom/server) —
// PAS une sous-chaîne "disabled" quelconque : les classes Tailwind des boutons (buttonVariants)
// contiennent `disabled:pointer-events-none disabled:opacity-50` sur CHAQUE bouton, verrouillé ou
// non, ce qui ferait faussement "matcher" un test moins précis quel que soit l'état réel. Isole
// d'abord la balise `<button …>` ENTIÈRE portant `data-action="…"` (Base UI (@base-ui/react/button)
// réordonne ses props internes AVANT celles passées par l'appelant, donc `disabled=""` peut
// apparaître avant OU après `data-action="…"` selon le composant — chercher juste après serait
// fragile) puis cherche `disabled=""` n'importe où DANS cette balise.
function isDisabled(rowHtml: string, action: string): boolean {
  const marker = `data-action="${action}"`;
  const markerStart = rowHtml.indexOf(marker);
  if (markerStart === -1) throw new Error(`action « ${action} » absente du HTML fourni`);
  const tagStart = rowHtml.lastIndexOf("<", markerStart);
  const tagEnd = rowHtml.indexOf(">", markerStart);
  const tag = rowHtml.slice(tagStart, tagEnd + 1);
  return / disabled=""/.test(tag);
}

function rowOrder(html: string): string[] {
  const ids: string[] = [];
  const re = /data-layer-row-id="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) ids.push(m[1]);
  return ids;
}

describe("layersTopFirst — la fonction pure d'ordre d'affichage", () => {
  it("est l'inverse EXACT (par id) de scene.layers", () => {
    const scene = makeScene();
    const ids = layersTopFirst(scene.layers).map((l) => l.id);
    expect(ids).toEqual(["c", "b", "a"]);
    // Pas seulement la longueur — le piège explicite du brief : vérifier les ids, pas juste le
    // compte (un simple .slice() sans .reverse() aurait la même longueur mais le mauvais ordre).
    expect(ids).not.toEqual(scene.layers.map((l) => l.id));
  });

  it("une scène à un seul calque est son propre inverse (regression triviale, pas un faux positif de longueur)", () => {
    const scene = makeScene();
    scene.layers = [scene.layers[0]];
    expect(layersTopFirst(scene.layers).map((l) => l.id)).toEqual(["a"]);
  });
});

describe("LayerPanel — ordre affiché (rendu réel)", () => {
  it("affiche les calques dans l'ordre INVERSE de scene.layers", () => {
    const html = render(makeScene());
    expect(rowOrder(html)).toEqual(["c", "b", "a"]);
  });

  it("un calque en tête de panneau reste en tête même s'il est masqué/verrouillé", () => {
    // "c" est invisible ET locked dans la scène de test — le panneau doit quand même le lister
    // (contrairement au canevas, qui n'affiche que les calques visibles) : c'est justement l'outil
    // pour reprendre la main sur un calque masqué ou verrouillé.
    const html = render(makeScene());
    expect(html).toContain('data-layer-row-id="c"');
    expect(rowOrder(html)[0]).toBe("c");
  });
});

describe("nextIndexForMove — la fonction pure derrière les boutons monter/descendre", () => {
  it("« descendre » un calque de scene.layers[2] vise l'index 1", () => {
    expect(nextIndexForMove(2, "down")).toBe(1);
  });
  it("« monter » un calque de scene.layers[0] vise l'index 1", () => {
    expect(nextIndexForMove(0, "up")).toBe(1);
  });
});

describe("Descendre le calque du HAUT du panneau réordonne bien le tableau sous-jacent", () => {
  it("scene.layers passe de [a,b,c] à [a,c,b] — vérifié par ID, pas par longueur", () => {
    const scene = makeScene();
    let state = initEditorState(scene);
    const dispatch = (action: EditorAction) => { state = editorReducer(state, action); };

    // "c" est en tête du panneau (dernier de scene.layers, index 2) — exactement le calque que le
    // brief désigne comme piège. Le bouton "descendre" du composant appellerait
    // dispatch(reorderLayer("c", nextIndexForMove(2, "down"))).
    const topId = layersTopFirst(state.scene.layers)[0].id;
    expect(topId).toBe("c");
    const topIndex = state.scene.layers.findIndex((l) => l.id === topId);
    dispatch(reorderLayer(topId, nextIndexForMove(topIndex, "down")));

    expect(state.scene.layers.map((l) => l.id)).toEqual(["a", "c", "b"]);
    // Et le panneau reflète maintenant "c" en DEUXIÈME position (plus plus en tête) : b est monté.
    expect(layersTopFirst(state.scene.layers).map((l) => l.id)).toEqual(["b", "c", "a"]);
  });

  it("monter le calque du BAS du panneau (bas de peinture) réordonne symétriquement", () => {
    const scene = makeScene();
    let state = initEditorState(scene);
    const dispatch = (action: EditorAction) => { state = editorReducer(state, action); };

    const bottomId = layersTopFirst(state.scene.layers).at(-1)!.id;
    expect(bottomId).toBe("a");
    const bottomIndex = state.scene.layers.findIndex((l) => l.id === bottomId);
    dispatch(reorderLayer(bottomId, nextIndexForMove(bottomIndex, "up")));

    expect(state.scene.layers.map((l) => l.id)).toEqual(["b", "a", "c"]);
  });
});

describe("LayerPanel — visibilité, verrou, suppression, ajout, renommage (structure rendue)", () => {
  it("reflète l'état visible/locked de chaque calque", () => {
    const html = render(makeScene());
    const bRow = html.slice(html.indexOf('data-layer-row-id="b"'), html.indexOf('data-layer-row-id="a"'));
    expect(bRow).toContain('data-action="toggle-visible"');
    expect(bRow).toContain('aria-pressed="true"'); // b est visible

    const cRow = html.slice(html.indexOf('data-layer-row-id="c"'), html.indexOf('data-layer-row-id="b"'));
    expect(cRow).toContain('data-action="toggle-locked"');
    expect(cRow.match(/aria-pressed="true"/g)?.length).toBeGreaterThanOrEqual(1); // c est locked
  });

  it("le bouton supprimer est désactivé pour un calque verrouillé", () => {
    const html = render(makeScene());
    const cRow = html.slice(html.indexOf('data-layer-row-id="c"'), html.indexOf('data-layer-row-id="b"'));
    expect(isDisabled(cRow, "delete")).toBe(true);
  });

  it("le bouton supprimer n'est PAS désactivé pour un calque non verrouillé", () => {
    const html = render(makeScene());
    const aRow = html.slice(html.indexOf('data-layer-row-id="a"'));
    expect(isDisabled(aRow, "delete")).toBe(false);
  });

  it("le champ de renommage affiche le nom actuel du calque", () => {
    const html = render(makeScene());
    expect(html).toContain('value="Fond A"');
    expect(html).toContain('value="Milieu B"');
  });

  it("propose d'ajouter un calque de chacun des quatre types", () => {
    const html = render(makeScene());
    for (const type of ["text", "image", "shape", "qr"]) {
      expect(html).toContain(`data-add-type="${type}"`);
    }
  });

  it("le bouton monter est désactivé pour le calque déjà en tête, le bouton descendre pour celui déjà en bas", () => {
    const html = render(makeScene());
    const cRow = html.slice(html.indexOf('data-layer-row-id="c"'), html.indexOf('data-layer-row-id="b"'));
    expect(isDisabled(cRow, "move-up")).toBe(true);
    const aRow = html.slice(html.indexOf('data-layer-row-id="a"'));
    expect(isDisabled(aRow, "move-down")).toBe(true);
  });
});
