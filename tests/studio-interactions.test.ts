import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import React from "react";
import { installDom, mount, click, pressKey, flush, pointer } from "./dom-harness";
import { editorReducer, initEditorState, type EditorAction } from "@/lib/studio/editor-state";
import { dynamicTextRowsFor } from "@/lib/studio/dynamic-text";
import { DEFAULT_PREFS } from "@/lib/studio/editor-prefs";
import type { Scene, TextLayer } from "@/lib/studio/scene";
import type { AssetRow } from "@/lib/queries/assets";
import type { EditorShellTemplate } from "@/components/studio/editor-shell";
import type { TemplateContext } from "@/lib/studio/tokens";

// tests/studio-interactions.test.ts — U0 Tâche 2 (spec/plan §3) : ferme les cinq coutures
// d'interaction que la revue finale de U1 documentait comme non couvertes — chacune était
// mutation-survivable (un changement du gestionnaire aurait laissé la suite entière verte). Chaque
// `describe` pilote le VRAI composant avec un VRAI événement DOM (via tests/dom-harness.ts, Tâche 1)
// et vérifie une CONSÉQUENCE observable sur la scène/le rendu — jamais qu'une fonction a été
// appelée (spec « The thing to get right »).
//
// ── Le seam Images (onPick) : `@base-ui/utils/useIsoLayoutEffect.mjs`, `--isolate`, et pourquoi ce
// fichier se teste lui-même avant de tester quoi que ce soit d'autre ──────────────────────────────
//
// Le seam Images (onPick) s'exerce en cliquant une VRAIE vignette derrière le VRAI Popover de
// components/studio/asset-picker.tsx#ImageAssetPicker. Ce clic échoue à monter sa vignette (le
// Popover n'ouvre jamais son contenu, quels que soient les globals fournis) quand un AUTRE fichier
// de test — et il y en a ~20 : tout fichier qui rend un composant studio via `renderToStaticMarkup`
// SANS jamais poser de DOM, dont tests/studio-texte-panel.test.ts et tests/studio-editor-shell.test.ts
// — a importé, même statiquement et sans jamais monter de DOM, un composant touchant `Button` AVANT
// que ce fichier-ci n'ait appelé `installDom()`. Cause racine : `useIsoLayoutEffect.mjs` résout
// `typeof document !== "undefined"` UNE SEULE FOIS, à l'évaluation du module — un singleton ES
// partagé par tout le processus `bun test` — et se fige sur `noop` pour le reste du processus.
// `mock.module()` ne répare rien après coup (liaison `const`, jamais réassignée, capturée par les
// modules consommateurs déjà évalués) ; remplacer `ImageAssetPicker` par un double a été essayé et
// ABANDONNÉ, car `@/components/studio/asset-picker` est un module PARTAGÉ (aussi importé, réel et
// non modifié, par tests/studio-asset-picker.test.ts et tests/studio-property-panel.test.ts) — le
// double empoisonne alors LEURS propres imports pour le reste du processus. Bun exécute les
// fichiers dans un ordre qui n'est NI alphabétique NI l'ordre des arguments CLI (vérifié), donc rien
// dans CE fichier ne peut gagner la course contre un fichier voisin qui peut s'exécuter dans SA
// TOTALITÉ avant que la moindre ligne d'ici ne tourne.
//
// `bun test --isolate` (et `--parallel`, qui l'implique) donne à CHAQUE fichier un `globalThis` ET
// un registre de modules NEUFS — aucune dépendance nouvelle, aucun réglage dans test-setup.ts ni
// bunfig.toml. Vérifié directement contre le VRAI scénario (pas une sonde de substitution) :
//   `bun test --isolate tests/studio-interactions.test.ts tests/studio-texte-panel.test.ts tests/studio-editor-shell.test.ts`
// avec le test fort ci-dessous (clic RÉEL sur la vignette) : 20/20, et la mutation de
// `onPick={(assetId) => pickImageForSelection(selectedLayer, assetId, dispatch)}` vers
// `onPick={() => {}}` fait bien passer CE test au rouge (voir task-2-report.md pour la trace).
// L'adoption de `--isolate` pour toute la suite reste une décision du produit (package.json/
// bunfig.toml ne sont pas touchés ici) — voir task-2-report.md pour le coût/bénéfice mesuré sur la
// suite complète.
//
// Ce fichier ne peut pas lire le flag `--isolate` (absent de `process.argv`, vérifié — bun le
// consomme avant de lancer le fichier). Il mesure donc directement le SYMPTÔME, pas la cause : une
// sonde, ci-dessous, monte un composant qui utilise ce MÊME `useIsoLayoutEffect` et constate si son
// effet tourne réellement. Si non (poison par un fichier voisin — probable sans `--isolate`, exclu
// avec), le test fort qui suit est SAUTÉ (`it.skipIf`, jamais un retour silencieux qui se lirait
// comme un succès) avec un message français nommant le remède, plutôt que de retomber
// silencieusement sur un succès qui ne prouverait plus rien.
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
    "\n[tests/studio-interactions.test.ts] Seam Images onPick : le test du clic RÉEL sur la vignette " +
    "est SAUTÉ (pas vert par défaut). @base-ui/utils/useIsoLayoutEffect.mjs a été figé sur un no-op par " +
    "un autre fichier de test exécuté avant celui-ci dans ce même processus `bun test` (typeof document " +
    "était indéfini au moment de SA propre évaluation) : le Popover réel ne peut alors plus monter sa " +
    "vignette. Relancez avec `bun test --isolate …` (ou `--parallel`) pour que ce fichier reçoive un " +
    "registre de modules neuf et que ce test s'exécute réellement — voir task-2-report.md.\n",
  );
}

