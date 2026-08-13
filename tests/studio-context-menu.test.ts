// tests/studio-context-menu.test.ts — Chantier B, Tâche 7 : le menu contextuel du clic droit.
//
// Deux blocs, sur le modèle de tests/studio-floating-toolbar.test.ts (Tâche 6, voir son en-tête) :
//
//  1. `layerContextMenuActions`/`canvasContextMenuActions` (lib/studio/context-menu-actions.ts) —
//     AUCUN DOM, des littéraux de calques (Étape 1 du brief).
//  2. `Canvas` + `CanvasContextMenu` montés ENSEMBLE (comme editor-shell.tsx les câble) via
//     tests/dom-harness.ts — la COMPOSITION : qu'un VRAI clic droit sélectionne la cible, ouvre le
//     VRAI menu base-ui, et qu'un VRAI clic sur une entrée dispatche l'action attendue (Étape 3).
//
// ── POURQUOI CE FICHIER A BESOIN DES MÊMES GLOBALS SUPPLÉMENTAIRES QUE LE SEAM POPOVER
// (tests/studio-interactions.test.ts) ────────────────────────────────────────────────────────────
// `CanvasContextMenu` (components/studio/canvas-context-menu.tsx) construit un VRAI `Menu` base-ui
// (@base-ui/react/menu, la même famille floating-ui-react que le Select/Popover déjà documentés
// là-bas) dès qu'il est monté OUVERT (jamais avant : voir son garde `if (!anchor) return null`, qui
// évite le problème « construit même fermé » que Select pose ailleurs) — `Element` (bare),
// `getComputedStyle` (bare), `requestAnimationFrame`/`cancelAnimationFrame` et `ResizeObserver` sont
// nécessaires pour que ce montage RÉUSSISSE plutôt que de lever une `ReferenceError` dès le premier
// rendu. Mêmes quatre/cinq globals, même recette — voir studio-interactions.test.ts pour le détail
// de CE que chacun débloque.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import React from "react";
import type { Layer, Scene } from "@/lib/studio/scene";
import {
  layerContextMenuActions, canvasContextMenuActions, type ContextMenuAction,
} from "@/lib/studio/context-menu-actions";
import { editorReducer, initEditorState, type EditorAction, type EditorState } from "@/lib/studio/editor-state";
import { clearClipboard, readClipboard } from "@/lib/studio/clipboard";
import { installDom, mount, click, contextMenu } from "./dom-harness";

