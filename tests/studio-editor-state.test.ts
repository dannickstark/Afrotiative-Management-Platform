import { describe, it, expect } from "bun:test";
import type { Scene, Layer } from "@/lib/studio/scene";
import { constraintsOf } from "@/lib/studio/scene";
import { relayoutToFormat, relayoutFrame } from "@/lib/studio/relayout";
import { FORMAT_PRESETS } from "@/lib/studio/formats";
import {
  editorReducer,
  initEditorState,
  select,
  selectMany,
  toggleSelection,
  clearSelection,
  singleSelectedId,
  moveLayer,
  resizeLayer,
  rotateLayer,
  setLayerProp,
  addLayer,
  addLayers,
  deleteLayer,
  reorderLayer,
  toggleVisible,
  toggleLocked,
  setFrames,
  setFrameOverride,
  frameEditAction,
  setGroup,
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
  it("change selectedIds sans toucher à la scène ni à l'historique", () => {
    const state = makeState();
    const next = editorReducer(state, select("title"));
    expect(next.selectedIds).toEqual(["title"]);
    expect(next.scene).toBe(state.scene);
    expect(next.past).toEqual([]);
    expect(next.future).toEqual([]);
  });

  it("select(null) désélectionne", () => {
    const state = { ...makeState(), selectedIds: ["title"] };
    const next = editorReducer(state, select(null));
    expect(next.selectedIds).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tâche 3 (U2, spec §3) — sélection MULTIPLE. `selectedId: string | null` est devenu
// `selectedIds: string[]`.
describe("sélection multiple — aller-retour par le réducteur", () => {
  // La propriété du plan : « une sélection vide, une sélection simple et une sélection multiple
  // font chacune un aller-retour par le réducteur ». Ce qui rendrait ce test ROUGE : un réducteur
  // qui trierait les ids (l'ordre d'insertion est la seule chose que `selectedIds` porte de plus
  // qu'un `Set`), qui les filtrerait contre la scène, ou qui n'en garderait qu'un.
  for (const ids of [[], ["title"], ["title", "badge", "qr1"]] as const) {
    it(`selectMany([${ids.join(", ")}]) ressort à l'identique, dans le MÊME ordre`, () => {
      const state = makeState();
      const next = editorReducer(state, selectMany(ids));
      expect(next.selectedIds).toEqual([...ids]);
      expect(next.scene).toBe(state.scene);
      expect(next.past).toEqual([]);
    });
  }

  it("l'ordre d'insertion est CONSERVÉ et n'est pas l'ordre de scene.layers", () => {
    const state = makeState();
    // scene.layers est [bg, title, badge, qr1, locked1] : cet ordre-là est délibérément l'INVERSE
    // partiel de la sélection ci-dessous, donc un réducteur qui reprojetterait la sélection sur
    // l'ordre de peinture donnerait ["title", "badge"] et échouerait ici.
    const next = editorReducer(state, selectMany(["badge", "title"]));
    expect(next.selectedIds).toEqual(["badge", "title"]);
  });

  it("dédoublonne, en gardant la PREMIÈRE occurrence de chaque id", () => {
    const state = makeState();
    const next = editorReducer(state, selectMany(["badge", "title", "badge"]));
    expect(next.selectedIds).toEqual(["badge", "title"]);
  });

  it("une sélection identique renvoie LA MÊME référence d'état (pas un état neuf équivalent)", () => {
    const state = { ...makeState(), selectedIds: ["title", "badge"] };
    expect(editorReducer(state, selectMany(["title", "badge"]))).toBe(state);
    // …mais un ORDRE différent est une sélection différente : `selectedIds` porte l'ordre.
    expect(editorReducer(state, selectMany(["badge", "title"]))).not.toBe(state);
  });

  it("clearSelection() vide la sélection sans toucher la scène", () => {
    const state = { ...makeState(), selectedIds: ["title", "badge"] };
    const next = editorReducer(state, clearSelection());
    expect(next.selectedIds).toEqual([]);
    expect(next.scene).toBe(state.scene);
  });
});

describe("toggleSelection — le geste Maj-clic, au niveau du réducteur", () => {
  it("ajoute un id ABSENT à la fin, sans déranger les autres", () => {
    const state = { ...makeState(), selectedIds: ["title", "badge"] };
    const next = editorReducer(state, toggleSelection("qr1"));
    expect(next.selectedIds).toEqual(["title", "badge", "qr1"]);
  });

  it("retire un id PRÉSENT en gardant l'ordre des survivants", () => {
    const state = { ...makeState(), selectedIds: ["title", "badge", "qr1"] };
    const next = editorReducer(state, toggleSelection("badge"));
    expect(next.selectedIds).toEqual(["title", "qr1"]);
  });

  it("basculer deux fois le même id revient EXACTEMENT à la sélection de départ", () => {
    const state = { ...makeState(), selectedIds: ["title"] };
    const once = editorReducer(state, toggleSelection("badge"));
    const twice = editorReducer(once, toggleSelection("badge"));
    expect(once.selectedIds).toEqual(["title", "badge"]);
    expect(twice.selectedIds).toEqual(["title"]);
  });

  it("ne touche ni la scène ni l'historique — sélectionner n'est pas modifier", () => {
    const state = { ...makeState(), selectedIds: ["title"] };
    const next = editorReducer(state, toggleSelection("badge"));
    expect(next.scene).toBe(state.scene);
    expect(next.past).toEqual([]);
    expect(next.future).toEqual([]);
  });
});

describe("singleSelectedId — l'aide dérivée du cas « une seule sélection »", () => {
  it("renvoie l'id pour une sélection simple, et null pour vide OU multiple", () => {
    expect(singleSelectedId([])).toBeNull();
    expect(singleSelectedId(["a"])).toBe("a");
    // Le cas qui compte : une aide naïve (`ids[0] ?? null`) passerait les deux lignes ci-dessus et
    // échouerait ICI — c'est exactement la confusion qui ferait afficher les propriétés d'UN calque
    // alors que l'utilisateur en a sélectionné trois.
    expect(singleSelectedId(["a", "b"])).toBeNull();
    expect(singleSelectedId(["a", "b", "c"])).toBeNull();
  });
});

describe("moveLayer", () => {
  it("déplace un calque non verrouillé de dx/dy pixels gabarit et empile l'historique", () => {
    const state = makeState();
    const next = editorReducer(state, moveLayer("badge", 15, -5));
    const layer = find(next, "badge");
    expect(layer.frame).toEqual({ x: 55, y: 35, w: 200, h: 60 });
    expect(next.past).toHaveLength(1);
    // `past` porte désormais des entrées `{ scene, selectedIds }` (Tâche 3, U2) — la scène empilée
    // reste vérifiée par RÉFÉRENCE, comme avant : l'historique ne recopie jamais la scène.
    expect(next.past[0].scene).toBe(state.scene);
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
      expect(next.selectedIds).toEqual([added.id]);
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
    expect(next.selectedIds).toEqual(["dyn-1"]);
  });

  it("un `layer` fourni mais invalide laisse l'état inchangé, comme n'importe quel autre commit refusé", () => {
    const state = makeState();
    const invalid = { ...state.scene.layers[1], frame: { x: 0, y: 0, w: -1, h: 100 } } as Layer;
    const next = editorReducer(state, addLayer("text", invalid));
    expect(next).toBe(state);
  });
});

// ── Chantier B, Tâche 2 — `addLayers` : le pendant PLURIEL de `addLayer`, pour le presse-papiers en
// session (copier/coller/dupliquer). Sur le modèle de `setFrames`/`setLayerProps` : un LOT de
// calques, UNE SEULE entrée d'historique — voir le commentaire de `"addLayers"` sur `EditorAction`
// (lib/studio/editor-state.ts) pour le détail. Contrairement à `addLayer`, qui REMPLACE la
// sélection par le seul calque ajouté, `addLayers` la remplace par TOUS les ids ajoutés (c'est ce
// qui fait qu'un coller sélectionne ce qu'on vient de coller).
describe("addLayers — le LOT d'ajout, UNE entrée d'historique (chantier B, tâche 2)", () => {
  function extra(id: string): Layer {
    return {
      id, name: "Collé", visible: true, locked: false,
      frame: { x: 16, y: 16, w: 80, h: 80 },
      type: "shape", shape: "rect", fill: "#123456",
    };
  }

  it("ajoute N calques À LA FIN de scene.layers (avant-plan) en UNE SEULE entrée d'historique", () => {
    const state = makeState();
    const before = state.scene.layers.length;
    const next = editorReducer(state, addLayers([extra("p1"), extra("p2"), extra("p3")]));
    expect(next.scene.layers).toHaveLength(before + 3);
    expect(next.scene.layers.slice(-3).map((l) => l.id)).toEqual(["p1", "p2", "p3"]);
    expect(next.past).toHaveLength(1);
    expect(next.future).toEqual([]);
  });

  it("sélectionne TOUS les calques ajoutés, dans l'ordre fourni", () => {
    const state = makeState();
    const next = editorReducer(state, addLayers([extra("p1"), extra("p2")]));
    expect(next.selectedIds).toEqual(["p1", "p2"]);
  });

  it("UN SEUL undo retire les N calques à la fois — pas un par un", () => {
    const state = { ...makeState(), selectedIds: ["title"] };
    const before = state.scene.layers.length;
    const next = editorReducer(state, addLayers([extra("p1"), extra("p2"), extra("p3")]));
    const afterUndo = editorReducer(next, undo());
    expect(afterUndo.scene.layers).toHaveLength(before);
    expect(afterUndo.scene.layers.some((l) => l.id === "p1" || l.id === "p2" || l.id === "p3")).toBe(false);
    // …et restaure la sélection D'AVANT le coller (même contrat que le reste de l'historique).
    expect(afterUndo.selectedIds).toEqual(["title"]);

    const afterRedo = editorReducer(afterUndo, redo());
    expect(afterRedo.scene).toEqual(next.scene);
    expect(afterRedo.selectedIds).toEqual(["p1", "p2", "p3"]);
  });

  // Anti-vacuité (brief) : « paste avec un presse-papiers VIDE est un no-op — aucune entrée
  // d'historique, état inchangé PAR RÉFÉRENCE ». C'est le module clipboard (lib/studio/clipboard.ts)
  // qui décide QUAND appeler addLayers([]), mais le réducteur lui-même doit être sûr sur ce cas :
  // sans cette garde, un coller à vide empilerait une entrée d'annulation fantôme.
  it("un lot VIDE est un no-op — même référence, aucune entrée d'historique", () => {
    const state = makeState();
    expect(editorReducer(state, addLayers([]))).toBe(state);
  });

  it("un calque invalide dans le lot fait refuser TOUT le lot (commit() valide la scène entière)", () => {
    const state = makeState();
    const invalid = { ...extra("bad"), frame: { x: 0, y: 0, w: -1, h: 10 } } as Layer;
    const next = editorReducer(state, addLayers([extra("ok"), invalid]));
    expect(next).toBe(state);
  });

  it("un id qui collide avec un calque déjà présent dans la scène est refusé — parseScene rejette les doublons", () => {
    const state = makeState();
    // "title" existe déjà dans makeScene() : ajouter un calque partageant cet id doit être refusé,
    // exactement comme setLayerProp qui créerait un doublon (voir « garde-fou scène invalide »).
    const next = editorReducer(state, addLayers([extra("title")]));
    expect(next).toBe(state);
  });
});

// ── Chantier B, Tâche 5 — `setGroup` : grouper/dégrouper, modèle FLAT (lib/studio/groups.ts). Sur le
// modèle EXACT de `setFrames`/`setLayerProps`/`addLayers` ci-dessus : un LOT d'ids, UNE SEULE entrée
// d'historique, AUCUNE ENTRÉE FANTÔME si rien ne change réellement.
describe("setGroup — grouper/dégrouper, UNE entrée d'historique (chantier B, Tâche 5)", () => {
  it("assigne le MÊME groupId à tous les ids donnés, en UNE SEULE entrée d'historique", () => {
    const state = makeState();
    const next = editorReducer(state, setGroup(["title", "badge", "qr1"], "g1"));
    expect(find(next, "title").groupId).toBe("g1");
    expect(find(next, "badge").groupId).toBe("g1");
    expect(find(next, "qr1").groupId).toBe("g1");
    // Les calques HORS du lot restent intacts, y compris SANS groupId.
    expect("groupId" in find(next, "bg")).toBe(false);
    expect(next.past).toHaveLength(1);
  });

  it("groupId: null DÉGROUPE — retire la clé (pas une valeur undefined) de chaque membre du lot", () => {
    const grouped = editorReducer(makeState(), setGroup(["title", "badge"], "g1"));
    const ungrouped = editorReducer(grouped, setGroup(["title", "badge"], null));
    expect("groupId" in find(ungrouped, "title")).toBe(false);
    expect("groupId" in find(ungrouped, "badge")).toBe(false);
    expect(ungrouped.past).toHaveLength(2); // grouper PUIS dégrouper : deux gestes, deux entrées.
  });

  // ANTI-VACUITÉ (brief, Step 4) : « dropping one-history-entry on setGroup reddens the undo test » —
  // ce test EST ce garde-fou. Une implémentation qui empilerait une entrée PAR calque (une boucle sur
  // une action à un seul id) laisserait `past` à 3, pas 1, et UN SEUL undo ne suffirait pas à tout
  // annuler.
  it("UN SEUL undo annule TOUT le lot, quel que soit son nombre de membres", () => {
    const state = { ...makeState(), selectedIds: ["title"] };
    const next = editorReducer(state, setGroup(["title", "badge", "qr1"], "g1"));
    expect(next.past).toHaveLength(1);

    const afterUndo = editorReducer(next, undo());
    expect("groupId" in find(afterUndo, "title")).toBe(false);
    expect("groupId" in find(afterUndo, "badge")).toBe(false);
    expect("groupId" in find(afterUndo, "qr1")).toBe(false);
    expect(afterUndo.selectedIds).toEqual(["title"]); // la sélection D'AVANT le geste est restaurée.

    const afterRedo = editorReducer(afterUndo, redo());
    expect(find(afterRedo, "title").groupId).toBe("g1");
    expect(find(afterRedo, "badge").groupId).toBe("g1");
    expect(find(afterRedo, "qr1").groupId).toBe("g1");
  });

  it("un lot VIDE est un no-op — même référence, aucune entrée d'historique", () => {
    const state = makeState();
    expect(editorReducer(state, setGroup([], "g1"))).toBe(state);
  });

  it("réassigner le MÊME groupId ne produit AUCUNE entrée fantôme — état inchangé, même référence", () => {
    const grouped = editorReducer(makeState(), setGroup(["title", "badge"], "g1"));
    const again = editorReducer(grouped, setGroup(["title", "badge"], "g1"));
    expect(again).toBe(grouped);
  });

  it("dégrouper des calques SANS groupId est un no-op — même référence, aucune entrée d'historique", () => {
    const state = makeState();
    expect(editorReducer(state, setGroup(["title", "badge"], null))).toBe(state);
  });

  it("un id absent de la scène est sauté ligne à ligne — les autres du lot sont quand même groupés", () => {
    const state = makeState();
    const next = editorReducer(state, setGroup(["title", "inexistant", "badge"], "g1"));
    expect(find(next, "title").groupId).toBe("g1");
    expect(find(next, "badge").groupId).toBe("g1");
    expect(next.past).toHaveLength(1);
  });

  // INVARIANT CONSTRAINTS-INTACTES (chantier D) — voir le commentaire du cas "setGroup" dans
  // editor-state.ts : grouper/dégrouper ne doit JAMAIS toucher `layer.constraints`, présent ou absent.
  it("CONSTRAINTS-INTACTES : grouper/dégrouper ne change JAMAIS layer.constraints", () => {
    const scene = makeScene();
    scene.layers = scene.layers.map((l) =>
      l.id === "title" ? { ...l, constraints: { h: "leftRight" as const, v: "center" as const } } : l);
    const state = initEditorState(scene);
    const before = constraintsOf(find(state, "title"));

    const grouped = editorReducer(state, setGroup(["title", "badge"], "g1"));
    expect(constraintsOf(find(grouped, "title"))).toEqual(before);
    // "badge" n'avait pas de constraints avant grouper — il n'en gagne pas une au passage.
    expect("constraints" in find(grouped, "badge")).toBe(false);

    const ungrouped = editorReducer(grouped, setGroup(["title", "badge"], null));
    expect(constraintsOf(find(ungrouped, "title"))).toEqual(before);
    expect("constraints" in find(ungrouped, "badge")).toBe(false);
  });

  it("un calque VERROUILLÉ peut quand même être groupé — le verrou protège la position/taille, pas l'appartenance à un groupe", () => {
    const state = makeState();
    const next = editorReducer(state, setGroup(["locked1", "badge"], "g1"));
    expect(find(next, "locked1").groupId).toBe("g1");
    expect(find(next, "locked1").locked).toBe(true);
  });
});

describe("deleteLayer", () => {
  it("supprime un calque non verrouillé et efface la sélection s'il était sélectionné", () => {
    const state = { ...makeState(), selectedIds: ["badge"] };
    const next = editorReducer(state, deleteLayer("badge"));
    expect(next.scene.layers.find((l) => l.id === "badge")).toBeUndefined();
    expect(next.scene.layers).toHaveLength(state.scene.layers.length - 1);
    expect(next.selectedIds).toEqual([]);
  });

  it("laisse la sélection intacte si le calque supprimé n'était pas sélectionné", () => {
    const state = { ...makeState(), selectedIds: ["title"] };
    const next = editorReducer(state, deleteLayer("badge"));
    expect(next.selectedIds).toEqual(["title"]);
  });

  // Tâche 3 (U2) — la propriété du plan : « supprimer un calque sélectionné le retire de
  // selectedIds sans rendre les autres orphelins ». Ce qui rendrait ce test ROUGE : la migration
  // NAÏVE de l'ancien `selectedId === action.id ? null : …` vers `selectedIds.includes(action.id)
  // ? [] : …`, qui viderait TOUTE la sélection au lieu du seul id supprimé.
  it("d'une sélection MULTIPLE, ne retire QUE l'id supprimé — les autres survivent, dans l'ordre", () => {
    const state = { ...makeState(), selectedIds: ["badge", "title", "qr1"] };
    const next = editorReducer(state, deleteLayer("badge"));
    expect(next.selectedIds).toEqual(["title", "qr1"]);
    expect(next.scene.layers.find((l) => l.id === "badge")).toBeUndefined();
    // …et les deux survivants existent BIEN encore dans la scène : la sélection ne pointe pas dans
    // le vide.
    for (const id of next.selectedIds) {
      expect(next.scene.layers.some((l) => l.id === id)).toBe(true);
    }
  });

  it("une suppression REFUSÉE (calque verrouillé) ne touche pas non plus la sélection", () => {
    const state = { ...makeState(), selectedIds: ["locked1", "title"] };
    const next = editorReducer(state, deleteLayer("locked1"));
    expect(next).toBe(state);
    expect(next.selectedIds).toEqual(["locked1", "title"]);
  });
});

// ── Tâche 4 (U2, spec §4) — le LOT de cadres : « une action appliquant un lot de changements de
// cadre comme UNE SEULE entrée d'annulation, pas une par calque » ───────────────────────────────
describe("setFrames — un lot de cadres, UNE entrée d'historique", () => {
  it("applique plusieurs cadres d'un coup et n'empile QU'UNE entrée d'historique", () => {
    const state = makeState();
    const next = editorReducer(state, setFrames([
      { id: "badge", frame: { x: 500, y: 40, w: 200, h: 60 } },
      { id: "title", frame: { x: 500, y: 400, w: 1040, h: 200 } },
      { id: "qr1", frame: { x: 500, y: 500, w: 120, h: 120 } },
    ]));

    expect(find(next, "badge").frame.x).toBe(500);
    expect(find(next, "title").frame.x).toBe(500);
    expect(find(next, "qr1").frame.x).toBe(500);
    // LE cœur de cette action. Trois calques déplacés, UNE entrée : une implémentation qui bouclerait
    // sur moveLayer/resizeLayer en empilerait TROIS, et l'utilisateur devrait annuler trois fois un
    // geste unique. C'est aussi la raison pour laquelle la Tâche 3 a laissé Suppr/flèches en sélection
    // simple (voir canvas.tsx) : elles attendaient cette action.
    expect(next.past).toHaveLength(1);
    expect(next.future).toEqual([]);
  });

  it("UN SEUL undo restaure les TROIS cadres à la fois", () => {
    const state = makeState();
    const before = state.scene.layers.map((l) => ({ id: l.id, frame: { ...l.frame } }));
    const next = editorReducer(state, setFrames([
      { id: "badge", frame: { x: 1, y: 2, w: 200, h: 60 } },
      { id: "title", frame: { x: 3, y: 4, w: 1040, h: 200 } },
      { id: "qr1", frame: { x: 5, y: 6, w: 120, h: 120 } },
    ]));
    const afterUndo = editorReducer(next, undo());
    expect(afterUndo.scene.layers.map((l) => ({ id: l.id, frame: { ...l.frame } }))).toEqual(before);
    expect(afterUndo.past).toEqual([]);
    // …et rétablir les remet tous les trois, symétriquement.
    const afterRedo = editorReducer(afterUndo, redo());
    expect(afterRedo.scene).toEqual(next.scene);
  });

  it("saute les calques VERROUILLÉS et applique les autres — le lot n'est pas refusé en entier pour autant", () => {
    const state = makeState();
    const next = editorReducer(state, setFrames([
      { id: "locked1", frame: { x: 999, y: 999, w: 100, h: 40 } },
      { id: "badge", frame: { x: 77, y: 40, w: 200, h: 60 } },
    ]));
    expect(find(next, "locked1").frame).toEqual({ x: 10, y: 10, w: 100, h: 40 });
    expect(find(next, "badge").frame.x).toBe(77);
    expect(next.past).toHaveLength(1);
  });

  it("saute un id absent de la scène et applique les autres", () => {
    const state = makeState();
    const next = editorReducer(state, setFrames([
      { id: "fantôme", frame: { x: 1, y: 1, w: 10, h: 10 } },
      { id: "badge", frame: { x: 77, y: 40, w: 200, h: 60 } },
    ]));
    expect(find(next, "badge").frame.x).toBe(77);
    expect(next.scene.layers).toHaveLength(state.scene.layers.length);
    expect(next.past).toHaveLength(1);
  });

  it("un lot VIDE est un no-op — même référence, aucune entrée d'historique", () => {
    const state = makeState();
    expect(editorReducer(state, setFrames([]))).toBe(state);
  });

  it("un lot dont AUCUN cadre ne change réellement est un no-op — pas une entrée d'historique vide", () => {
    // Le cas normal quand on aligne un ensemble déjà aligné : sans cette garde, chaque clic sur
    // « Aligner à gauche » d'un ensemble déjà à gauche empilerait une entrée d'annulation fantôme.
    const state = makeState();
    const badge = find(state, "badge");
    const same = editorReducer(state, setFrames([{ id: "badge", frame: { ...badge.frame } }]));
    expect(same).toBe(state);
    // Un lot mêlant un cadre identique et un cadre différent, lui, s'applique bien.
    const mixed = editorReducer(state, setFrames([
      { id: "badge", frame: { ...badge.frame } },
      { id: "title", frame: { x: 0, y: 400, w: 1040, h: 200 } },
    ]));
    expect(mixed).not.toBe(state);
    expect(mixed.past).toHaveLength(1);
    expect(find(mixed, "badge").frame).toEqual(badge.frame);
    expect(find(mixed, "title").frame.x).toBe(0);
  });

  it("un lot contenant UN cadre invalide est refusé EN ENTIER — atomicité, pas application partielle", () => {
    // commit() valide la scène candidate ENTIÈRE (parseScene) : le premier cadre du lot est
    // parfaitement légal, mais la largeur négative du second invalide la scène, donc RIEN n'entre.
    const state = makeState();
    const next = editorReducer(state, setFrames([
      { id: "badge", frame: { x: 77, y: 40, w: 200, h: 60 } },
      { id: "title", frame: { x: 0, y: 0, w: -5, h: 200 } },
    ]));
    expect(next).toBe(state);
    expect(find(next, "badge").frame.x).toBe(40);
  });

  it("ne touche pas la sélection, et l'undo restaure celle qui existait (même contrat que les autres modifications)", () => {
    const state = { ...makeState(), selectedIds: ["badge", "title"] };
    const next = editorReducer(state, setFrames([{ id: "badge", frame: { x: 1, y: 1, w: 200, h: 60 } }]));
    expect(next.selectedIds).toEqual(["badge", "title"]);
    const afterSelect = editorReducer(next, select("qr1"));
    expect(editorReducer(afterSelect, undo()).selectedIds).toEqual(["badge", "title"]);
  });

  it("recopie le cadre fourni au lieu de le référencer — muter l'objet de l'action après coup ne change pas la scène", () => {
    const state = makeState();
    const frame = { x: 111, y: 40, w: 200, h: 60 };
    const next = editorReducer(state, setFrames([{ id: "badge", frame }]));
    frame.x = -1;
    expect(find(next, "badge").frame.x).toBe(111);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chantier D, Tâche 5 — `setFrameOverride` : l'échappatoire manuelle pour un format NON-accueil.
// Éditer un cadre pendant qu'un format non-accueil est prévisualisé écrit
// `scene.formatOverrides[format][layerId]`, JAMAIS `layer.frame` (le format d'accueil) — c'est la
// différence structurelle avec `setFrames`/`resizeLayer` ci-dessus, qui éditent tous deux
// `layer.frame`. Réutilise `commit()` (donc `parseScene`, l'historique, le plafond) sans code
// spécifique : un `undo` restaure la scène ENTIÈRE d'avant, surcharge comprise — voir le test
// « aucun orphelin » plus bas, qui épingle précisément cette propriété.
describe("setFrameOverride — l'échappatoire manuelle pour un format non-accueil (chantier D, tâche 5)", () => {
  const overrideFrame = { x: 9, y: 9, w: 42, h: 42 };

  it("écrit scene.formatOverrides[format][layerId] et laisse layer.frame (accueil) INTACT", () => {
    const state = makeState();
    const homeFrameBefore = { ...find(state, "badge").frame };

    const next = editorReducer(state, setFrameOverride("story", "badge", overrideFrame));

    expect(next.scene.formatOverrides?.story?.badge).toEqual(overrideFrame);
    // LE cœur de l'invariant : le cadre d'accueil du calque n'a PAS bougé.
    expect(find(next, "badge").frame).toEqual(homeFrameBefore);
    expect(next.past).toHaveLength(1);
    expect(next.future).toEqual([]);
  });

  it("relayoutToFormat(scene, 'story') utilise la surcharge pour badge — et LA CONTRAINTE pour title (anti-vacuité)", () => {
    const state = makeState();
    const next = editorReducer(state, setFrameOverride("story", "badge", overrideFrame));
    const relayouted = relayoutToFormat(next.scene, "story");

    const badgeFrame = relayouted.layers.find((l) => l.id === "badge")!.frame;
    expect(badgeFrame).toEqual(overrideFrame);

    // `title` n'a AUCUNE surcharge pour "story" : il doit continuer à passer par relayoutFrame/sa
    // contrainte — la preuve que le chemin « contrainte » est bien emprunté à côté du chemin
    // « surcharge », pas seulement quand la carte de surcharges est totalement vide.
    const title = find(next, "title");
    const titleFrame = relayouted.layers.find((l) => l.id === "title")!.frame;
    const expectedTitleFrame = relayoutFrame(
      title.frame,
      constraintsOf(title),
      { w: next.scene.canvas.width, h: next.scene.canvas.height },
      { w: FORMAT_PRESETS.story.width, h: FORMAT_PRESETS.story.height },
    );
    expect(titleFrame).toEqual(expectedTitleFrame);
  });

  it("un format DIFFÉRENT de celui surchargé continue d'utiliser la contrainte (anti-vacuité)", () => {
    const state = makeState();
    const next = editorReducer(state, setFrameOverride("story", "badge", overrideFrame));
    const relayoutedOther = relayoutToFormat(next.scene, "ig_square");
    const badgeFrame = relayoutedOther.layers.find((l) => l.id === "badge")!.frame;
    expect(badgeFrame).not.toEqual(overrideFrame);
  });

  it("UN SEUL undo retire la surcharge — SANS ORPHELIN — et redo la rétablit", () => {
    const state = makeState();
    const next = editorReducer(state, setFrameOverride("story", "badge", overrideFrame));

    const afterUndo = editorReducer(next, undo());
    expect(afterUndo.scene.formatOverrides?.story?.badge).toBeUndefined();
    expect(afterUndo.scene).toEqual(state.scene);
    expect(afterUndo.past).toEqual([]);
    expect(afterUndo.future).toHaveLength(1);

    const afterRedo = editorReducer(afterUndo, redo());
    expect(afterRedo.scene).toEqual(next.scene);
    expect(afterRedo.scene.formatOverrides?.story?.badge).toEqual(overrideFrame);
  });

  it("un id absent de la scène est un no-op — même référence, aucune entrée d'historique", () => {
    const state = makeState();
    expect(editorReducer(state, setFrameOverride("story", "fantôme", overrideFrame))).toBe(state);
  });

  it("recopie le cadre fourni au lieu de le référencer", () => {
    const state = makeState();
    const frame = { x: 1, y: 2, w: 3, h: 4 };
    const next = editorReducer(state, setFrameOverride("story", "badge", frame));
    frame.x = -1;
    expect(next.scene.formatOverrides?.story?.badge.x).toBe(1);
  });

  it("une surcharge existante pour UN AUTRE calque ou UN AUTRE format n'est pas touchée", () => {
    const state = makeState();
    const withFirst = editorReducer(state, setFrameOverride("story", "badge", overrideFrame));
    const withSecond = editorReducer(withFirst, setFrameOverride("ig_square", "title", { x: 1, y: 1, w: 5, h: 5 }));
    expect(withSecond.scene.formatOverrides?.story?.badge).toEqual(overrideFrame);
    expect(withSecond.scene.formatOverrides?.ig_square?.title).toEqual({ x: 1, y: 1, w: 5, h: 5 });
  });

  // Revue Tâche 5 (Minor à combler) : le test ci-dessus varie le FORMAT entre les deux appels, ce qui
  // ne peut PAS attraper une réutilisation mutée de la carte INTERNE par format
  // (`formatOverrides[format]`) — seul un DEUXIÈME appel au MÊME format, sur un AUTRE calque, y touche.
  // Si l'implémentation faisait `Object.assign(state.scene.formatOverrides[format], {...})` au lieu de
  // `{ ...state.scene.formatOverrides[format], [layerId]: frame }`, la SECONDE action muterait en place
  // l'objet que la PREMIÈRE action a déjà rangé dans `withFirst.scene` (et que l'historique de
  // `withSecond` garde vivant à `past[1].scene`, par référence) — cette scène passée gagnerait alors
  // silencieusement l'entrée de la seconde action, alors qu'elle est censée être figée pour toujours.
  it("DEUX surcharges au MÊME format, calques DIFFÉRENTS : la scène de la PREMIÈRE (vivante dans l'historique de la seconde) reste inchangée — pas de carte interne réutilisée-mutée", () => {
    const state = makeState();
    const withFirst = editorReducer(state, setFrameOverride("story", "badge", overrideFrame));
    // Gardé par référence — c'est CET objet précis que `withSecond.past[1].scene` doit toujours être.
    const firstScene = withFirst.scene;

    const secondFrame = { x: 3, y: 3, w: 33, h: 33 };
    const withSecond = editorReducer(withFirst, setFrameOverride("story", "title", secondFrame));

    // La scène de la première action n'a PAS gagné l'entrée « title » de la seconde.
    expect(firstScene.formatOverrides?.story).toEqual({ badge: overrideFrame });
    expect(firstScene.formatOverrides?.story?.title).toBeUndefined();
    // …et c'est bien CETTE MÊME référence que l'historique de la seconde action a empilée : un undo
    // depuis `withSecond` y reviendrait, donc si elle avait été mutée, l'undo « restaurerait » un état
    // qui n'a jamais existé.
    expect(withSecond.past[1].scene).toBe(firstScene);
    expect(withSecond.past[1].scene.formatOverrides?.story?.title).toBeUndefined();

    // La scène COURANTE de la seconde action, elle, porte bien les DEUX entrées — c'est elle qui doit
    // accumuler, pas la précédente.
    expect(withSecond.scene.formatOverrides?.story).toEqual({ badge: overrideFrame, title: secondFrame });
  });
});

// `frameEditAction` — le routeur home-vs-surcharge (chantier D, tâche 5). Aucune surface d'édition
// non-accueil n'existe encore dans l'interface (render-mode.tsx#sceneForFormat n'est qu'un APERÇU
// lecture seule — voir son commentaire d'en-tête) : cette fonction est donc, pour l'instant, la
// SEULE consommation de l'invariant « éditer au format d'accueil édite toujours layer.frame », ici
// exercée directement par le test plutôt que par un composant qui n'a pas encore de raison d'exister.
describe("frameEditAction — édite layer.frame au format d'accueil, une surcharge sinon", () => {
  it("au format D'ACCUEIL, produit la MÊME action que resizeLayer (édite layer.frame)", () => {
    const action = frameEditAction("website_featured", "website_featured", "badge", { x: 1, y: 1, w: 2, h: 2 });
    expect(action).toEqual(resizeLayer("badge", { x: 1, y: 1, w: 2, h: 2 }));
  });

  it("à un format NON-ACCUEIL, produit setFrameOverride (édite la surcharge, pas layer.frame)", () => {
    const action = frameEditAction("website_featured", "story", "badge", { x: 1, y: 1, w: 2, h: 2 });
    expect(action).toEqual(setFrameOverride("story", "badge", { x: 1, y: 1, w: 2, h: 2 }));
  });

  it("appliqué au réducteur : le format d'accueil édite layer.frame, un autre format écrit la surcharge", () => {
    const state = makeState();
    const homeFrameBefore = { ...find(state, "badge").frame };
    const otherFrame = { x: 9, y: 9, w: 42, h: 42 };

    const atHome = editorReducer(state, frameEditAction("website_featured", "website_featured", "badge", { x: 7, y: 7, w: 20, h: 20 }));
    expect(find(atHome, "badge").frame).toEqual({ x: 7, y: 7, w: 20, h: 20 });
    expect(atHome.scene.formatOverrides).toBeUndefined();

    const atOther = editorReducer(state, frameEditAction("website_featured", "story", "badge", otherFrame));
    expect(find(atOther, "badge").frame).toEqual(homeFrameBefore);
    expect(atOther.scene.formatOverrides?.story?.badge).toEqual(otherFrame);
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

  // ───────────────────────────────────────────────────────────────────────────
  // Tâche 3 (U2) — « annuler/rétablir restaure la sélection qui existait ». C'est une propriété
  // FORTE, pas la reformulation de l'ancien comportement : avant cette tâche, undo/redo REPORTAIT
  // simplement la sélection courante (`selectedId: state.selectedId`), ce qui rendait la propriété
  // vraie à vide. Chaque test ci-dessous distingue les deux : la sélection courante au moment de
  // l'annulation DIFFÈRE de celle qui existait au moment de la modification annulée.
  describe("annuler/rétablir restaure la sélection QUI EXISTAIT (pas la sélection courante)", () => {
    it("une sélection changée APRÈS la modification est bien remplacée par celle d'alors", () => {
      const state = { ...makeState(), selectedIds: ["title"] };
      const afterMove = editorReducer(state, moveLayer("badge", 10, 0));
      // L'utilisateur sélectionne autre chose, PUIS annule.
      const afterSelect = editorReducer(afterMove, selectMany(["badge", "qr1"]));
      const afterUndo = editorReducer(afterSelect, undo());
      // Report simple de la sélection courante -> ["badge", "qr1"] et ce test tombe.
      expect(afterUndo.selectedIds).toEqual(["title"]);
      // Rétablir ramène symétriquement la sélection d'AVANT l'annulation.
      const afterRedo = editorReducer(afterUndo, redo());
      expect(afterRedo.selectedIds).toEqual(["badge", "qr1"]);
      expect(afterRedo.scene).toEqual(afterMove.scene);
    });

    it("annuler un addLayer rend la sélection d'AVANT l'ajout — pas un id qui ne serait plus dans la scène", () => {
      const state = makeState();
      const afterAdd = editorReducer(state, addLayer("shape"));
      const addedId = afterAdd.scene.layers.at(-1)!.id;
      expect(afterAdd.selectedIds).toEqual([addedId]);

      const afterUndo = editorReducer(afterAdd, undo());
      expect(afterUndo.scene.layers.some((l) => l.id === addedId)).toBe(false);
      // Le vrai défaut que ceci ferme : reporter la sélection courante laisserait `[addedId]`, une
      // référence vers un calque qui n'existe PLUS dans la scène restaurée.
      expect(afterUndo.selectedIds).toEqual([]);

      const afterRedo = editorReducer(afterUndo, redo());
      expect(afterRedo.selectedIds).toEqual([addedId]);
    });

    it("annuler la suppression d'un calque sélectionné le remet DANS la sélection", () => {
      const state = { ...makeState(), selectedIds: ["badge", "title"] };
      const afterDelete = editorReducer(state, deleteLayer("badge"));
      expect(afterDelete.selectedIds).toEqual(["title"]);

      const afterUndo = editorReducer(afterDelete, undo());
      expect(afterUndo.scene.layers.some((l) => l.id === "badge")).toBe(true);
      expect(afterUndo.selectedIds).toEqual(["badge", "title"]);
    });

    it("toute sélection, y compris MULTIPLE, traverse une modification sans changer", () => {
      const state = { ...makeState(), selectedIds: ["title", "badge"] };
      const next = editorReducer(state, setLayerProp("qr1", { margin: 8 }));
      expect(next.selectedIds).toEqual(["title", "badge"]);
    });
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
    editorReducer(initial, setFrames([
      { id: "badge", frame: { x: 1, y: 2, w: 3, h: 4 } },
      { id: "title", frame: { x: 5, y: 6, w: 7, h: 8 } },
    ]));
    editorReducer(initial, setFrameOverride("story", "badge", { x: 9, y: 9, w: 42, h: 42 }));
    editorReducer(initial, toggleVisible("badge"));
    editorReducer(initial, toggleLocked("locked1"));
    editorReducer(initial, select("title"));
    editorReducer(initial, selectMany(["title", "badge"]));
    editorReducer(initial, toggleSelection("badge"));
    editorReducer(initial, clearSelection());
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
