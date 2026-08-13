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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { installDom, mount, click, flush, pointer } from "./dom-harness";
import { parseScene, type Layer, type Scene } from "@/lib/studio/scene";
import { LayerView } from "@/components/studio/layer-view";
import { editorReducer, initEditorState, type EditorAction, type EditorState } from "@/lib/studio/editor-state";

// Properties Pro P1, Tâche 5 — l'INSPECTEUR (ImageFields, property-panel.tsx). Même sonde
// `popoverEffectsLive` que tests/studio-interactions.test.ts (voir son commentaire d'en-tête pour le
// détail complet) : le sélecteur « Ajustement » est un VRAI `<Select>` Base UI (components/ui/select.tsx),
// dont le popup se portale dans `document.body` UNIQUEMENT une fois ouvert, via un effet
// (`@base-ui/utils/useIsoLayoutEffect`) qui se fige en no-op pour tout le processus `bun test` dès
// qu'un AUTRE fichier de test a rendu un composant touchant `Button`/`Select` SANS jamais poser de DOM
// avant celui-ci. Sonder ICI (plutôt que faire confiance à l'ordre d'exécution des fichiers, qui n'est
// ni alphabétique ni celui de la ligne de commande) et sauter les tests d'interaction réelle si le
// popup ne peut pas s'ouvrir dans CE process — jamais un faux vert qui ne prouverait plus rien.
//
// `PropertyPanel` (comme `layer-view.tsx#LayerView` juste au-dessus) importe transitivement
// `components/ui/select.tsx`/`components/ui/button.tsx` (Base UI) : un import STATIQUE ici, avant la
// sonde, évaluerait ces modules — donc figerait `useIsoLayoutEffect` — AVANT que `installDom()` n'ait
// jamais tourné, empoisonnant la sonde par CE fichier lui-même plutôt que par un voisin. Import
// DYNAMIQUE dans `beforeAll` (après `installDom()`), même recette que
// tests/studio-interactions.test.ts#PropertyPanelC.
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
    "\n[tests/studio-image-fields.test.ts] Inspecteur image (sélecteur Ajustement) : les tests " +
    "d'interaction RÉELLE sont SAUTÉS — voir tests/studio-interactions.test.ts pour l'explication " +
    "complète (useIsoLayoutEffect figé en no-op par un autre fichier). Relancez avec `bun test " +
    "--isolate` pour les exécuter.\n",
  );
}

// Globals que jsdom 30 (sans `pretendToBeVisual`) ne fournit pas et que `installDom()` n'installe
// pas — mêmes globals, même raison, que tests/studio-inspector-integration.test.ts#installExtraGlobals :
// `PropertyPanel` monte un `ColorField` (voile de l'image) qui embarque un `<ColorPicker>` (Popover
// floating-ui-react), qui fait `value instanceof Element` (le global BARE) et planifie un calcul de
// positionnement via `requestAnimationFrame`/`getComputedStyle` DÈS le montage, même popup fermé.
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

  return () => {
    for (const [key, prior] of snapshot) {
      if (prior.had) g[key] = prior.value;
      else delete g[key];
    }
  };
}

let teardownDom: () => void;
let teardownExtraGlobals: () => void;
let PropertyPanelC: typeof import("@/components/studio/property-panel").PropertyPanel;
beforeAll(async () => {
  teardownDom = installDom();
  teardownExtraGlobals = installExtraGlobals();
  ({ PropertyPanel: PropertyPanelC } = await import("@/components/studio/property-panel"));
});
afterAll(() => { teardownExtraGlobals(); teardownDom(); });

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