// ── LA SONDE useIsoLayoutEffect (même recette que tests/studio-interactions.test.ts — lire son
// en-tête pour l'explication complète de l'incident avant de toucher ce bloc) ───────────────────────
// `CanvasContextMenu` (Bloc 2 plus bas) construit un VRAI `Menu` base-ui — la MÊME famille
// floating-ui-react que le Popover/Select déjà documentés là-bas, donc la MÊME vulnérabilité : si un
// AUTRE fichier de test, exécuté AVANT celui-ci dans le même process `bun test` SANS `--isolate` (le
// mode par défaut de ce dépôt), a statiquement importé un composant de cette famille sans jamais
// appeler `installDom()` en premier, `useIsoLayoutEffect` se fige en no-op pour le RESTE du process —
// et le Popup de ce menu ne s'ouvre alors plus jamais réellement. C'est SILENCIEUX (aucun test ne
// LÈVE ; ils cessent seulement de trouver ce qu'ils cherchent dans le DOM), donc le Bloc 2 entier est
// SAUTÉ (`it.skipIf`, jamais un retour anticipé qui se lirait comme un succès) si cette sonde échoue
// — vérifié empiriquement : `bun test --isolate tests/studio-*.test.ts` fait tourner CE fichier pour
// de vrai (toute la suite passe alors 0 fail), là où le mode par défaut de ce dépôt le saute selon
// l'ordre — NI alphabétique NI l'ordre CLI, voir studio-interactions.test.ts — dans lequel bun
// exécute les ~68 fichiers de la suite. AUCUN rapport avec canvas.tsx lui-même (qui n'importe rien de
// cette famille, voir tests/studio-no-popover-in-canvas.test.ts) : c'est une limite CONNUE et déjà
// ACCEPTÉE de faire tourner `bun test` sans `--isolate`, pas une régression introduite par cette
// tâche — voir task-7-report.md.
let popoverEffectsLive = false;
{
  const probeTeardown = installDom();
  try {
    const { useIsoLayoutEffect } = await import("@base-ui/utils/useIsoLayoutEffect");
    let ran = false;
    function Probe() {
      useIsoLayoutEffect(() => { ran = true; }, []);
      return null;
    }
    const { unmount } = await mount(React.createElement(Probe));
    unmount();
    popoverEffectsLive = ran;
  } finally {
    probeTeardown();
  }
}
if (!popoverEffectsLive) {
  console.warn(
    "\n[tests/studio-context-menu.test.ts] Composition Canvas+CanvasContextMenu (Bloc 2) : SAUTÉE " +
    "(pas verte par défaut). @base-ui/utils/useIsoLayoutEffect.mjs a été figé sur un no-op par un " +
    "autre fichier de test exécuté avant celui-ci dans ce même process `bun test` — voir " +
    "tests/studio-interactions.test.ts pour l'explication complète. Relancez avec `bun test " +
    "--isolate …` (ou `--parallel`) pour que ce fichier reçoive un registre de modules neuf et que " +
    "ces tests s'exécutent réellement — voir task-7-report.md.\n",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloc 1 — `layerContextMenuActions`/`canvasContextMenuActions`, PUR (Étape 1 du brief).

function shapeLayer(overrides: Partial<Layer> & Record<string, unknown> = {}): Layer {
  return {
    id: "s1", name: "Forme", visible: true, locked: false,
    frame: { x: 0, y: 0, w: 100, h: 100 },
    type: "shape", shape: "rect", fill: "#123456",
    ...overrides,
  } as Layer;
}

function kinds(actions: ContextMenuAction[]): string[] {
  return actions.map((a) => a.kind);
}

describe("canvasContextMenuActions — le canevas VIDE (spec §5 verbatim : « paste + select-all only »)", () => {
  it("renvoie EXACTEMENT [paste, selectAll], dans cet ordre — jamais les verbes d'un calque", () => {
    expect(kinds(canvasContextMenuActions())).toEqual(["paste", "selectAll"]);
  });
});

describe("layerContextMenuActions — UN calque seul (pas de groupement possible)", () => {
  it("porte copier/coller/dupliquer/avancer/reculer/verrouiller/masquer/supprimer, jamais grouper/dégrouper", () => {
    const target = shapeLayer({ id: "a" });
    const ks = kinds(layerContextMenuActions(target, [target]));
    expect(ks).toEqual(["copy", "paste", "duplicate", "bringForward", "sendBackward", "lock", "hide", "delete"]);
  });

  it("« Verrouiller » si la cible n'est pas verrouillée, « Déverrouiller » sinon — la cible, jamais la sélection", () => {
    const unlocked = shapeLayer({ id: "a", locked: false });
    const locked = shapeLayer({ id: "a", locked: true });
    expect(layerContextMenuActions(unlocked, [unlocked]).find((a) => a.kind === "lock")?.label).toBe("Verrouiller");
    expect(layerContextMenuActions(locked, [locked]).find((a) => a.kind === "lock")?.label).toBe("Déverrouiller");
  });

  it("« Masquer » si la cible est visible, « Afficher » sinon", () => {
    const visible = shapeLayer({ id: "a", visible: true });
    const hidden = shapeLayer({ id: "a", visible: false });
    expect(layerContextMenuActions(visible, [visible]).find((a) => a.kind === "hide")?.label).toBe("Masquer");
    expect(layerContextMenuActions(hidden, [hidden]).find((a) => a.kind === "hide")?.label).toBe("Afficher");
  });
});

describe("layerContextMenuActions — grouper/dégrouper suit la MÊME règle que toolbar-actions.ts#groupOrUngroup (Tâche 6)", () => {
  it("sélection AD HOC de deux calques (pas de groupId partagé) -> propose GROUPER", () => {
    const a = shapeLayer({ id: "a" });
    const b = shapeLayer({ id: "b" });
    const ks = kinds(layerContextMenuActions(a, [a, b]));
    expect(ks).toContain("group");
    expect(ks).not.toContain("ungroup");
  });

  it("sélection = un GROUPE ENTIER (même groupId partagé) -> propose DÉGROUPER, pas grouper", () => {
    const a = shapeLayer({ id: "a", groupId: "g1" });
    const b = shapeLayer({ id: "b", groupId: "g1" });
    const ks = kinds(layerContextMenuActions(a, [a, b]));
    expect(ks).toContain("ungroup");
    expect(ks).not.toContain("group");
  });

  it("cible SEULE mais sélection à un seul calque -> ni grouper ni dégrouper, même avec un groupId", () => {
    const a = shapeLayer({ id: "a", groupId: "g1" });
    const ks = kinds(layerContextMenuActions(a, [a]));
    expect(ks).not.toContain("group");
    expect(ks).not.toContain("ungroup");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bloc 2 — composition réelle : `Canvas` + `CanvasContextMenu`, câblés comme editor-shell.tsx
// (Étape 3 du brief).

function makeScene(): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 800, height: 600, background: "#000000" },
    layers: [
      shapeLayer({ id: "a", frame: { x: 40, y: 40, w: 100, h: 100 } }),
      shapeLayer({ id: "b", frame: { x: 200, y: 40, w: 100, h: 100 } }),
    ],
  };
}

function groupedScene(): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 800, height: 600, background: "#000000" },
    layers: [
      shapeLayer({ id: "a", groupId: "g1", frame: { x: 40, y: 40, w: 100, h: 100 } }),
      shapeLayer({ id: "b", groupId: "g1", frame: { x: 200, y: 40, w: 100, h: 100 } }),
    ],
  };
}