// Globals que jsdom 30 (sans `pretendToBeVisual`) ne fournit pas, et que la Tâche 1 n'installe pas
// (§2 du plan liste window/document/navigator/HTMLElement/Node/Event/KeyboardEvent/MouseEvent/
// IntersectionObserver/localStorage — pas ceux-ci) :
//   - `ResizeObserver` : components/studio/editor-shell.tsx en construit un RÉEL dans son effet
//     d'échelle (`new ResizeObserver(computeScale)`) — sans stub, monter EditorShell lève
//     `ReferenceError: ResizeObserver is not defined`. Le premier calcul synchrone dans l'effet
//     (avant tout redimensionnement) suffit à nos tests ; observe/unobserve/disconnect restent no-op.
//   - `Element` (bare), `requestAnimationFrame`/`cancelAnimationFrame`, `getComputedStyle` (bare) :
//     un composant de la colonne propriétés d'EditorShell (property-panel.tsx importe `Select` de
//     @/components/ui/select, un composant Popover-like de @base-ui/react) construit un contexte
//     floating-ui-react DÈS le montage, PAS seulement à l'ouverture — `floating-ui-react` fait
//     `value instanceof Element` (pas `window.Element`) et calcule un positionnement (`getComputedStyle`,
//     via une promesse planifiée par `requestAnimationFrame`) même pour un popup fermé. Sans ces
//     quatre globals, monter EditorShell lève `ReferenceError: Element/getComputedStyle/
//     requestAnimationFrame is not defined` au tout premier rendu, avant la moindre interaction.
// Supplémentés ICI (jamais dans dom-harness.ts — voir task-2-report.md pour la discussion de ce qui
// devrait, ou non, migrer vers le harnais partagé pour un futur sous-projet), restaurés à la fin.
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

// Composants réels, importés dynamiquement APRÈS installDom() — un fichier voisin (studio-editor-
// shell.test.ts, studio-texte-panel.test.ts) importe ces mêmes arbres de composants de façon
// STATIQUE, sans jamais installer de DOM ; les repousser ici protège au moins CE fichier d'un
// export React.useEffect qui verrait `typeof document === "undefined"` à SA PROPRE évaluation —
// insuffisant à lui seul pour le Popover (voir le commentaire ci-dessus), mais nécessaire pour tout
// le reste (⌘/, l'effet d'échelle), et sans coût : c'est la même recette que
// tests/studio-editor-shell.test.ts utilise déjà pour `next/navigation`.
let ImagesPanelC: typeof import("@/components/studio/panels/images-panel").ImagesPanel;
let TextePanelC: typeof import("@/components/studio/panels/texte-panel").TextePanel;
let EditorShellC: typeof import("@/components/studio/editor-shell").EditorShell;
let CanvasC: typeof import("@/components/studio/canvas").Canvas;

