import { describe, it, expect } from "bun:test";
import type { Scene, Layer } from "@/lib/studio/scene";
import {
  editorReducer,
  initEditorState,
  select,
  moveLayer,
  resizeLayer,
  rotateLayer,
  setLayerProp,
  addLayer,
  deleteLayer,
  reorderLayer,
  toggleVisible,
  toggleLocked,
  undo,
  redo,
  toCanvasCoords,
  toScreenCoords,
  type EditorState,
} from "@/lib/studio/editor-state";

// Scène de test : un calque de chaque type, plus un calque verrouillé dédié aux tests
// d'immunité — l'ordre EST l'ordre de peinture (scene.ts), donc l'index sert aussi à vérifier
// reorderLayer.
function makeScene(): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 1200, height: 675, background: "#000000" },
    layers: [
      {
        id: "bg", name: "Fond", visible: true, locked: false,
        frame: { x: 0, y: 0, w: 1200, h: 675 },
        type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover",
      },
      {
        id: "title", name: "Titre", visible: true, locked: false,
        frame: { x: 80, y: 400, w: 1040, h: 200 },
        type: "text", content: "{{article.title}}",
        font: { family: "Noto Sans", size: 64, weight: 700 },
        color: "#FFFFFF", align: "left", vAlign: "bottom", lineHeight: 1.1, maxLines: 3,
      },
      {
        id: "badge", name: "Bandeau", visible: true, locked: false,
        frame: { x: 40, y: 40, w: 200, h: 60 },
        type: "shape", shape: "rect", fill: "#FF0000",
      },
      {
        id: "qr1", name: "QR", visible: true, locked: false,
        frame: { x: 1000, y: 500, w: 120, h: 120 },
        type: "qr", slot: "article.url", fg: "#000000", bg: "#FFFFFF", margin: 4,
      },
      {
        id: "locked1", name: "Verrouillé", visible: true, locked: true,
        frame: { x: 10, y: 10, w: 100, h: 40 },
        type: "shape", shape: "rect", fill: "#00FF00",
      },
    ],
  };
}

function makeState(): EditorState {
  return initEditorState(makeScene());
}

function find(state: EditorState, id: string): Layer {
  const layer = state.scene.layers.find((l) => l.id === id);
  if (!layer) throw new Error(`calque « ${id} » introuvable dans le test`);
  return layer;
}

describe("select", () => {
  it("change selectedId sans toucher à la scène ni à l'historique", () => {
    const state = makeState();
    const next = editorReducer(state, select("title"));
    expect(next.selectedId).toBe("title");
    expect(next.scene).toBe(state.scene);
    expect(next.past).toEqual([]);
    expect(next.future).toEqual([]);
  });

  it("select(null) désélectionne", () => {
    const state = { ...makeState(), selectedId: "title" };
    const next = editorReducer(state, select(null));
    expect(next.selectedId).toBeNull();
  });
});

describe("moveLayer", () => {
  it("déplace un calque non verrouillé de dx/dy pixels gabarit et empile l'historique", () => {
    const state = makeState();
    const next = editorReducer(state, moveLayer("badge", 15, -5));
    const layer = find(next, "badge");
    expect(layer.frame).toEqual({ x: 55, y: 35, w: 200, h: 60 });
    expect(next.past).toHaveLength(1);
    expect(next.past[0]).toBe(state.scene);
    expect(next.future).toEqual([]);
  });
});

describe("resizeLayer", () => {
  it("remplace le frame d'un calque non verrouillé", () => {
    const state = makeState();
    const frame = { x: 50, y: 60, w: 300, h: 150 };
    const next = editorReducer(state, resizeLayer("badge", frame));
    expect(find(next, "badge").frame).toEqual(frame);
  });
});

describe("rotateLayer", () => {
  it("fixe la rotation d'un calque non verrouillé", () => {
    const state = makeState();
    const next = editorReducer(state, rotateLayer("badge", 45));
    expect(find(next, "badge").rotation).toBe(45);
  });
});