// ────────────────────────────────────────────────────────────────────────────────────────────────
// RÉGRESSION (revue) — Règle des Hooks : `useNaturalSize` doit s'exécuter à CHAQUE rendu de
// `ImageContent`, jamais seulement quand une branche `return`-placeholder n'a pas déjà eu lieu.
//
// SCÉNARIO REPRODUIT PAR LA REVUE : un calque `source.kind === "asset"` peint SOUVENT avec la prop
// `image` encore `undefined` au premier rendu — sa résolution passe par `images?.get(layer.id)`
// (canvas.tsx), ASYNCHRONE — puis un rendu SUIVANT, sur la MÊME fibre React (`LayerView` est keyée
// par `layer.id`, jamais remontée pour ce même calque), lui passe l'URL enfin résolue. Si le hook est
// posé APRÈS les `return` de placeholder (comme la première version de cette tâche le faisait), le
// premier rendu (sans `src`) ne l'exécute PAS du tout, le second (avec `src`) l'exécute — le NOMBRE
// de hooks appelés diverge d'un rendu à l'autre sur la même fibre, ce que React interdit
// (« Rendered more hooks than during the previous render »). Reproduit ci-dessous SANS `mount()` du
// harnais (qui crée une fibre fraîche par appel) : un `createRoot` brut, ré-utilisé pour DEUX
// `root.render()` successifs sur le MÊME conteneur — exactement ce que fait React en production pour
// deux rendus de la même instance.
describe("ImageContent — régression Règle des Hooks : un calque asset dont l'image résout APRÈS le premier rendu", () => {
  it("undefined → URL sur la MÊME fibre ne lève PAS d'erreur React (ordre de hooks stable)", async () => {
    // `sizing:\"tile\", scale:2` — le cas qui déclenche `useNaturalSize` (`needsNaturalSize`), donc le
    // seul où la présence/absence du hook peut concrètement varier entre les deux rendus ci-dessous.
    const layer = imageLayer({
      source: { kind: "asset", assetId: "a1" },
      sizing: "tile",
      tile: { scale: 2, axis: "both" },
    });

    const container = document.createElement("div");
    const root = createRoot(container);
    let caught: unknown = null;

    // React ne fait pas TOUJOURS remonter une violation de l'ordre des hooks comme une exception qui
    // traverse `act()` — reproduit à la main (voir task-4-report.md) : contre le code d'AVANT ce
    // correctif, la même séquence de rendus n'a PAS levé, mais a émis
    // « Internal React error: Expected static flag was missing. Please notify the React team. » via
    // `console.error`. Un `try/catch` seul aurait donc laissé passer une régression FUTURE qui
    // reproduirait le même défaut sans (re)lever — on capture aussi la sortie `console.error`.
    const originalConsoleError = console.error;
    const consoleErrors: string[] = [];
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    };

    try {
      // Premier rendu : `image` ABSENT (asset pas encore résolu) — `ImageContent` retourne le
      // `Placeholder` (source manquante).
      await act(async () => {
        root.render(
          React.createElement(LayerView, { layer, frame: FRAME, rotation: 0, selected: false, image: undefined }),
        );
      });

      // Second rendu, MÊME `root` (donc même fibre) : l'asset a résolu, `image` porte maintenant une
      // URL — `ImageContent` peint désormais le `<div>` de fond, ET son hook `useNaturalSize`.
      await act(async () => {
        root.render(
          React.createElement(LayerView, { layer, frame: FRAME, rotation: 0, selected: false, image: "https://x.test/asset.png" }),
        );
      });
    } catch (e) {
      caught = e;
    } finally {
      console.error = originalConsoleError;
    }

    // Avant le correctif : soit `caught` porte l'invariant React (hook order), soit — le cas
    // OBSERVÉ en pratique pour ce scénario précis — React récupère silencieusement en interne mais
    // consigne « Internal React error: Expected static flag was missing » sur `console.error`. Après
    // le correctif : ni l'un ni l'autre, et le second rendu a bien peint le contenu attendu — pas
    // seulement « n'a rien levé ».
    expect(caught).toBeNull();
    expect(consoleErrors.join("\n")).not.toMatch(/hook|static flag|Rendered (more|fewer)/i);
    expect(container.querySelector('[data-testid="image-content"]')).not.toBeNull();

    act(() => { root.unmount(); });
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Properties Pro P1, Tâche 5 — l'INSPECTEUR : le sélecteur « Ajustement » (property-panel.tsx#ImageFields)
// écrit `sizing` (les CINQ modes du schéma, T2), et les contrôles mosaïque/perso n'apparaissent QUE
// dans leur mode respectif. Task 6 (le sélecteur de point focal) est HORS PÉRIMÈTRE ici.
//
// Monte le VRAI `PropertyPanel` derrière un VRAI `editorReducer` — même recette que
// tests/studio-interactions.test.ts#mountPropertyPanelWithReducer — pour committer à travers le VRAI
// `setLayerProp` plutôt qu'un `onCommit` observé par introspection (spec §0 : « calling a handler
// directly is what the five uncovered seams already fail to catch »).
function sceneWithImage(layer: Extract<Layer, { type: "image" }>): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 1080, height: 1080, background: "#111111" },
    layers: [layer],
  };
}