// `mock.module()` replaces a module in bun's process-wide registry — it does NOT scope to this
// file. Captured here so `afterAll` can put the REAL module back before any file scheduled after
// this one (in the same `bun test` process) resolves its own import of it.
let realNavigation: typeof import("next/navigation");

beforeAll(async () => {
  teardownDom = installDom();
  teardownExtraGlobals = installExtraGlobals();

  // Même recette que tests/studio-editor-shell.test.ts : editor-shell.tsx appelle useRouter()
  // (next/navigation), qui exige un arbre App Router monté — sans mock, le montage RÉEL (pas
  // seulement renderToStaticMarkup) échoue avec « invariant expected app router to be mounted ».
  realNavigation = await import("next/navigation");
  mock.module("next/navigation", () => ({
    ...realNavigation,
    useRouter: () => ({
      push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, forward: () => {}, prefetch: () => {},
    }),
  }));

  ({ ImagesPanel: ImagesPanelC } = await import("@/components/studio/panels/images-panel"));
  ({ TextePanel: TextePanelC } = await import("@/components/studio/panels/texte-panel"));
  ({ EditorShell: EditorShellC } = await import("@/components/studio/editor-shell"));
  ({ Canvas: CanvasC } = await import("@/components/studio/canvas"));
});

afterAll(() => {
  mock.module("next/navigation", () => realNavigation);
  teardownExtraGlobals();
  teardownDom();
});

// EditorShell (Tâche 1, U1) persiste ses préférences dans localStorage sous cette clé
// (hooks/use-editor-prefs.ts) — la nettoyer entre chaque test évite qu'un `rulers`/`openPanel`
// laissé par un test ne fausse l'état initial du suivant (le seul localStorage de ce fichier est
// celui du MÊME jsdom, partagé pour toute sa durée puisque installDom() n'est appelé qu'une fois).
afterEach(() => {
  window.localStorage.clear();
});

// ─────────────────────────────────────────────────────────────────────────────
// Seam 1 — Images `onPick` (components/studio/panels/images-panel.tsx)

function asset(id: string, name: string): AssetRow {
  return {
    id, kind: "image", name, url: `https://example.com/${id}.png`, mime: "image/png",
    bytes: 1000, width: 100, height: 100, fontFamily: null, fontWeight: null, fontStyle: null,
    uploadedByName: null, createdAt: new Date("2026-01-01"),
  };
}

function sceneWithImageLayer(): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 1080, height: 1080, background: "#111111" },
    layers: [{
      id: "img1", name: "Image", visible: true, locked: false,
      frame: { x: 0, y: 0, w: 300, h: 200 },
      type: "image", source: { kind: "slot", slot: "image" }, fit: "cover",
    }],
  };
}

function sceneWithTextLayer(): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 1080, height: 1080, background: "#111111" },
    layers: [{
      id: "txt1", name: "Texte", visible: true, locked: false,
      frame: { x: 0, y: 0, w: 300, h: 80 },
      type: "text", content: "Bonjour",
      font: { family: "Noto Sans", size: 24, weight: 400 },
      color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
    }],
  };
}