describe("setLayerProp", () => {
  it("fusionne un correctif de propriétés dans le calque", () => {
    const state = makeState();
    const next = editorReducer(state, setLayerProp("title", { content: "Nouveau titre", color: "#00FF00" }));
    const layer = find(next, "title") as Extract<Layer, { type: "text" }>;
    expect(layer.content).toBe("Nouveau titre");
    expect(layer.color).toBe("#00FF00");
  });

  it("s'applique même sur un calque verrouillé — verrou ne bloque que move/resize/rotate/delete", () => {
    const state = makeState();
    const next = editorReducer(state, setLayerProp("locked1", { fill: "#123456" }));
    const layer = find(next, "locked1") as Extract<Layer, { type: "shape" }>;
    expect(layer.fill).toBe("#123456");
  });
});

describe("addLayer", () => {
  for (const type of ["image", "text", "shape", "qr"] as const) {
    it(`crée un calque « ${type} » valide, à l'avant-plan, et le sélectionne`, () => {
      const state = makeState();
      const next = editorReducer(state, addLayer(type));
      expect(next.scene.layers).toHaveLength(state.scene.layers.length + 1);
      const added = next.scene.layers.at(-1)!;
      expect(added.type).toBe(type);
      expect(next.selectedId).toBe(added.id);
    });
  }

  // Tâche 3 (U1, spec §4) : « Texte dynamique » construit un TextLayer déjà lié à un jeton
  // (dynamic-text.ts:buildDynamicTextLayer) et le fait entrer par CETTE MÊME action — pas une
  // action parallèle — en fournissant le second argument optionnel `layer`.
  it("avec un `layer` fourni, insère CE calque tel quel plutôt que le calque générique par défaut", () => {
    const state = makeState();
    const prefilled: Layer = {
      id: "dyn-1", name: "Titre de l'article", visible: true, locked: false,
      frame: { x: 10, y: 10, w: 500, h: 100 },
      type: "text", content: "{{article.title}}",
      font: { family: "Noto Sans", size: 64, weight: 700 },
      color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
    };
    const next = editorReducer(state, addLayer("text", prefilled));
    expect(next.scene.layers).toHaveLength(state.scene.layers.length + 1);
    const added = next.scene.layers.at(-1)!;
    expect(added).toEqual(prefilled);
    expect(next.selectedId).toBe("dyn-1");
  });

  it("un `layer` fourni mais invalide laisse l'état inchangé, comme n'importe quel autre commit refusé", () => {
    const state = makeState();
    const invalid = { ...state.scene.layers[1], frame: { x: 0, y: 0, w: -1, h: 100 } } as Layer;
    const next = editorReducer(state, addLayer("text", invalid));
    expect(next).toBe(state);
  });
});

describe("deleteLayer", () => {
  it("supprime un calque non verrouillé et efface la sélection s'il était sélectionné", () => {
    const state = { ...makeState(), selectedId: "badge" };
    const next = editorReducer(state, deleteLayer("badge"));
    expect(next.scene.layers.find((l) => l.id === "badge")).toBeUndefined();
    expect(next.scene.layers).toHaveLength(state.scene.layers.length - 1);
    expect(next.selectedId).toBeNull();
  });

  it("laisse selectedId intact si le calque supprimé n'était pas sélectionné", () => {
    const state = { ...makeState(), selectedId: "title" };
    const next = editorReducer(state, deleteLayer("badge"));
    expect(next.selectedId).toBe("title");
  });
});

describe("reorderLayer", () => {
  it("déplace un calque à un nouvel index — l'ordre du tableau EST l'ordre de peinture", () => {
    const state = makeState();
    const next = editorReducer(state, reorderLayer("bg", 2));
    expect(next.scene.layers.map((l) => l.id)).toEqual(["title", "badge", "bg", "qr1", "locked1"]);
  });
});

describe("toggleVisible", () => {
  it("bascule la visibilité, dans les deux sens", () => {
    const state = makeState();
    const next = editorReducer(state, toggleVisible("badge"));
    expect(find(next, "badge").visible).toBe(false);
    const next2 = editorReducer(next, toggleVisible("badge"));
    expect(find(next2, "badge").visible).toBe(true);
  });
});