function baseImageLayer(overrides: Partial<Extract<Layer, { type: "image" }>> = {}): Layer {
  return {
    id: "img1", name: "Image", visible: true, locked: false,
    frame: { x: 0, y: 0, w: 300, h: 200 },
    type: "image", source: { kind: "url", url: "https://x.test/photo.png" }, fit: "cover",
    ...overrides,
  } as Layer;
}

async function mountImageFields(layer: Layer) {
  const initial: EditorState = initEditorState(sceneWithImage(layer as Extract<Layer, { type: "image" }>));
  initial.selectedIds = ["img1"];
  const box: { state: EditorState; actions: EditorAction[] } = { state: initial, actions: [] };

  function Host() {
    const [state, rawDispatch] = React.useReducer(editorReducer, initial);
    box.state = state;
    return React.createElement(PropertyPanelC, {
      scene: state.scene,
      selectedIds: state.selectedIds,
      context: "social_post",
      dispatch: (a: EditorAction) => { box.actions.push(a); rawDispatch(a); },
    });
  }

  const { container, unmount } = await mount(React.createElement(Host));
  return {
    box,
    container,
    unmount,
    html: () => container.innerHTML,
    layer: () => box.state.scene.layers.find((l) => l.id === "img1") as Extract<Layer, { type: "image" }>,
  };
}

/** Ouvre le VRAI `<Select>` « Ajustement » (ou tout sélecteur ciblé par `field`) et clique l'option
 * dont le libellé visible est `label` — jamais un appel direct à `onCommit`. Le popup se portale dans
 * `document.body`, jamais dans le conteneur détaché de `mount()` (même piège que
 * tests/studio-interactions.test.ts#SelectField, voir son commentaire). */
async function chooseOption(container: HTMLElement, field: string, label: string): Promise<void> {
  const trigger = container.querySelector(`[data-field="${field}"]`) as HTMLElement | null;
  if (!trigger) throw new Error(`sélecteur « ${field} » absent du DOM monté`);
  await click(trigger);
  await flush();
  const options = Array.from(document.body.querySelectorAll('[role="option"]')) as HTMLElement[];
  const option = options.find((o) => o.textContent === label);
  if (!option) throw new Error(`option « ${label} » introuvable dans le popup « ${field} »`);
  // Base UI (SelectItem.mjs#commitSelection) n'honore un simple "click" QUE pour l'option déjà
  // HIGHLIGHTED (celle sous le curseur au moment de l'ouverture, ou visée par le clavier) — un clic de
  // SOURIS sur une AUTRE option exige d'abord un "pointerdown" (qui arme `allowMouseSelectionRef`),
  // exactement le couple d'événements qu'un vrai clic de souris navigateur envoie toujours dans cet
  // ordre. Trouvé en instrumentant le VRAI composant (`node_modules/@base-ui/react/select/item/
  // SelectItem.mjs`) : un `click()` seul sur une option non survolée passait la garde
  // `isInvalidMouseClick` et ne committait RIEN — silencieusement, sans lever la moindre erreur.
  await pointer(option, "pointerdown");
  await click(option);
}