function installExtraGlobals(): () => void {
  const g = globalThis as unknown as Record<string, unknown> & { window: Record<string, unknown> };
  const snapshot = new Map<string, { had: boolean; value: unknown }>();
  const set = (key: string, value: unknown) => {
    snapshot.set(key, { had: Object.prototype.hasOwnProperty.call(g, key), value: g[key] });
    g[key] = value;
  };

  set("Element", g.window.Element);
  set("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number);
  set("cancelAnimationFrame", (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>));
  set("getComputedStyle", (g.window.getComputedStyle as (...a: unknown[]) => unknown).bind(g.window));
  set(
    "ResizeObserver",
    class {
      constructor(_cb: ResizeObserverCallback) {}
      observe(_target: Element): void {}
      unobserve(_target: Element): void {}
      disconnect(): void {}
    },
  );

  return () => {
    for (const [key, prior] of snapshot) {
      if (prior.had) g[key] = prior.value;
      else delete g[key];
    }
  };
}

let teardownDom: () => void;
let teardownExtraGlobals: () => void;
let CanvasC: typeof import("@/components/studio/canvas").Canvas;
let CanvasContextMenuC: typeof import("@/components/studio/canvas-context-menu").CanvasContextMenu;

beforeAll(async () => {
  teardownDom = installDom();
  teardownExtraGlobals = installExtraGlobals();
  ({ Canvas: CanvasC } = await import("@/components/studio/canvas"));
  ({ CanvasContextMenu: CanvasContextMenuC } = await import("@/components/studio/canvas-context-menu"));
});

afterAll(() => {
  teardownExtraGlobals();
  teardownDom();
});

// Le presse-papiers en session (lib/studio/clipboard.ts) est un singleton de MODULE, partagé par
// tout le processus `bun test` (voir son en-tête) — vidé entre chaque test de ce fichier pour
// qu'aucun « Coller » d'un test n'hérite du « Copier » d'un précédent.
afterEach(() => {
  clearClipboard();
});

interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
  targetLayerId: string | null;
}

/** Monte `Canvas` + `CanvasContextMenu` câblés EXACTEMENT comme editor-shell.tsx les câble (voir son
 * commentaire « Menu contextuel du clic droit ») : un VRAI `useReducer` au-dessus, et l'état
 * `{open,x,y,targetLayerId}` géré ICI, jamais par `Canvas` (le mandat de conception de la tâche).
 * `box` expose l'état et les actions dispatchées, comme `mountCanvasWithReducer` ailleurs. */