describe("toggleLocked", () => {
  it("verrouille un calque déverrouillé", () => {
    const state = makeState();
    const next = editorReducer(state, toggleLocked("badge"));
    expect(find(next, "badge").locked).toBe(true);
  });

  it("déverrouille un calque déjà verrouillé — décision : sans ça un verrou serait définitif", () => {
    const state = makeState();
    const next = editorReducer(state, toggleLocked("locked1"));
    expect(find(next, "locked1").locked).toBe(false);
    // Preuve que le déverrouillage est réel, pas cosmétique : moveLayer fonctionne maintenant.
    const next2 = editorReducer(next, moveLayer("locked1", 5, 5));
    expect(find(next2, "locked1").frame.x).toBe(15);
  });
});

describe("verrou — immunité des quatre actions affectées", () => {
  it("moveLayer est ignoré sur un calque verrouillé (état renvoyé inchangé, même référence)", () => {
    const state = makeState();
    const next = editorReducer(state, moveLayer("locked1", 10, 10));
    expect(next).toBe(state);
  });

  it("resizeLayer est ignoré sur un calque verrouillé", () => {
    const state = makeState();
    const next = editorReducer(state, resizeLayer("locked1", { x: 0, y: 0, w: 50, h: 50 }));
    expect(next).toBe(state);
  });

  it("rotateLayer est ignoré sur un calque verrouillé", () => {
    const state = makeState();
    const next = editorReducer(state, rotateLayer("locked1", 90));
    expect(next).toBe(state);
  });

  it("deleteLayer est ignoré sur un calque verrouillé", () => {
    const state = makeState();
    const next = editorReducer(state, deleteLayer("locked1"));
    expect(next).toBe(state);
    expect(next.scene.layers.find((l) => l.id === "locked1")).toBeDefined();
  });
});

describe("garde-fou scène invalide", () => {
  it("resizeLayer avec une largeur négative est refusé (frame.w exige positive dans scene.ts) — état inchangé", () => {
    const state = makeState();
    // w négatif : frame = z.object({ ..., w: z.number().positive() }) dans lib/studio/scene.ts —
    // la scène candidate échouerait donc `parseScene`.
    const next = editorReducer(state, resizeLayer("badge", { x: 0, y: 0, w: -10, h: 50 }));
    expect(next).toBe(state);
  });

  it("setLayerProp qui crée un identifiant de calque dupliqué est refusé — parseScene rejette explicitement les doublons", () => {
    const state = makeState();
    // patch id: "title" sur le calque "badge" produirait deux calques d'id "title" ; parseScene
    // lève explicitement SceneError sur « identifiant de calque en double » (scene.ts).
    const next = editorReducer(state, setLayerProp("badge", { id: "title" }));
    expect(next).toBe(state);
    expect(state.scene.layers.filter((l) => l.id === "title")).toHaveLength(1);
  });
});

describe("undo / redo", () => {
  it("fait un aller-retour complet : annuler restaure la scène précédente, rétablir la ramène", () => {
    const state = makeState();
    const afterMove = editorReducer(state, moveLayer("badge", 10, 0));
    const afterUndo = editorReducer(afterMove, undo());
    expect(afterUndo.scene).toEqual(state.scene);
    expect(afterUndo.past).toEqual([]);
    expect(afterUndo.future).toHaveLength(1);

    const afterRedo = editorReducer(afterUndo, redo());
    expect(afterRedo.scene).toEqual(afterMove.scene);
    expect(afterRedo.past).toHaveLength(1);
    expect(afterRedo.future).toEqual([]);
  });

  it("undo sur historique vide est un no-op (même référence)", () => {
    const state = makeState();
    expect(editorReducer(state, undo())).toBe(state);
  });

  it("redo sur futur vide est un no-op (même référence)", () => {
    const state = makeState();
    expect(editorReducer(state, redo())).toBe(state);
  });

  it("une nouvelle modification après undo efface le futur — redo devient impossible", () => {
    const state = makeState();
    const afterMove = editorReducer(state, moveLayer("badge", 10, 0));
    const afterUndo = editorReducer(afterMove, undo());
    const afterOther = editorReducer(afterUndo, moveLayer("title", 1, 1));
    expect(afterOther.future).toEqual([]);
    expect(editorReducer(afterOther, redo())).toBe(afterOther);
  });

  it("select/undo/redo eux-mêmes ne s'empilent pas dans l'historique", () => {
    const state = makeState();
    const afterSelect = editorReducer(state, select("title"));
    expect(afterSelect.past).toEqual([]);
    expect(afterSelect.future).toEqual([]);
  });
});