describe("ImageFields — le menu « Ajustement » écrit sizing ; les contrôles mosaïque/perso n'apparaissent que dans leur mode (Properties Pro P1, T5)", () => {
  it.skipIf(!popoverEffectsLive)(
    "état initial cover : ni les contrôles mosaïque ni les champs perso ne sont peints",
    async () => {
      const { html, unmount } = await mountImageFields(baseImageLayer({ sizing: "cover" }));
      expect(html()).not.toContain('data-field="tile-scale"');
      expect(html()).not.toContain('data-field="tile-axis"');
      expect(html()).not.toContain('data-field="custom-w"');
      expect(html()).not.toContain('data-field="custom-h"');
      unmount();
    },
  );

  it.skipIf(!popoverEffectsLive)(
    "choisir « Mosaïque » écrit sizing:\"tile\", pose un tile PAR DÉFAUT (scale 1, both) EN UNE entrée, et peint échelle+répétition",
    async () => {
      const { box, container, html, layer, unmount } = await mountImageFields(baseImageLayer({ sizing: "cover" }));

      await chooseOption(container, "sizing", "Mosaïque");

      expect(layer().sizing).toBe("tile");
      // `fit` (legacy) reste TEL QUEL pour un mode que `fit` ne sait pas exprimer — jamais réécrit.
      expect(layer().fit).toBe("cover");
      expect(layer().tile).toEqual({ scale: 1, axis: "both" });
      // UNE SEULE entrée d'historique pour ce geste unique (§0 d'en-tête property-panel.tsx).
      expect(box.state.past).toHaveLength(1);

      expect(html()).toContain('data-field="tile-scale"');
      expect(html()).toContain('data-field="tile-axis"');
      expect(html()).not.toContain('data-field="custom-w"');

      unmount();
    },
  );

  it.skipIf(!popoverEffectsLive)(
    "choisir « Taille perso » patch un customSize PAR DÉFAUT (taille du cadre) — la scène résultante passe parseScene",
    async () => {
      const { box, container, html, layer, unmount } = await mountImageFields(
        baseImageLayer({ sizing: "cover", frame: { x: 0, y: 0, w: 300, h: 200 } }),
      );

      await chooseOption(container, "sizing", "Taille perso");

      expect(layer().sizing).toBe("custom");
      expect(layer().customSize).toEqual({ w: 300, h: 200 });
      expect(box.state.past).toHaveLength(1);

      expect(html()).toContain('data-field="custom-w"');
      expect(html()).toContain('data-field="custom-h"');
      expect(html()).not.toContain('data-field="tile-scale"');

      // T3 (schéma, garde-fou) : `sizing:"custom"` SANS `customSize` est REJETÉ par `parseScene` — la
      // scène patchée ici DOIT donc le porter pour rester valide. Un aller-retour réussi EST la preuve.
      expect(() => parseScene(box.state.scene)).not.toThrow();
      expect(parseScene(box.state.scene)).toEqual(box.state.scene);

      unmount();
    },
  );

  it.skipIf(!popoverEffectsLive)(
    "un calque déjà en mode mosaïque/perso ne réécrit PAS le tile/customSize existant en choisissant à nouveau le même mode",
    async () => {
      // §0 (revue) : le correctif « pose un défaut si absent » ne doit PAS écraser un réglage DÉJÀ fait
      // par le designer (ex. échelle 2, largeur 500) — seulement combler une ABSENCE.
      const { container, layer, unmount } = await mountImageFields(baseImageLayer({
        sizing: "contain", tile: { scale: 2, axis: "x" }, customSize: { w: 500, h: 400 },
      }));

      await chooseOption(container, "sizing", "Mosaïque");
      expect(layer().tile).toEqual({ scale: 2, axis: "x" });

      await chooseOption(container, "sizing", "Taille perso");
      expect(layer().customSize).toEqual({ w: 500, h: 400 });

      unmount();
    },
  );

  it.skipIf(!popoverEffectsLive)(
    "choisir « Remplir »/« Ajuster » garde `fit` cohérent (rétrocompat) ; « Étirer » laisse `fit` INCHANGÉ",
    async () => {
      const { container, layer, unmount } = await mountImageFields(baseImageLayer({ sizing: "contain", fit: "contain" }));

      await chooseOption(container, "sizing", "Remplir");
      expect(layer().sizing).toBe("cover");
      expect(layer().fit).toBe("cover");

      await chooseOption(container, "sizing", "Étirer");
      expect(layer().sizing).toBe("stretch");
      // `fit` (legacy, ignoré dès que `sizing` est présent) reste au dernier cover/contain écrit —
      // aucun mode « stretch » n'existe dans son propre z.enum.
      expect(layer().fit).toBe("cover");

      unmount();
    },
  );

  it.skipIf(!popoverEffectsLive)(
    "§0 : un calque LEGACY (fit seul, aucun `sizing`) affiche la bonne valeur d'Ajustement dérivée de `fit`",
    async () => {
      const { container, unmount } = await mountImageFields(baseImageLayer({ fit: "contain", sizing: undefined }));
      const trigger = container.querySelector('[data-field="sizing"]') as HTMLElement;
      expect(trigger.textContent).toContain("Ajuster");
      unmount();
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Properties Pro P1, Tâche 6 — le point focal DÉPLAÇABLE (`FocalPointField`, focal-point-field.tsx),
// monté dans `ImageFields` UNIQUEMENT pour les modes où il change quelque chose de visible (cover/
// tile — voir le commentaire posé sur son montage, property-panel.tsx). Même harnais que le bloc
// « Ajustement » ci-dessus : le VRAI `PropertyPanel` derrière le VRAI `editorReducer`, un geste de
// glisser DOM réel (`pointer()`, dom-harness.ts) plutôt qu'un appel direct à `onCommit`.
describe("ImageFields — le point focal déplaçable (Properties Pro P1, T6)", () => {
  it.skipIf(!popoverEffectsLive)(
    "mode cover : la vignette du point focal est peinte",
    async () => {
      const { container, unmount } = await mountImageFields(baseImageLayer({ sizing: "cover" }));
      expect(container.querySelector('[data-testid="focal-point-field"]')).not.toBeNull();
      unmount();
    },
  );

  it.skipIf(!popoverEffectsLive)(
    "mode mosaïque : la vignette du point focal est peinte",
    async () => {
      const { container, unmount } = await mountImageFields(
        baseImageLayer({ sizing: "tile", tile: { scale: 1, axis: "both" } }),
      );
      expect(container.querySelector('[data-testid="focal-point-field"]')).not.toBeNull();
      unmount();
    },
  );

  it.skipIf(!popoverEffectsLive)(
    "mode étirer/perso : la vignette du point focal est ABSENTE (le point focal n'y change rien de visible)",
    async () => {
      const { container: stretchContainer, unmount: unmountStretch } = await mountImageFields(
        baseImageLayer({ sizing: "stretch" }),
      );
      expect(stretchContainer.querySelector('[data-testid="focal-point-field"]')).toBeNull();
      unmountStretch();

      const { container: customContainer, unmount: unmountCustom } = await mountImageFields(
        baseImageLayer({ sizing: "custom", customSize: { w: 300, h: 200 } }),
      );
      expect(customContainer.querySelector('[data-testid="focal-point-field"]')).toBeNull();
      unmountCustom();
    },
  );

  it.skipIf(!popoverEffectsLive)(
    "glisser le point focal hors bornes écrit focal x/y CLAMPÉ [0,1], UNE SEULE entrée d'historique, au relâchement seulement",
    async () => {
      const { box, container, layer, unmount } = await mountImageFields(baseImageLayer({ sizing: "cover" }));

      const field = container.querySelector('[data-testid="focal-point-field"]') as HTMLElement;
      expect(field).not.toBeNull();
      // jsdom ne mesure jamais de layout réel (getBoundingClientRect toujours à zéro) — même recette
      // que tests/studio-color-picker.test.ts (carré SV/curseur teinte) : un rectangle explicite rend
      // le ratio position->fraction déterministe.
      field.getBoundingClientRect = () => ({
        left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}),
      });

      await pointer(field, "pointerdown", { clientX: 50, clientY: 50 });
      expect(box.state.past).toHaveLength(0); // le pointerdown seul ne committe rien

      await pointer(field, "pointermove", { clientX: 200, clientY: -50 }); // hors bornes des deux côtés
      expect(box.state.past).toHaveLength(0); // ni le pointermove — jamais avant le relâchement

      await pointer(field, "pointerup", { clientX: 200, clientY: -50 });

      expect(layer().focal).toEqual({ x: 1, y: 0 }); // clampé à [0,1] : fx=2→1, fy=-0.5→0
      expect(box.state.past).toHaveLength(1); // UNE SEULE entrée d'historique pour tout le geste

      unmount();
    },
  );
});