async function mountWithContextMenu(scene: Scene, initialSelection: string[] = []) {
  const initial: EditorState = { ...initEditorState(scene), selectedIds: initialSelection };
  const box: { state: EditorState; actions: EditorAction[] } = { state: initial, actions: [] };

  function Host() {
    const [state, rawDispatch] = React.useReducer(editorReducer, initial);
    const [menu, setMenu] = React.useState<ContextMenuState>({ open: false, x: 0, y: 0, targetLayerId: null });
    box.state = state;
    const dispatch = (a: EditorAction) => { box.actions.push(a); rawDispatch(a); };
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(CanvasC, {
        scene: state.scene,
        selectedIds: state.selectedIds,
        dispatch,
        scale: 1,
        onContextMenu: (payload: { x: number; y: number; targetLayerId: string | null }) =>
          setMenu({ open: true, ...payload }),
      }),
      React.createElement(CanvasContextMenuC, {
        open: menu.open,
        anchor: menu.open ? { x: menu.x, y: menu.y } : null,
        targetLayerId: menu.targetLayerId,
        scene: state.scene,
        selectedIds: state.selectedIds,
        dispatch,
        onOpenChange: (open: boolean) => setMenu((m) => ({ ...m, open })),
      }),
    );
  }

  const { container, unmount } = await mount(React.createElement(Host));
  return { box, container, unmount };
}

function layerEl(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector(`[data-layer-id="${id}"]`) as HTMLElement | null;
  if (!el) throw new Error(`nœud du calque « ${id} » absent du DOM monté`);
  return el;
}

/** Le popup du menu contextuel — porté dans `document.body` par le Portal base-ui (comme le Popover
 * du seam Images, tests/studio-interactions.test.ts), jamais dans le conteneur détaché de mount(). */