describe("Images — cliquer un asset assigne le calque IMAGE sélectionné (seam onPick, images-panel.tsx)", () => {
  // `it.skipIf` — jamais un retour anticipé silencieux qui se lirait comme un succès dans le compte
  // rendu (« N pass ») : si `popoverEffectsLive` est faux, bun compte ce test à part (« skip »), et
  // le message français en tête de fichier explique pourquoi et nomme le remède. Avec `--isolate`
  // (ou `--parallel`), ce test tourne réellement — vérifié : `bun test --isolate
  // tests/studio-interactions.test.ts tests/studio-texte-panel.test.ts tests/studio-editor-shell.test.ts`
  // passe 20/20 AVEC ce test exécuté (pas sauté), et le muter (`onPick={() => {}}` dans
  // images-panel.tsx) le fait passer au rouge — voir task-2-report.md pour la trace complète.
  it.skipIf(!popoverEffectsLive)(
    "calque IMAGE sélectionné -> un VRAI clic sur une VRAIE vignette, à travers le VRAI Popover, assigne cet asset au calque via le VRAI réducteur",
    async () => {
      let state = initEditorState(sceneWithImageLayer());
      const dispatch = (a: EditorAction) => { state = editorReducer(state, a); };

      const { container, unmount } = await mount(
        React.createElement(ImagesPanelC, {
          context: "social_post" as TemplateContext,
          assets: [asset("a1", "Alpha")],
          scene: state.scene,
          selectedId: "img1",
          dispatch,
        }),
      );

      const trigger = container.querySelector('[data-testid="asset-picker"]') as HTMLButtonElement;
      expect(trigger).not.toBeNull();
      expect(trigger.disabled).toBe(false); // un calque image EST sélectionné : le déclencheur est actionnable
      expect(trigger.getAttribute("aria-expanded")).toBe("false");

      await click(trigger); // VRAI clic DOM bubbling sur le VRAI déclencheur du Popover
      await flush();
      expect(trigger.getAttribute("aria-expanded")).toBe("true");

      // Le Popover portale son contenu dans `document.body` (@base-ui/react/popover), jamais dans
      // le conteneur détaché de mount().
      const tile = document.body.querySelector('[data-asset-id="a1"]') as HTMLElement | null;
      expect(tile).not.toBeNull();

      await click(tile!); // VRAI clic DOM — pas un appel direct à pickImageForSelection/onPick

      const layer = state.scene.layers.find((l) => l.id === "img1");
      expect(layer?.type).toBe("image");
      expect(layer?.type === "image" ? layer.source : null).toEqual({ kind: "asset", assetId: "a1" });

      unmount();
    },
  );

  it("calque TEXTE sélectionné -> le déclencheur porte le VRAI attribut `disabled`, et un clic ne dispatche rien", async () => {
    let state = initEditorState(sceneWithTextLayer());
    let dispatchCount = 0;
    const dispatch = (a: EditorAction) => { dispatchCount += 1; state = editorReducer(state, a); };

    const { container, unmount } = await mount(
      React.createElement(ImagesPanelC, {
        context: "social_post" as TemplateContext,
        assets: [asset("a1", "Alpha")],
        scene: state.scene,
        selectedId: "txt1",
        dispatch,
      }),
    );

    const trigger = container.querySelector('[data-testid="asset-picker"]') as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    expect(trigger.disabled).toBe(true); // le VRAI attribut HTML, pas seulement une classe Tailwind `disabled:`

    await click(trigger);
    // Un déclencheur réellement `disabled` (useButton, @base-ui/react) court-circuite le onClick
    // composé AVANT `click.reference.onClick` (celui qui ouvre le Popover) — donc rien ne s'ouvre.
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(dispatchCount).toBe(0);
    expect(state.scene.layers[0]).toEqual(sceneWithTextLayer().layers[0]);

    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Seam 2 & 3 — Styles tile `onClick` et Token row `onClick` (components/studio/panels/texte-panel.tsx)

const CANVAS = { width: 1200, height: 630 };

describe("Texte — cliquer un préréglage « Styles » insère un calque texte NON lié (seam onClick, texte-panel.tsx)", () => {
  it('clic sur « Titre » -> UN calque texte est ajouté, son contenu ne contient AUCUN jeton', async () => {
    const scene: Scene = { schemaVersion: 1, canvas: { ...CANVAS, background: "#000000" }, layers: [] };
    let state = initEditorState(scene);
    const dispatch = (a: EditorAction) => { state = editorReducer(state, a); };

    const { container, unmount } = await mount(
      React.createElement(TextePanelC, { context: "quote_card" as TemplateContext, canvas: CANVAS, dispatch }),
    );

    const preset = container.querySelector('[data-preset="titre"]') as HTMLElement;
    expect(preset).not.toBeNull();
    await click(preset);

    expect(state.scene.layers).toHaveLength(1);
    const inserted = state.scene.layers[0] as TextLayer;
    expect(inserted.type).toBe("text");
    expect(inserted.content).not.toMatch(/\{\{/);

    unmount();
  });
});

describe("Texte — cliquer une ligne « Texte dynamique » (seam onClick, texte-panel.tsx)", () => {
  it('clic sur « Titre de l\'article » (disponible) -> un calque LIÉ à {{article.title}} est ajouté', async () => {
    const scene: Scene = { schemaVersion: 1, canvas: { ...CANVAS, background: "#000000" }, layers: [] };
    let state = initEditorState(scene);
    const dispatch = (a: EditorAction) => { state = editorReducer(state, a); };

    const { container, unmount } = await mount(
      React.createElement(TextePanelC, { context: "quote_card" as TemplateContext, canvas: CANVAS, dispatch }),
    );

    const row = dynamicTextRowsFor("quote_card").find((r) => r.tokenId === "article.title")!;
    expect(row.available).toBe(true); // quote_card légalise article.title (CONTEXT_TOKENS) — sinon ce test ne prouverait rien
    const button = container.querySelector('[data-token="article.title"]') as HTMLElement;
    expect(button.getAttribute("aria-disabled")).not.toBe("true");

    await click(button);

    expect(state.scene.layers).toHaveLength(1);
    const inserted = state.scene.layers[0] as TextLayer;
    expect(inserted.content).toBe("{{article.title}}");

    unmount();
  });

  it("clic sur une ligne indisponible (aria-disabled) -> AUCUN calque n'est ajouté", async () => {
    const scene: Scene = { schemaVersion: 1, canvas: { ...CANVAS, background: "#000000" }, layers: [] };
    let state = initEditorState(scene);
    const dispatch = (a: EditorAction) => { state = editorReducer(state, a); };

    const { container, unmount } = await mount(
      React.createElement(TextePanelC, { context: "quote_card" as TemplateContext, canvas: CANVAS, dispatch }),
    );

    // article.byline est absent de CONTEXT_TOKENS.quote_card mais fait partie des cinq jetons du
    // tableau §4 (dynamic-text.ts) — une ligne grisée existe donc bien pour lui dans ce contexte.
    const row = dynamicTextRowsFor("quote_card").find((r) => r.tokenId === "article.byline")!;
    expect(row.available).toBe(false);
    const button = container.querySelector('[data-token="article.byline"]') as HTMLElement;
    expect(button.getAttribute("aria-disabled")).toBe("true");

    await click(button); // aria-disabled, PAS l'attribut `disabled` : le bouton reste focusable/cliquable au DOM

    expect(state.scene.layers).toHaveLength(0);

    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Seam 4 & 5 — EditorShell : ⌘/ et l'effet d'échelle (components/studio/editor-shell.tsx)

const TEMPLATE: EditorShellTemplate = {
  id: "00000000-0000-0000-0000-000000000000", name: "Gabarit test", context: "social_post",
  channel: null, categoryId: null, format: "ig_square", width: 1080, height: 1080,
  archived: false, publishedVersion: null,
};

function shellScene(): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 1080, height: 1080, background: "#111111" },
    layers: [{
      id: "t", name: "Texte", visible: true, locked: false,
      frame: { x: 10, y: 10, w: 200, h: 80 },
      type: "text", content: "Contenu",
      font: { family: "Noto Sans", size: 24, weight: 400 },
      color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
    }],
  };
}

function mountShell() {
  return mount(
    React.createElement(EditorShellC, {
      template: TEMPLATE, initialScene: shellScene(), publishedScene: null, versions: [], previewArticles: [],
    }),
  );
}

describe("EditorShell — ⌘/ replie puis restaure le MÊME panneau (seam d'enregistrement du keydown, editor-shell.tsx)", () => {
  it("le raccourci est un VRAI écouteur attaché (keydown dispatché sur `document`, pas un appel direct) — replie, puis restaure « calques »", async () => {
    // Préréglage du panneau ouvert via localStorage — c'est le SEUL chemin non-interactif pour
    // démarrer EditorShell avec un panneau déjà ouvert (hooks/use-editor-prefs.ts le lit dans un
    // effet au montage).
    window.localStorage.setItem(
      "studio.editor-prefs",
      JSON.stringify({ ...DEFAULT_PREFS, openPanel: "calques", lastOpenPanel: "calques" }),
    );

    const { container, unmount } = await mountShell();

    const panelHost = () => container.querySelector('[data-testid="panel-host"]');
    expect(panelHost()?.getAttribute("data-panel")).toBe("calques");

    // pressKey dispatche un VRAI KeyboardEvent bubbling sur `document` — editor-shell.tsx enregistre
    // son gestionnaire sur `window`, pas sur `document` : un `document.dispatchEvent` bubbling
    // atteint bien `window` (vérifié : c'est le comportement standard du DOM, pas un raccourci du
    // harnais), donc ceci prouve que l'écouteur est RÉELLEMENT attaché — un appel direct au handler
    // ne l'aurait jamais prouvé.
    await pressKey({ key: "/", metaKey: true });
    expect(panelHost()).toBeNull(); // replié

    await pressKey({ key: "/", metaKey: true });
    expect(panelHost()?.getAttribute("data-panel")).toBe("calques"); // restauré — le MÊME panneau, pas un défaut

    unmount();
  });
});

describe("EditorShell — l'effet d'échelle dépend RÉELLEMENT de `prefs.rulers` (seam de dépendance d'effet, editor-shell.tsx)", () => {
  it("activer les règles redéclenche le calcul d'échelle -> la taille rendue de l'artboard change", async () => {
    // jsdom (sans `pretendToBeVisual`) rend `clientWidth`/`clientHeight` toujours nuls — le calcul
    // réel (computeCanvasScale, editor-shell.tsx) verrait alors un conteneur "trop petit" et
    // n'appellerait jamais `setScale`. On fixe une mesure réaliste sur CE fichier de test
    // uniquement (jamais dans dom-harness.ts) pour rendre le calcul observable — restauré après.
    const proto = (window as unknown as { Element: { prototype: Record<string, unknown> } }).Element.prototype;
    const originalWidth = Object.getOwnPropertyDescriptor(proto, "clientWidth");
    const originalHeight = Object.getOwnPropertyDescriptor(proto, "clientHeight");
    Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => 600 });
    Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 600 });

    try {
      const { container, unmount } = await mountShell();

      const artboard = () => container.querySelector('[data-testid="artboard"]') as HTMLElement;
      const widthBefore = artboard().style.width;
      expect(widthBefore).not.toBe(""); // computeCanvasScale a bien produit une valeur non nulle (pad=32, 600-32=568)

      const rulersButton = container.querySelector('[data-action="toggle-rulers"]') as HTMLElement;
      await click(rulersButton);

      const widthAfter = artboard().style.width;
      expect(widthAfter).not.toBe(widthBefore);
      // Les règles retranchent 2×RULER_SIZE en plus du pad existant (Important 6, revue finale) :
      // l'artboard doit RÉTRÉCIR, jamais grandir, une fois les règles affichées.
      expect(parseFloat(widthAfter)).toBeLessThan(parseFloat(widthBefore));

      unmount();
    } finally {
      if (originalWidth) Object.defineProperty(proto, "clientWidth", originalWidth);
      else delete proto.clientWidth;
      if (originalHeight) Object.defineProperty(proto, "clientHeight", originalHeight);
      else delete proto.clientHeight;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Seam 6 — Poignées de redimensionnement : Maj/Alt à travers de VRAIS événements pointeur DOM
// (revue Tâche 2, Important 4). Tout ce qui précède dans tests/studio-drag.test.ts exerce
// `createGestureEngine` DIRECTEMENT — `engine.move(pointer, { shift: true })` — ce qui prouve que la
// machine à geste PURE compose bien Maj/Alt avec la rotation, mais ne prouve PAS que `hooks/use-
// layer-drag.ts`'s `bind()` lit RÉELLEMENT `ev.shiftKey`/`ev.altKey` sur un VRAI `PointerEvent` DOM et
// les relaie à cette même machine : une mutation qui supprimerait `shift: ev.shiftKey` (ou
// `alt: ev.altKey`) à la source laisserait TOUTE la suite `studio-drag` au vert, puisqu'aucun de ces
// tests ne passe par le DOM. Les deux tests ci-dessous pilotent le VRAI composant `Canvas`, un VRAI
// `[data-handle]`, et de VRAIS `pointerdown`/`pointermove` (via `tests/dom-harness.ts`'s `pointer()`)
// jusqu'au réducteur — la même discipline que les cinq coutures ci-dessus.
function sceneWithShapeLayer(): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 800, height: 600, background: "#000000" },
    layers: [{
      id: "l1", name: "Calque", visible: true, locked: false,
      frame: { x: 100, y: 100, w: 200, h: 150 },
      type: "shape", shape: "rect", fill: "#CCCCCC",
    }],
  };
}

describe("Poignées de redimensionnement — Maj/Alt à travers de VRAIS événements pointeur DOM (protection Tâche 2, Important 4)", () => {
  it("pointerdown sur [data-handle='se'] puis pointermove avec shiftKey verrouille le ratio jusqu'au réducteur", async () => {
    const scene = sceneWithShapeLayer();
    const actions: EditorAction[] = [];
    const dispatch = (a: EditorAction) => { actions.push(a); };

    const { container, unmount } = await mount(
      React.createElement(CanvasC, { scene, selectedId: "l1", dispatch, scale: 1 }),
    );

    const handle = container.querySelector('[data-handle="se"]') as HTMLElement;
    expect(handle).not.toBeNull();

    await pointer(handle, "pointerdown", { clientX: 0, clientY: 0 });
    await pointer(handle, "pointermove", { clientX: 60, clientY: -8, shiftKey: true });

    // Aperçu EN COURS de geste (avant pointerup) : couvre le site `handleMove` de `bind()`, pas
    // seulement `handleUp` — les deux relaient `shiftKey` séparément à la source.
    const overlay = container.querySelector('[data-testid="handles-overlay"]') as HTMLElement;
    expect(overlay).not.toBeNull();
    const previewW = parseFloat(overlay.style.width);
    const previewH = parseFloat(overlay.style.height);
    expect(previewW / previewH).toBeCloseTo(200 / 150, 6);
    expect(previewW).not.toBeCloseTo(260, 0); // sans Maj, ce même geste donnerait w=260, hors ratio

    await pointer(handle, "pointerup", { clientX: 60, clientY: -8, shiftKey: true });

    expect(actions).toHaveLength(1);
    const action = actions[0];
    if (action.type !== "resizeLayer") throw new Error("attendu resizeLayer");
    expect(action.frame.w / action.frame.h).toBeCloseTo(200 / 150, 6);
    // Preuve que Maj a RÉELLEMENT changé le résultat par ce chemin DOM (pas une coïncidence) : sans
    // Maj, ce même geste donnerait w=260 (200+60), hors ratio.
    expect(action.frame.w).not.toBeCloseTo(260, 0);

    unmount();
  });

  it("pointerdown sur [data-handle='e'] puis pointermove avec altKey garde le centre fixe jusqu'au réducteur", async () => {
    const scene = sceneWithShapeLayer();
    const actions: EditorAction[] = [];
    const dispatch = (a: EditorAction) => { actions.push(a); };

    const { container, unmount } = await mount(
      React.createElement(CanvasC, { scene, selectedId: "l1", dispatch, scale: 1 }),
    );

    const handle = container.querySelector('[data-handle="e"]') as HTMLElement;
    expect(handle).not.toBeNull();

    await pointer(handle, "pointerdown", { clientX: 0, clientY: 0 });
    await pointer(handle, "pointermove", { clientX: 40, clientY: 0, altKey: true });

    // Aperçu EN COURS de geste (avant pointerup) : couvre le site `handleMove` de `bind()` — sans
    // Alt, ce même geste donnerait left=100 (bord ouest inchangé) ; avec Alt, left doit avoir reculé
    // à 60 (centre recentré).
    const overlay = container.querySelector('[data-testid="handles-overlay"]') as HTMLElement;
    expect(overlay).not.toBeNull();
    expect(parseFloat(overlay.style.left)).toBeCloseTo(60, 6);
    expect(parseFloat(overlay.style.width)).toBeCloseTo(280, 6);

    await pointer(handle, "pointerup", { clientX: 40, clientY: 0, altKey: true });

    expect(actions).toHaveLength(1);
    // Même valeurs que le test createGestureEngine équivalent (tests/studio-drag.test.ts) : la poignée
    // tirée suit le curseur, le bord opposé bouge en miroir — w = 200 + 2×40 = 280, x recentré à 60.
    expect(actions[0]).toEqual({ type: "resizeLayer", id: "l1", frame: { x: 60, y: 100, w: 280, h: 150 } });

    unmount();
  });
});