describe("plafond d'historique à 50", () => {
  it("ne conserve que les 50 derniers états — au-delà, ces états sont perdus, pas seulement inaccessibles temporairement", () => {
    let state = makeState();
    for (let i = 0; i < 60; i++) {
      state = editorReducer(state, moveLayer("badge", 1, 0));
    }
    expect(state.past).toHaveLength(50);
    expect(find(state, "badge").frame.x).toBe(40 + 60);

    // 50 undo consécutifs épuisent exactement le plafond.
    let cur = state;
    for (let i = 0; i < 50; i++) cur = editorReducer(cur, undo());
    expect(cur.past).toHaveLength(0);
    // Les 10 premières actions (sur 60) sont tombées hors du plafond de 50 : on ne peut pas
    // revenir plus loin que l'état après la 10e action. Si le plafond n'existait pas, `past`
    // vaudrait 60 après la boucle ci-dessus et ce dernier `cur` serait encore x=40 (état initial).
    expect(find(cur, "badge").frame.x).toBe(40 + 10);

    // Un undo de plus est un no-op : impossible de revenir avant le plafond.
    const beyond = editorReducer(cur, undo());
    expect(beyond).toBe(cur);
  });
});

describe("absence de mutation", () => {
  it("aucune action n'altère l'état d'entrée — comparaison PROFONDE avant/après, pas juste une référence", () => {
    const initial = makeState();
    const snapshot = structuredClone(initial);

    editorReducer(initial, moveLayer("badge", 5, 5));
    editorReducer(initial, resizeLayer("title", { x: 0, y: 0, w: 10, h: 10 }));
    editorReducer(initial, rotateLayer("qr1", 30));
    editorReducer(initial, setLayerProp("title", { content: "X" }));
    editorReducer(initial, addLayer("text"));
    editorReducer(initial, deleteLayer("badge"));
    editorReducer(initial, reorderLayer("bg", 3));
    editorReducer(initial, toggleVisible("badge"));
    editorReducer(initial, toggleLocked("locked1"));
    editorReducer(initial, select("title"));
    editorReducer(initial, undo());
    editorReducer(initial, redo());

    expect(initial).toEqual(snapshot);
  });

  it("le nouvel état ne partage pas ses objets (tableau, calque, frame) avec l'état précédent", () => {
    const state = makeState();
    const next = editorReducer(state, moveLayer("badge", 1, 1));
    expect(next.scene.layers).not.toBe(state.scene.layers);
    const before = find(state, "badge");
    const after = find(next, "badge");
    expect(after).not.toBe(before);
    expect(after.frame).not.toBe(before.frame);
    expect(before.frame.x).toBe(40);
  });
});

describe("toCanvasCoords / toScreenCoords", () => {
  it("k = 0.5 : un glisser de N px écran déplace le calque de N/k px gabarit", () => {
    expect(toCanvasCoords({ x: 10, y: 20 }, 0.5)).toEqual({ x: 20, y: 40 });
    expect(toCanvasCoords({ x: -10, y: -20 }, 0.5)).toEqual({ x: -20, y: -40 });
  });

  it("k = 1.7 : conversion écran -> gabarit et gabarit -> écran", () => {
    expect(toCanvasCoords({ x: 17, y: 34 }, 1.7)).toEqual({ x: 10, y: 20 });
    expect(toScreenCoords({ x: 10, y: 20 }, 1.7)).toEqual({ x: 17, y: 34 });
  });

  it("toScreenCoords est l'inverse exacte de toCanvasCoords", () => {
    const delta = { x: 123, y: -45 };
    expect(toScreenCoords(toCanvasCoords(delta, 0.5), 0.5)).toEqual(delta);
    expect(toScreenCoords(toCanvasCoords(delta, 1.7), 1.7)).toEqual(delta);
  });
});