function menuItem(kind: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="context-menu-${kind}"]`) as HTMLElement | null;
}

describe("Canvas + CanvasContextMenu — clic droit RÉEL sur un calque (Tâche 7, spec §5)", () => {
  it.skipIf(!popoverEffectsLive)("sélectionne la cible EN PREMIER, puis ouvre le VRAI menu base-ui (rôle ARIA, pas une sous-chaîne)", async () => {
    const { box, container, unmount } = await mountWithContextMenu(makeScene(), []);
    try {
      await contextMenu(layerEl(container, "a"), { clientX: 90, clientY: 90 });

      expect(box.state.selectedIds).toEqual(["a"]);
      // Accessibilité : le VRAI rôle base-ui, jamais une correspondance de sous-chaîne de classe.
      const popup = document.body.querySelector('[role="menu"]');
      expect(popup).not.toBeNull();
      expect(document.body.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0);

      expect(menuItem("duplicate")).not.toBeNull();
      expect(menuItem("delete")).not.toBeNull();
      // Un seul calque sélectionné -> pas de « Grouper » (moins de deux calques, même règle que T6).
      expect(menuItem("group")).toBeNull();
    } finally {
      unmount();
    }
  });

  it.skipIf(!popoverEffectsLive)("un clic droit sur un MEMBRE de groupe sélectionne le GROUPE ENTIER — le menu propose Dégrouper", async () => {
    const { box, container, unmount } = await mountWithContextMenu(groupedScene(), []);
    try {
      await contextMenu(layerEl(container, "a"), { clientX: 90, clientY: 90 });

      expect(box.state.selectedIds).toEqual(["a", "b"]);
      expect(menuItem("ungroup")).not.toBeNull();
      expect(menuItem("group")).toBeNull();
    } finally {
      unmount();
    }
  });

  it.skipIf(!popoverEffectsLive)("un clic droit sur un calque déjà membre d'une sélection Maj-clic ad hoc GARDE cette sélection (ne la réduit pas au groupe)", async () => {
    const scene = makeScene(); // "a" et "b" SANS groupId partagé
    const { box, container, unmount } = await mountWithContextMenu(scene, ["a", "b"]);
    try {
      await contextMenu(layerEl(container, "a"), { clientX: 90, clientY: 90 });

      expect(box.state.selectedIds).toEqual(["a", "b"]);
      // AUCUNE action "select"/"selectMany" n'a été redispatchée : la sélection était déjà celle-là.
      expect(box.actions.length).toBe(0);
    } finally {
      unmount();
    }
  });

  it.skipIf(!popoverEffectsLive)("clic droit sur le canevas VIDE -> UNIQUEMENT Coller + Sélectionner tout, jamais les verbes d'un calque", async () => {
    const { container, unmount } = await mountWithContextMenu(makeScene(), []);
    try {
      const root = container.querySelector('[data-testid="studio-canvas"]') as HTMLElement;
      await contextMenu(root, { clientX: 700, clientY: 500 });

      expect(menuItem("paste")).not.toBeNull();
      expect(menuItem("selectAll")).not.toBeNull();
      expect(menuItem("duplicate")).toBeNull();
      expect(menuItem("delete")).toBeNull();
      expect(menuItem("lock")).toBeNull();
    } finally {
      unmount();
    }
  });

  it.skipIf(!popoverEffectsLive)("règle de repli U3 — clic droit sur un calque VERROUILLÉ tombe au TRAVERS jusqu'au menu CANEVAS", async () => {
    const scene = makeScene();
    scene.layers = [{ ...scene.layers[0], locked: true }, scene.layers[1]];
    const { box, container, unmount } = await mountWithContextMenu(scene, []);
    try {
      // Même idiome que le clic gauche traversant (studio-interactions.test.ts, « cliquer un calque
      // VERROUILLÉ ») : le clic droit est dispatché SUR le nœud du calque verrouillé lui-même — sans
      // gestionnaire `onContextMenu` propre (layer-view.tsx), il bouillonne jusqu'à la racine.
      await contextMenu(layerEl(container, "a"), { clientX: 90, clientY: 90 });

      // Ni sélectionné, ni menu de calque : le repli est TOTAL, pas seulement « pas de dispatch ».
      expect(box.state.selectedIds).toEqual([]);
      expect(menuItem("paste")).not.toBeNull();
      expect(menuItem("selectAll")).not.toBeNull();
      expect(menuItem("duplicate")).toBeNull();
      expect(menuItem("delete")).toBeNull();
    } finally {
      unmount();
    }
  });
});

describe("Canvas + CanvasContextMenu — chaque entrée dispatche la BONNE action de réducteur (mutation : pointer une entrée vers la mauvaise action fait rougir CE test)", () => {
  it.skipIf(!popoverEffectsLive)("Supprimer -> deleteLayer(CIBLE), jamais un autre calque de la sélection", async () => {
    const { box, container, unmount } = await mountWithContextMenu(makeScene(), []);
    try {
      await contextMenu(layerEl(container, "a"), { clientX: 90, clientY: 90 });
      await click(menuItem("delete")!);

      expect(box.actions.at(-1)).toEqual({ type: "deleteLayer", id: "a" });
      expect(box.state.scene.layers.map((l) => l.id)).toEqual(["b"]);
    } finally {
      unmount();
    }
  });

  it.skipIf(!popoverEffectsLive)("Avancer -> reorderLayer(CIBLE, index+1)", async () => {
    const { box, container, unmount } = await mountWithContextMenu(makeScene(), []);
    try {
      await contextMenu(layerEl(container, "a"), { clientX: 90, clientY: 90 }); // "a" est à l'index 0
      await click(menuItem("bringForward")!);

      expect(box.actions.at(-1)).toEqual({ type: "reorderLayer", id: "a", toIndex: 1 });
      expect(box.state.scene.layers.map((l) => l.id)).toEqual(["b", "a"]);
    } finally {
      unmount();
    }
  });

  it.skipIf(!popoverEffectsLive)("Reculer -> reorderLayer(CIBLE, index-1)", async () => {
    const { box, container, unmount } = await mountWithContextMenu(makeScene(), []);
    try {
      await contextMenu(layerEl(container, "b"), { clientX: 250, clientY: 90 }); // "b" est à l'index 1
      await click(menuItem("sendBackward")!);

      expect(box.actions.at(-1)).toEqual({ type: "reorderLayer", id: "b", toIndex: 0 });
      expect(box.state.scene.layers.map((l) => l.id)).toEqual(["b", "a"]);
    } finally {
      unmount();
    }
  });

  it.skipIf(!popoverEffectsLive)("Verrouiller -> toggleLocked(CIBLE)", async () => {
    const { box, container, unmount } = await mountWithContextMenu(makeScene(), []);
    try {
      await contextMenu(layerEl(container, "a"), { clientX: 90, clientY: 90 });
      await click(menuItem("lock")!);

      expect(box.actions.at(-1)).toEqual({ type: "toggleLocked", id: "a" });
      expect(box.state.scene.layers.find((l) => l.id === "a")?.locked).toBe(true);
    } finally {
      unmount();
    }
  });

  it.skipIf(!popoverEffectsLive)("Masquer -> toggleVisible(CIBLE)", async () => {
    const { box, container, unmount } = await mountWithContextMenu(makeScene(), []);
    try {
      await contextMenu(layerEl(container, "a"), { clientX: 90, clientY: 90 });
      await click(menuItem("hide")!);

      expect(box.actions.at(-1)).toEqual({ type: "toggleVisible", id: "a" });
      expect(box.state.scene.layers.find((l) => l.id === "a")?.visible).toBe(false);
    } finally {
      unmount();
    }
  });

  it.skipIf(!popoverEffectsLive)("Grouper -> setGroup([...sélection], groupId NEUF)", async () => {
    const { box, container, unmount } = await mountWithContextMenu(makeScene(), ["a", "b"]);
    try {
      await contextMenu(layerEl(container, "a"), { clientX: 90, clientY: 90 });
      await click(menuItem("group")!);

      const action = box.actions.at(-1) as { type: string; ids: string[]; groupId: string | null };
      expect(action.type).toBe("setGroup");
      expect(action.ids.sort()).toEqual(["a", "b"]);
      expect(action.groupId).not.toBeNull();
      expect(box.state.scene.layers.every((l) => l.groupId === action.groupId)).toBe(true);
    } finally {
      unmount();
    }
  });

  it.skipIf(!popoverEffectsLive)("Dégrouper -> setGroup([membres du groupe], null)", async () => {
    const { box, container, unmount } = await mountWithContextMenu(groupedScene(), []);
    try {
      await contextMenu(layerEl(container, "a"), { clientX: 90, clientY: 90 }); // étend à ["a","b"]
      await click(menuItem("ungroup")!);

      expect(box.actions.at(-1)).toEqual({ type: "setGroup", ids: ["a", "b"], groupId: null });
      expect(box.state.scene.layers.every((l) => l.groupId === undefined)).toBe(true);
    } finally {
      unmount();
    }
  });

  it.skipIf(!popoverEffectsLive)("Copier PUIS Coller — le MÊME chemin presse-papiers que ⌘C/⌘V (lib/studio/clipboard.ts), décalage PASTE_OFFSET", async () => {
    const { box, container, unmount } = await mountWithContextMenu(makeScene(), []);
    try {
      await contextMenu(layerEl(container, "a"), { clientX: 90, clientY: 90 });
      await click(menuItem("copy")!);
      expect(readClipboard().map((l) => l.id)).toEqual(["a"]); // le presse-papiers EN SESSION a bien reçu la cible

      await contextMenu(layerEl(container, "b"), { clientX: 250, clientY: 90 });
      await click(menuItem("paste")!);

      const pasted = box.state.scene.layers.find((l) => l.id !== "a" && l.id !== "b");
      expect(pasted).toBeDefined();
      expect(pasted!.frame).toEqual({ x: 40 + 16, y: 40 + 16, w: 100, h: 100 }); // PASTE_OFFSET = {dx:16,dy:16}
    } finally {
      unmount();
    }
  });

  it.skipIf(!popoverEffectsLive)("Dupliquer sur un GROUPE ENTIER produit un lot de MÊME taille avec un groupId NEUF, séparé de la source (T5 fixé)", async () => {
    const { box, container, unmount } = await mountWithContextMenu(groupedScene(), []);
    try {
      const before = box.state.scene.layers.length; // 2

      await contextMenu(layerEl(container, "a"), { clientX: 90, clientY: 90 }); // étend à ["a","b"]
      await click(menuItem("duplicate")!);

      expect(box.state.scene.layers.length).toBe(before + 2); // 4 -> "4→ more" (brief)
      const clones = box.state.scene.layers.filter((l) => l.id !== "a" && l.id !== "b");
      expect(clones.length).toBe(2);
      const cloneGroupIds = new Set(clones.map((l) => l.groupId));
      expect(cloneGroupIds.size).toBe(1); // les deux clones PARTAGENT un groupId...
      expect([...cloneGroupIds][0]).not.toBe("g1"); // ...NEUF, JAMAIS celui de la source (fusion, T5).
    } finally {
      unmount();
    }
  });
});
