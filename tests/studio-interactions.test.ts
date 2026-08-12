import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import React from "react";
import { installDom, mount, click, pressKey, releaseKey, flush, pointer, wheel } from "./dom-harness";
import { editorReducer, initEditorState, type EditorAction, type EditorState } from "@/lib/studio/editor-state";
import { dynamicTextRowsFor } from "@/lib/studio/dynamic-text";
import { DEFAULT_PREFS } from "@/lib/studio/editor-prefs";
import { clearClipboard } from "@/lib/studio/clipboard";
import { wheelZoomScale, clampZoom, zoomAtCursor } from "@/lib/studio/zoom";
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
let PropertyPanelC: typeof import("@/components/studio/property-panel").PropertyPanel;

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
  ({ PropertyPanel: PropertyPanelC } = await import("@/components/studio/property-panel"));
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
      React.createElement(CanvasC, { scene, selectedIds: ["l1"], dispatch, scale: 1 }),
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
      React.createElement(CanvasC, { scene, selectedIds: ["l1"], dispatch, scale: 1 }),
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

// ─────────────────────────────────────────────────────────────────────────────
// Seam 7 — Sélection MULTIPLE au canevas (Tâche 3, U2, spec §3), à travers de VRAIS événements
// pointeur DOM. Tout ce que tests/studio-editor-state.test.ts prouve du réducteur reste vrai sans
// dire un mot du CÂBLAGE : une mutation qui perdrait `e.shiftKey` dans canvas.tsx, ou qui
// oublierait le `stopPropagation()` protégeant le Maj-clic du gestionnaire « clic dans le vide »
// posé sur la racine, laisserait TOUTE la suite du réducteur au vert. Les tests ci-dessous pilotent
// donc le VRAI `Canvas` avec le VRAI réducteur derrière lui.
//
// ── Pourquoi Maj-clic et non ⌘/Ctrl-clic, et pourquoi ça ne heurte pas le Maj de la Tâche 2 ──
// Maj est déjà pris SUR LE CANEVAS par la Tâche 2 : Maj-glisser sur une POIGNÉE de
// redimensionnement verrouille le ratio. Les deux cibles sont pourtant disjointes dans l'arbre —
// les poignées vivent dans `[data-testid="handles-overlay"]`, un FRÈRE des nœuds de calque, jamais
// un descendant — et `bind()` (hooks/use-layer-drag.ts) appelle `e.stopPropagation()` sur son
// pointerdown. Un Maj-glisser parti d'une poignée ne traverse donc JAMAIS le gestionnaire du corps
// d'un calque. Le dernier test de ce bloc le vérifie directement plutôt que de s'en tenir à ce
// raisonnement. ⌘/Ctrl-clic a été écarté : ⌘ porte déjà ⌘/ (replier le panneau, editor-shell.tsx) et
// macOS synthétise Ctrl-clic en clic DROIT, ce qui en ferait un geste inatteignable sur la moitié
// du parc.
function sceneWithTwoShapes(): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 800, height: 600, background: "#000000" },
    layers: [
      {
        id: "a", name: "Calque A", visible: true, locked: false,
        frame: { x: 10, y: 10, w: 100, h: 100 },
        type: "shape", shape: "rect", fill: "#AAAAAA",
      },
      {
        id: "b", name: "Calque B", visible: true, locked: false,
        frame: { x: 200, y: 200, w: 120, h: 80 },
        type: "shape", shape: "rect", fill: "#BBBBBB",
      },
    ],
  };
}

/** Monte le VRAI `Canvas` derrière un VRAI `editorReducer`. `Canvas` est contrôlé (scene et
 * selectedIds en props), donc observer une sélection qui CHANGE demande un réducteur au-dessus.
 * `box.state` est réassigné dans le corps du rendu — pas un état React — pour que chaque assertion
 * lise le dernier état RÉELLEMENT rendu, et `box.actions` enregistre au passage tout ce que le
 * composant dispatche (c'est ce qui permet d'affirmer qu'AUCUN moveLayer n'a eu lieu). */
async function mountCanvasWithReducer(scene: Scene, initialSelection: string[], scale = 1) {
  const initial: EditorState = { ...initEditorState(scene), selectedIds: initialSelection };
  const box: { state: EditorState; actions: EditorAction[] } = { state: initial, actions: [] };

  function Host() {
    const [state, rawDispatch] = React.useReducer(editorReducer, initial);
    box.state = state;
    return React.createElement(CanvasC, {
      scene: state.scene,
      selectedIds: state.selectedIds,
      dispatch: (a: EditorAction) => { box.actions.push(a); rawDispatch(a); },
      // `scale` par défaut à 1 : tous les appels d'avant la Tâche 5 sont inchangés. Le paramètre
      // existe pour le test d'épaisseur des guides à k≠1 (dernier bloc de ce fichier).
      scale,
    });
  }

  const { container, unmount } = await mount(React.createElement(Host));
  return { box, container, unmount };
}

/** Les deux formes ci-dessus PLUS une troisième, pour le GLISSER DE GROUPE (revue finale U0+U2,
 * Important 1) : à deux calques on ne distingue pas « le groupe a suivi » de « seul le calque tiré a
 * bougé et l'autre était déjà là ». Les positions et le geste employés plus bas sont choisis pour
 * qu'aucune ligne du plan de travail ne tombe dans le seuil d'accroche — l'accroche a ses propres
 * tests, elle n'a pas à brouiller celui-ci. */
function sceneWithThreeShapesOnCanvas(): Scene {
  const scene = sceneWithTwoShapes();
  scene.layers = [
    ...scene.layers,
    {
      id: "c", name: "Calque C", visible: true, locked: false,
      frame: { x: 500, y: 30, w: 40, h: 40 },
      type: "shape", shape: "rect", fill: "#CCCCCC",
    },
  ];
  return scene;
}

function layerEl(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector(`[data-layer-id="${id}"]`) as HTMLElement | null;
  if (!el) throw new Error(`nœud du calque « ${id} » absent du DOM monté`);
  return el;
}

describe("Canvas — sélection multiple par Maj-clic, à travers de VRAIS événements pointeur DOM (Tâche 3, U2)", () => {
  it("Maj-clic sur un calque non sélectionné l'AJOUTE à la sélection, et le DOM marque les deux", async () => {
    const { box, container, unmount } = await mountCanvasWithReducer(sceneWithTwoShapes(), ["a"]);

    await pointer(layerEl(container, "b"), "pointerdown", { clientX: 250, clientY: 250, shiftKey: true, button: 0 });

    expect(box.state.selectedIds).toEqual(["a", "b"]);
    // Honnêteté sur la PORTÉE de cette assertion (mesurée par mutation, voir task-3-report.md) : elle
    // ne prouve PAS à elle seule le `stopPropagation()` du chemin Maj de canvas.tsx. Deux gardes
    // INDÉPENDAMMENT suffisantes protègent ce chemin du gestionnaire « clic dans le vide » posé sur la
    // racine — cet arrêt de propagation, ET la garde `e.shiftKey` de la racine elle-même — donc
    // retirer l'une des deux laisse ce test vert. Chacune est épinglée par un test DIFFÉRENT : la
    // garde de la racine par « Maj + clic dans le vide » plus bas, l'arrêt de propagation par ce
    // test-ci UNE FOIS cette garde retirée (mutation vérifiée). C'est ce que veut dire « défense en
    // profondeur » ici, et c'est délibéré : un futur changement de l'un ne casse pas le geste.
    expect(layerEl(container, "a").getAttribute("data-selected")).toBe("true");
    expect(layerEl(container, "b").getAttribute("data-selected")).toBe("true");

    unmount();
  });

  it("Maj-clic sur un calque DÉJÀ sélectionné le RETIRE, en laissant les autres", async () => {
    const { box, container, unmount } = await mountCanvasWithReducer(sceneWithTwoShapes(), ["a", "b"]);

    await pointer(layerEl(container, "b"), "pointerdown", { clientX: 250, clientY: 250, shiftKey: true, button: 0 });

    expect(box.state.selectedIds).toEqual(["a"]);
    expect(layerEl(container, "a").getAttribute("data-selected")).toBe("true");
    expect(layerEl(container, "b").getAttribute("data-selected")).toBeNull();

    unmount();
  });

  it("Maj-clic n'arme AUCUN geste de déplacement — un glisser Maj sur un corps de calque ne bouge rien", async () => {
    const scene = sceneWithTwoShapes();
    const { box, container, unmount } = await mountCanvasWithReducer(scene, ["a"]);
    const b = layerEl(container, "b");

    await pointer(b, "pointerdown", { clientX: 250, clientY: 250, shiftKey: true, button: 0 });
    await pointer(b, "pointermove", { clientX: 400, clientY: 400, shiftKey: true });
    await pointer(b, "pointerup", { clientX: 400, clientY: 400, shiftKey: true });

    // La bascule a bien eu lieu…
    expect(box.state.selectedIds).toEqual(["a", "b"]);
    // …et RIEN d'autre : aucun moveLayer n'a été dispatché, et le cadre est intact malgré les 150px
    // de glisser. Le choix documenté (canvas.tsx) : sur le CORPS d'un calque, Maj fait du pointerdown
    // une bascule de sélection PURE, jamais le début d'un déplacement — sinon Maj-cliquer pour
    // ajouter un calque le déplacerait au moindre tremblement de main.
    expect(box.actions.some((a) => a.type === "moveLayer")).toBe(false);
    expect(box.state.scene.layers.find((l) => l.id === "b")!.frame)
      .toEqual(scene.layers[1].frame);

    unmount();
  });

  it("un clic SIMPLE (sans Maj) sur un calque HORS sélection la REMPLACE au lieu de l'étendre", async () => {
    // PORTÉE (revue finale U0+U2, Important 1) : « remplace » vaut pour un calque qui n'est PAS déjà
    // dans la sélection. Ce test cliquait auparavant un calque DÉJÀ sélectionné, ce qui en faisait le
    // témoin du défaut corrigé par Important 1 — tirer un calque d'une sélection multiple la réduisait
    // à ce seul calque. Le cas « déjà sélectionné » a maintenant son propre bloc, plus bas ; celui-ci
    // garde la propriété d'origine, sur le cas où elle vaut toujours, et la renforce : la sélection de
    // départ compte DEUX calques, donc un gestionnaire qui étendrait au lieu de remplacer rendrait
    // ["b", "c", "a"] et non ["a"].
    const { box, container, unmount } = await mountCanvasWithReducer(sceneWithThreeShapesOnCanvas(), ["b", "c"]);

    await pointer(layerEl(container, "a"), "pointerdown", { clientX: 50, clientY: 50, button: 0 });

    expect(box.state.selectedIds).toEqual(["a"]);
    expect(layerEl(container, "b").getAttribute("data-selected")).toBeNull();
    expect(layerEl(container, "c").getAttribute("data-selected")).toBeNull();

    unmount();
  });

  it("un clic sur le canevas VIDE efface la sélection entière", async () => {
    const { box, container, unmount } = await mountCanvasWithReducer(sceneWithTwoShapes(), ["a", "b"]);
    const root = container.querySelector('[data-testid="studio-canvas"]') as HTMLElement;
    expect(root).not.toBeNull();

    await pointer(root, "pointerdown", { clientX: 700, clientY: 500, button: 0 });

    expect(box.state.selectedIds).toEqual([]);
    expect(layerEl(container, "a").getAttribute("data-selected")).toBeNull();
    expect(layerEl(container, "b").getAttribute("data-selected")).toBeNull();

    unmount();
  });

  it("Maj + clic dans le vide n'efface PAS la sélection — Maj est le mode « ajouter/retirer », pas « détruire »", async () => {
    const { box, container, unmount } = await mountCanvasWithReducer(sceneWithTwoShapes(), ["a", "b"]);
    const root = container.querySelector('[data-testid="studio-canvas"]') as HTMLElement;

    await pointer(root, "pointerdown", { clientX: 700, clientY: 500, shiftKey: true, button: 0 });

    expect(box.state.selectedIds).toEqual(["a", "b"]);

    unmount();
  });

  it("cliquer un calque VERROUILLÉ ne le sélectionne pas — le clic le traverse ; ici rien de sélectionnable dessous, donc la sélection s'efface", async () => {
    // Conséquence assumée du gestionnaire « clic dans le vide » (voir canvas.tsx) : un calque locked
    // ne porte AUCUN gestionnaire de pointeur, donc son pointerdown remonte jusqu'à la racine. Avant
    // la Tâche 3 il ne se passait rien du tout ; ce test fixe le nouveau comportement au lieu de le
    // laisser être un effet de bord non documenté. (jsdom ne fait pas de test de survol, donc c'est
    // bien l'absence de gestionnaire — le même mécanisme qu'en navigateur, où `pointer-events: none`
    // empêche en plus le nœud d'être la cible — qui fait remonter l'événement ici.)
    //
    // PORTÉE EXACTE (revue Tâche 3, Mineur 3) : l'effacement n'est PAS universel. Il découle du fait
    // que ce cas précis n'a rien de sélectionnable SOUS le calque verrouillé. En navigateur, avec un
    // calque déverrouillé en dessous, `pointer-events: none` fait de CE calque-là la cible et le clic
    // le sélectionne au lieu d'effacer — comportement également correct, et non couvert ici (jsdom ne
    // fait aucun test de survol, donc ce fichier ne PEUT pas l'exprimer). Le titre disait « efface la
    // sélection » sans réserve : un universel que seul ce cas de figure vérifie.
    const scene = sceneWithTwoShapes();
    scene.layers = [{ ...scene.layers[0], locked: true }, scene.layers[1]];
    const { box, container, unmount } = await mountCanvasWithReducer(scene, ["b"]);

    await pointer(layerEl(container, "a"), "pointerdown", { clientX: 50, clientY: 50, button: 0 });

    expect(box.state.selectedIds).toEqual([]);
    // …et le calque verrouillé n'est PAS devenu sélectionné au passage.
    expect(box.actions.some((a) => a.type === "select" && a.ids.includes("a"))).toBe(false);

    unmount();
  });

  it("Maj-GLISSER sur une POIGNÉE verrouille le ratio (Tâche 2) et ne touche PAS la sélection (Tâche 3)", async () => {
    // LE test de non-collision entre les deux usages de Maj sur le canevas. Ce qui le rendrait
    // ROUGE : poser la bascule de sélection sur un ancêtre commun aux poignées et aux calques, ou
    // laisser le gestionnaire « clic dans le vide » de la racine s'exécuter après un pointerdown sur
    // une poignée.
    const { box, container, unmount } = await mountCanvasWithReducer(sceneWithShapeLayer(), ["l1"]);
    const handle = container.querySelector('[data-handle="se"]') as HTMLElement;
    expect(handle).not.toBeNull();

    await pointer(handle, "pointerdown", { clientX: 0, clientY: 0, button: 0 });
    await pointer(handle, "pointermove", { clientX: 60, clientY: -8, shiftKey: true });
    await pointer(handle, "pointerup", { clientX: 60, clientY: -8, shiftKey: true });

    // La sélection est RIGOUREUSEMENT inchangée — ni vidée, ni basculée vers une sélection vide.
    expect(box.state.selectedIds).toEqual(["l1"]);
    expect(box.actions.some((a) => a.type === "select" || a.type === "toggleSelection")).toBe(false);
    // Et le geste de la Tâche 2 a bel et bien fait son travail par ce même chemin DOM.
    const resize = box.actions.find((a) => a.type === "resizeLayer");
    if (!resize || resize.type !== "resizeLayer") throw new Error("attendu resizeLayer");
    expect(resize.frame.w / resize.frame.h).toBeCloseTo(200 / 150, 6);
    expect(resize.frame.w).not.toBeCloseTo(260, 0);

    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GLISSER DE GROUPE au canevas (revue finale U0+U2, Important 1), à travers de VRAIS événements
// pointeur DOM.
//
// LE DÉFAUT CORRIGÉ, mesuré : sélection ["a","b","c"], tirer « b » -> la sélection devenait ["b"] et
// seul « b » bougeait. Vécu utilisateur : aligner trois calques, en tirer un pour recaler l'ensemble,
// et voir les deux autres rester sur place PENDANT que la rangée aligner/répartir disparaît (elle
// n'existe qu'à deux participants ou plus). Le glisser était le seul geste du canevas qui ne refusait
// ni ne groupait — il DÉTRUISAIT.
//
// tests/studio-drag.test.ts prouve tout du MOTEUR (groupe, verrou, masque, accroche, une seule entrée
// d'historique) sans dire un mot du CÂBLAGE : une mutation qui remettrait `dispatch(select(layer.id))`
// inconditionnel dans canvas.tsx, qui passerait `undefined` en guise de groupe, ou qui ferait lire à
// l'aperçu le seul `preview.frame`, laisserait ce fichier-là entièrement vert.
describe("Canvas — tirer un calque d'une sélection multiple déplace TOUT LE GROUPE (revue finale, Important 1)", () => {
  it("la sélection SURVIT au glisser, les trois calques suivent, et l'historique ne retient QU'UNE entrée", async () => {
    // « b » en (200, 200) 120×80 ; glisser de (+40, +45). Positions x 240/300/360 et y 245/285/325 :
    // toutes à ≥ 15 des lignes du plan de travail (x 0/266,67/400/533,33/800 ; y 0/200/300/400/600), et
    // « a »/« c » sont EMPORTÉS par le geste, donc écartés des références. Aucune accroche : la
    // translation est exactement celle du curseur.
    const scene = sceneWithThreeShapesOnCanvas();
    const { box, container, unmount } = await mountCanvasWithReducer(scene, ["a", "b", "c"]);
    const b = layerEl(container, "b");

    await pointer(b, "pointerdown", { clientX: 250, clientY: 250, button: 0 });

    // (a) le pointerdown NE re-sélectionne PAS : c'est là que la sélection mourait.
    expect(box.state.selectedIds).toEqual(["a", "b", "c"]);
    expect(box.actions.some((a) => a.type === "select")).toBe(false);

    await pointer(b, "pointermove", { clientX: 290, clientY: 295 });

    // (b) l'APERÇU montre déjà les TROIS calques déplacés — pas seulement celui qu'on tire. Sans cela,
    // l'utilisateur verrait un geste différent de celui qu'il obtient au relâchement.
    expect(parseFloat(layerEl(container, "a").style.left)).toBe(50);
    expect(parseFloat(layerEl(container, "a").style.top)).toBe(55);
    expect(parseFloat(layerEl(container, "b").style.left)).toBe(240);
    expect(parseFloat(layerEl(container, "c").style.left)).toBe(540);

    await pointer(b, "pointerup", { clientX: 290, clientY: 295 });

    // (c) les trois cadres ont bougé de la MÊME translation, et la sélection est intacte.
    expect(box.state.scene.layers.map((l) => l.frame)).toEqual([
      { x: 50, y: 55, w: 100, h: 100 },
      { x: 240, y: 245, w: 120, h: 80 },
      { x: 540, y: 75, w: 40, h: 40 },
    ]);
    expect(box.state.selectedIds).toEqual(["a", "b", "c"]);
    // (d) UNE seule entrée d'historique pour tout le geste — jamais trois `moveLayer`.
    expect(box.state.past).toHaveLength(1);
    expect(box.actions.filter((a) => a.type === "moveLayer")).toHaveLength(0);
    expect(box.actions.filter((a) => a.type === "setFrames")).toHaveLength(1);

    unmount();
  });

  it("un calque VERROUILLÉ de la sélection reste sur place pendant que le reste du groupe se déplace", async () => {
    const scene = sceneWithThreeShapesOnCanvas();
    scene.layers = [scene.layers[0], scene.layers[1], { ...scene.layers[2], locked: true }];
    const { box, container, unmount } = await mountCanvasWithReducer(scene, ["a", "b", "c"]);
    const b = layerEl(container, "b");

    await pointer(b, "pointerdown", { clientX: 250, clientY: 250, button: 0 });
    await pointer(b, "pointermove", { clientX: 290, clientY: 295 });
    // Le verrou vaut AUSSI pour l'aperçu : le calque verrouillé n'a pas bougé d'un pixel à l'écran.
    expect(parseFloat(layerEl(container, "c").style.left)).toBe(500);
    await pointer(b, "pointerup", { clientX: 290, clientY: 295 });

    expect(box.state.scene.layers.map((l) => l.frame.x)).toEqual([50, 240, 500]);

    unmount();
  });

  it("tirer un calque HORS de la sélection la remplace et ne déplace que lui (l'autre moitié de la règle)", async () => {
    const { box, container, unmount } = await mountCanvasWithReducer(sceneWithThreeShapesOnCanvas(), ["a", "c"]);
    const b = layerEl(container, "b");

    await pointer(b, "pointerdown", { clientX: 250, clientY: 250, button: 0 });
    await pointer(b, "pointermove", { clientX: 290, clientY: 295 });
    await pointer(b, "pointerup", { clientX: 290, clientY: 295 });

    expect(box.state.selectedIds).toEqual(["b"]);
    expect(box.state.scene.layers.map((l) => l.frame.x)).toEqual([10, 240, 500]);
    // Chemin historique conservé pour un calque seul : `moveLayer` avec le delta brut, pas `setFrames`.
    expect(box.actions.some((a) => a.type === "moveLayer")).toBe(true);

    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tâche 3, M4 (revue finale U0+U2) — LA GARDE DE BOUTON AVANT LES EFFETS DE BORD.
//
// Le gestionnaire du corps d'un calque appelait `stopPropagation()`/`preventDefault()` AVANT de tester
// `e.button === 0`. Deux conséquences opposées, dans le même gestionnaire : un Maj-clic DROIT était
// avalé (mort — aucun `contextmenu` n'est posé nulle part), tandis qu'un clic droit SANS Maj tombait
// jusqu'à `dispatch(select(layer.id))` et RÉDUISAIT une sélection multiple à un seul calque. La racine,
// elle, refusait déjà tout bouton non primaire (`e.button !== 0`) : les deux chemins se contredisaient.
describe("Canvas — un bouton non primaire n'arme rien et ne touche PAS la sélection (Tâche 3, M4)", () => {
  // Le calque visé est HORS de la sélection, exprès : c'est le seul cadrage où les DEUX chemins du
  // gestionnaire ont encore quelque chose à faire, donc le seul où retirer la garde se voit. Sans la
  // garde, le clic droit nu dispatcherait `select("b")` (sélection réduite à ["b"]) et le Maj + clic
  // droit dispatcherait `toggleSelection("b")` (sélection étendue à ["a","c","b"]) — deux mutations
  // distinctes, chacune rouge sur une des deux lignes ci-dessous.
  for (const [nom, extra] of [["clic droit", {}], ["Maj + clic droit", { shiftKey: true }]] as const) {
    it(`${nom} sur le corps d'un calque laisse la sélection multiple INTACTE`, async () => {
      const { box, container, unmount } = await mountCanvasWithReducer(sceneWithThreeShapesOnCanvas(), ["a", "c"]);

      await pointer(layerEl(container, "b"), "pointerdown", { clientX: 250, clientY: 250, button: 2, ...extra });

      expect(box.state.selectedIds).toEqual(["a", "c"]);
      // Aucune action DU TOUT : ni sélection, ni bascule, ni geste armé. La racine a la même garde,
      // donc l'événement qui remonte jusqu'à elle n'efface rien non plus.
      expect(box.actions).toEqual([]);

      unmount();
    });
  }

  it("le clic GAUCHE, lui, agit toujours — la garde ne neutralise pas le geste normal", async () => {
    // Contre-épreuve obligatoire : sans elle, un gestionnaire qui ne ferait PLUS RIEN, quel que soit le
    // bouton, passerait les deux tests ci-dessus.
    const { box, container, unmount } = await mountCanvasWithReducer(sceneWithThreeShapesOnCanvas(), ["a", "c"]);

    await pointer(layerEl(container, "b"), "pointerdown", { clientX: 250, clientY: 250, button: 0 });

    expect(box.state.selectedIds).toEqual(["b"]);

    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Seam 8 — La rangée ALIGNER/RÉPARTIR (Tâche 4, U2, spec §4), à travers de VRAIS clics DOM.
// tests/studio-align.test.ts prouve la géométrie pure et tests/studio-editor-state.test.ts prouve que
// `setFrames` n'empile QU'UNE entrée d'historique ; ni l'un ni l'autre ne dit un mot du CÂBLAGE. Une
// mutation qui remplacerait `onClick` par un no-op, ou qui appellerait planAlign avec le mauvais mode,
// laisserait ces deux fichiers entièrement verts. Les tests ci-dessous cliquent donc les VRAIS boutons
// du VRAI PropertyPanel, derrière le VRAI réducteur, et vérifient les COORDONNÉES obtenues — plus le
// compte d'entrées d'historique, qui est la propriété que cette tâche devait au reste de U2.
function sceneWithThreeShapes(): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 800, height: 600, background: "#000000" },
    layers: [
      {
        id: "a", name: "A", visible: true, locked: false,
        frame: { x: 40, y: 10, w: 100, h: 50 },
        type: "shape", shape: "rect", fill: "#AAAAAA",
      },
      {
        id: "b", name: "B", visible: true, locked: false,
        frame: { x: 200, y: 100, w: 60, h: 80 },
        type: "shape", shape: "rect", fill: "#BBBBBB",
      },
      {
        id: "c", name: "C", visible: true, locked: false,
        frame: { x: 120, y: 300, w: 40, h: 20 },
        type: "shape", shape: "rect", fill: "#CCCCCC",
      },
    ],
  };
}

/** Monte le VRAI `PropertyPanel` derrière un VRAI `editorReducer` — même recette que
 * `mountCanvasWithReducer` ci-dessus (le panneau est contrôlé : scène et sélection en props).
 * `context` (Tâche 5, U4, additif) : "social_post" reste la valeur par défaut de tous les appels
 * d'avant cette tâche — le seam TokenPicker plus bas est le premier à avoir besoin d'un AUTRE
 * contexte (pour obtenir, dans le MÊME popover, une ligne légale et une ligne illégale). */
async function mountPropertyPanelWithReducer(
  scene: Scene, initialSelection: string[], context: TemplateContext = "social_post",
) {
  const initial: EditorState = { ...initEditorState(scene), selectedIds: initialSelection };
  const box: { state: EditorState; actions: EditorAction[] } = { state: initial, actions: [] };

  function Host() {
    const [state, rawDispatch] = React.useReducer(editorReducer, initial);
    box.state = state;
    return React.createElement(PropertyPanelC, {
      scene: state.scene,
      selectedIds: state.selectedIds,
      context,
      dispatch: (a: EditorAction) => { box.actions.push(a); rawDispatch(a); },
    });
  }

  const { container, unmount } = await mount(React.createElement(Host));
  return { box, container, unmount };
}

function actionButton(container: HTMLElement, action: string): HTMLButtonElement {
  const el = container.querySelector(`[data-action="${action}"]`) as HTMLButtonElement | null;
  if (!el) throw new Error(`bouton « ${action} » absent du DOM monté`);
  return el;
}

function frameOf(state: EditorState, id: string) {
  const layer = state.scene.layers.find((l) => l.id === id);
  if (!layer) throw new Error(`calque « ${id} » introuvable`);
  return layer.frame;
}

describe("Aligner/répartir — un VRAI clic déplace les calques et n'empile QU'UNE entrée d'historique (Tâche 4, U2)", () => {
  it("sélection MULTIPLE + « aligner à gauche » -> tous les x valent la gauche de la boîte englobante, en UNE entrée", async () => {
    const { box, container, unmount } = await mountPropertyPanelWithReducer(sceneWithThreeShapes(), ["a", "b", "c"]);

    await click(actionButton(container, "align-left"));

    // Boîte englobante des trois : gauche = min(40, 200, 120) = 40.
    expect(frameOf(box.state, "a").x).toBe(40);
    expect(frameOf(box.state, "b").x).toBe(40);
    expect(frameOf(box.state, "c").x).toBe(40);
    // Les y n'ont pas bougé (aligner à gauche ne touche qu'un axe), et rien n'a été redimensionné.
    expect(frameOf(box.state, "b").y).toBe(100);
    expect(frameOf(box.state, "b").w).toBe(60);
    // UNE seule action, UNE seule entrée d'historique pour ce geste unique.
    expect(box.actions).toHaveLength(1);
    expect(box.actions[0].type).toBe("setFrames");
    expect(box.state.past).toHaveLength(1);

    unmount();
  });

  it("sélection MULTIPLE + « répartir horizontalement » -> écarts égaux, extrêmes immobiles, UNE entrée", async () => {
    const { box, container, unmount } = await mountPropertyPanelWithReducer(sceneWithThreeShapes(), ["a", "b", "c"]);

    await click(actionButton(container, "distribute-horizontal"));

    // Ordre des positions : a(40, w100, droite 140) · c(120, w40) · b(200, w60, droite 260).
    // étendue = 260-40 = 220 · somme des largeurs = 200 · écart = 20/2 = 10
    // -> a reste à 40 ; c passe de 120 à 150 ; b reste à 200.
    expect(frameOf(box.state, "a").x).toBe(40);
    expect(frameOf(box.state, "c").x).toBe(150);
    expect(frameOf(box.state, "b").x).toBe(200);
    expect(box.state.past).toHaveLength(1);

    unmount();
  });

  it("« répartir VERTICALEMENT » agit bien sur l'axe vertical (et pas sur l'horizontal)", async () => {
    // Le pendant du test ci-dessus sur l'autre axe. Ce que ce test attrape et que l'autre ne peut pas :
    // un axe codé en dur dans le gestionnaire (les deux boutons répartiraient alors horizontalement).
    const { box, container, unmount } = await mountPropertyPanelWithReducer(sceneWithThreeShapes(), ["a", "b", "c"]);

    await click(actionButton(container, "distribute-vertical"));

    // Ordre des positions : a(y10, h50, bas 60) · b(y100, h80, bas 180) · c(y300, h20, bas 320).
    // étendue = 320-10 = 310 · somme des hauteurs = 150 · écart = 160/2 = 80
    // -> a reste à 10 ; b passe de 100 à 140 ; c reste à 300.
    expect(frameOf(box.state, "a").y).toBe(10);
    expect(frameOf(box.state, "b").y).toBe(140);
    expect(frameOf(box.state, "c").y).toBe(300);
    // …et aucun x n'a bougé : répartir verticalement ne touche qu'un axe.
    expect(frameOf(box.state, "b").x).toBe(200);
    expect(box.state.past).toHaveLength(1);

    unmount();
  });

  it("sélection SIMPLE + « centrer horizontalement » -> le calque se centre sur le PLAN DE TRAVAIL", async () => {
    const { box, container, unmount } = await mountPropertyPanelWithReducer(sceneWithThreeShapes(), ["a"]);

    await click(actionButton(container, "align-hcenter"));

    // Canevas 800 de large, calque de 100 -> (800-100)/2 = 350. S'aligner sur sa PROPRE boîte
    // englobante ne bougerait rien du tout : c'est exactement ce que ce test distingue.
    expect(frameOf(box.state, "a").x).toBe(350);
    expect(frameOf(box.state, "a").y).toBe(10);
    expect(box.state.past).toHaveLength(1);

    await click(actionButton(container, "align-bottom"));
    expect(frameOf(box.state, "a").y).toBe(550); // 600 - 50
    expect(box.state.past).toHaveLength(2); // deux gestes, deux entrées — pas un lot qui écrase l'autre

    unmount();
  });

  it("un bouton de répartition DÉSACTIVÉ (deux calques) ne dispatche rien du tout", async () => {
    const { box, container, unmount } = await mountPropertyPanelWithReducer(sceneWithThreeShapes(), ["a", "b"]);

    const button = actionButton(container, "distribute-horizontal");
    expect(button.disabled).toBe(true); // le VRAI attribut HTML, pas seulement une classe Tailwind

    await click(button);

    expect(box.actions).toEqual([]);
    expect(box.state.past).toEqual([]);
    expect(frameOf(box.state, "a")).toEqual({ x: 40, y: 10, w: 100, h: 50 });

    unmount();
  });

  it("aligner un ensemble DÉJÀ aligné ne crée AUCUNE entrée d'historique (pas d'annulation fantôme)", async () => {
    // Le pendant d'interface du no-op du réducteur : deux clics de suite sur le même bouton ne doivent
    // pas laisser deux « annuler » à consommer pour un seul déplacement réel.
    const { box, container, unmount } = await mountPropertyPanelWithReducer(sceneWithThreeShapes(), ["a", "b", "c"]);

    await click(actionButton(container, "align-left"));
    expect(box.state.past).toHaveLength(1);

    await click(actionButton(container, "align-left"));
    expect(box.state.past).toHaveLength(1);

    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Seam 9 — Guides d'accrochage RENDUS, à travers de VRAIS événements pointeur DOM (Tâche 5, U2,
// spec §5). tests/studio-snap.test.ts prouve le moteur pur et tests/studio-drag.test.ts son câblage
// dans `createGestureEngine` ; ni l'un ni l'autre ne rend un seul nœud. Une mutation qui supprimerait
// la boucle de rendu des guides de components/studio/canvas.tsx, qui n'y passerait pas le contexte
// d'accroche (`useLayerDrag(dispatch, scale)` sans troisième argument), ou qui laisserait les guides
// affichés après le pointerup, laisserait ces deux fichiers ENTIÈREMENT verts.
function guideEls(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('[data-testid="snap-guide"]')) as HTMLElement[];
}

describe("Canvas — accrochage et guides à travers de VRAIS événements pointeur DOM (Tâche 5, U2)", () => {
  it("glisser un calque à 4px du centre du plan de travail : le calque accroche, UN guide est rendu, et il disparaît au relâchement", async () => {
    // Calque « b » en (200, 200), 120×80. Glisser de (+196, +44) -> bord gauche brut 396, à 4 du centre
    // du plan de travail (800/2 = 400) : accroche à 400. Les autres positions x (456 -> 400 = 56 ;
    // 516 -> 533,33 = 17,3) et l'axe y (244/284/324, à ≥ 16 de 200/300) restent hors seuil : UN guide.
    const { box, container, unmount } = await mountCanvasWithReducer(sceneWithTwoShapes(), ["b"]);
    const b = layerEl(container, "b");

    expect(guideEls(container)).toHaveLength(0); // aucun guide hors geste

    await pointer(b, "pointerdown", { clientX: 250, clientY: 250, button: 0 });
    await pointer(b, "pointermove", { clientX: 446, clientY: 294 });

    // (a) l'APERÇU est accroché — le calque rendu est à 400, pas à 396.
    expect(parseFloat(layerEl(container, "b").style.left)).toBe(400);
    expect(parseFloat(layerEl(container, "b").style.top)).toBe(244);

    // (b) le guide est un VRAI nœud, à la bonne place, d'un pixel ÉCRAN d'épaisseur (k=1 ici).
    const guides = guideEls(container);
    expect(guides).toHaveLength(1);
    expect(guides[0].getAttribute("data-guide-axis")).toBe("x");
    expect(guides[0].getAttribute("data-guide-at")).toBe("400");
    expect(guides[0].getAttribute("data-guide-kind")).toBe("artboard-center");
    expect(parseFloat(guides[0].style.left)).toBe(400);
    expect(parseFloat(guides[0].style.width)).toBe(1);
    expect(parseFloat(guides[0].style.height)).toBe(600); // une ligne du plan de travail le traverse
    expect(guides[0].style.pointerEvents).toBe("none");

    // (b bis) COMPOSITION, pas seulement présence (la leçon de la grille de U1) : le guide est peint
    // APRÈS les calques ET après la surcouche de poignées, dans le conteneur mis à l'échelle — sinon un
    // calque opaque le recouvrirait, puisque rien ici ne porte de z-index.
    const inner = guides[0].parentElement!;
    const kids = Array.from(inner.children);
    expect(inner.lastElementChild).toBe(guides[0]);
    expect(kids.indexOf(guides[0])).toBeGreaterThan(kids.indexOf(layerEl(container, "b")));
    expect(kids.indexOf(guides[0]))
      .toBeGreaterThan(kids.indexOf(container.querySelector('[data-testid="handles-overlay"]')!));

    await pointer(b, "pointerup", { clientX: 446, clientY: 294 });

    // (c) le geste committe le cadre ACCROCHÉ (celui qui était à l'écran), en UNE entrée…
    expect(box.state.scene.layers.find((l) => l.id === "b")!.frame).toEqual({ x: 400, y: 244, w: 120, h: 80 });
    expect(box.state.past).toHaveLength(1);
    // …et les guides DISPARAISSENT avec l'aperçu.
    expect(guideEls(container)).toHaveLength(0);

    unmount();
  });

  it("un glisser qui n'accroche rien ne rend AUCUN guide et suit le chemin historique", async () => {
    // Même calque, glisser de (+37, +44) : positions x 237/297/357, à ≥ 29,7 de toute ligne.
    const { box, container, unmount } = await mountCanvasWithReducer(sceneWithTwoShapes(), ["b"]);
    const b = layerEl(container, "b");

    await pointer(b, "pointerdown", { clientX: 250, clientY: 250, button: 0 });
    await pointer(b, "pointermove", { clientX: 287, clientY: 294 });
    expect(guideEls(container)).toHaveLength(0);
    expect(parseFloat(layerEl(container, "b").style.left)).toBe(237);

    await pointer(b, "pointerup", { clientX: 287, clientY: 294 });
    expect(box.actions).toContainEqual({ type: "moveLayer", id: "b", dx: 37, dy: 44 });
    expect(box.state.scene.layers.find((l) => l.id === "b")!.frame).toEqual({ x: 237, y: 244, w: 120, h: 80 });

    unmount();
  });

  it("redimensionner par la poignée « e » accroche le bord tiré et rend son guide", async () => {
    // « b » en (200, 200), 120×80 : bord droit 320. Glisser de +76 -> bord droit brut 396, à 4 de 400
    // -> w = 200. Le bord OUEST (ancré) ne bouge pas.
    const { box, container, unmount } = await mountCanvasWithReducer(sceneWithTwoShapes(), ["b"]);
    const handle = container.querySelector('[data-handle="e"]') as HTMLElement;
    expect(handle).not.toBeNull();

    await pointer(handle, "pointerdown", { clientX: 0, clientY: 0 });
    await pointer(handle, "pointermove", { clientX: 76, clientY: 0 });

    const overlay = container.querySelector('[data-testid="handles-overlay"]') as HTMLElement;
    expect(parseFloat(overlay.style.width)).toBe(200);
    expect(parseFloat(overlay.style.left)).toBe(200);
    const guides = guideEls(container);
    expect(guides).toHaveLength(1);
    expect(guides[0].getAttribute("data-guide-at")).toBe("400");

    await pointer(handle, "pointerup", { clientX: 76, clientY: 0 });
    expect(box.actions).toContainEqual({
      type: "resizeLayer", id: "b", frame: { x: 200, y: 200, w: 200, h: 80 },
    });
    expect(guideEls(container)).toHaveLength(0);

    unmount();
  });
});

describe("Canvas — l'épaisseur d'un guide est constante à L'ÉCRAN, pas dans le gabarit (Tâche 5, U2)", () => {
  it("à k=0,5 le trait fait 2px GABARIT, donc 1px écran comme à k=1", async () => {
    // Même défaut que la revue du Lot 2 (Important 3) avait trouvé sur les poignées : une longueur en
    // px gabarit posée à l'intérieur du conteneur `transform: scale(k)` rend à `Nk` px écran, donc
    // invisible aux petits zooms (k≈0,31 pour `story`). Le guide compense par `1 / scale`.
    // Glisser de (+196, +40) px GABARIT, soit (+98, +20) px écran à k=0,5 : bord gauche brut 396, à 4
    // du centre du plan de travail (400). Les positions y (240/280/320) restent à ≥ 20 des lignes y,
    // au-delà du seuil de 16 px gabarit qu'implique k=0,5 : un seul guide.
    const { container, unmount } = await mountCanvasWithReducer(sceneWithTwoShapes(), ["b"], 0.5);
    const b = layerEl(container, "b");

    await pointer(b, "pointerdown", { clientX: 125, clientY: 125, button: 0 });
    await pointer(b, "pointermove", { clientX: 223, clientY: 145 });

    const guides = guideEls(container);
    expect(guides).toHaveLength(1);
    expect(guides[0].getAttribute("data-guide-at")).toBe("400");
    expect(parseFloat(guides[0].style.width)).toBe(2); // 1 / 0,5
    expect(parseFloat(guides[0].style.marginLeft)).toBe(-1); // −0,5 / 0,5
    // Et l'accroche a bien eu lieu à cette échelle : le calque est à 400, pas à 396.
    expect(parseFloat(layerEl(container, "b").style.left)).toBe(400);

    await pointer(b, "pointerup", { clientX: 223, clientY: 145 });
    expect(guideEls(container)).toHaveLength(0);
    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Seam — TokenPicker (components/studio/token-picker.tsx), Tâche 5 (U4). `pickerRowsFor` (testée
// PUREMENT dans tests/studio-token-picker.test.ts) prouve que la LISTE contient bien une ligne
// grisée avec sa raison pour un jeton hors contexte — mais ce fichier-là ne peut PAS prouver le
// COMPORTEMENT au clic : `PopoverContent` (@/components/ui/popover, @base-ui/react) ne rend son
// contenu QUE popover OUVERT (portalé dans `document.body`), et `renderToStaticMarkup` ne l'ouvre
// jamais (voir le commentaire de tests/studio-token-picker.test.ts). Un sabotage qui ferait quand
// même appeler `onPick` sur une ligne `aria-disabled="true"` laisserait donc TOUTE la suite pure
// verte — seul un VRAI Popover, un VRAI clic DOM, dit si la ligne grisée est réellement inerte.
// Même piège que documenté en tête de fichier pour le Popover d'ImageAssetPicker (Seam 1) : gardé par
// le même `it.skipIf(!popoverEffectsLive)`.
describe("TokenPicker — un jeton ILLÉGAL grisé n'insère RIEN au clic ; un jeton LÉGAL, lui, insère bien {{jeton}} (Tâche 5, U4)", () => {
  function sceneWithOneTextLayer(): Scene {
    return {
      schemaVersion: 1,
      canvas: { width: 1200, height: 630, background: "#000000" },
      layers: [{
        id: "t", name: "Titre", visible: true, locked: false,
        frame: { x: 10, y: 10, w: 400, h: 100 },
        type: "text", content: "Bonjour",
        font: { family: "Noto Sans", size: 32, weight: 400 },
        color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
      }],
    };
  }

  it.skipIf(!popoverEffectsLive)(
    "quote_card × contenu texte : article.byline (illégal ici) reste inerte au clic ; article.title (légal) insère {{article.title}}",
    async () => {
      const context: TemplateContext = "quote_card";
      // Prémisse — dérivée de pickerRowsFor, jamais recodée : quote_card légalise article.title mais
      // pas article.byline (CONTEXT_TOKENS, lib/studio/tokens.ts). Si CONTEXT_TOKENS changeait un
      // jour, ce test échouerait ICI plutôt que de prouver moins qu'il ne prétend.
      const { pickerRowsFor } = await import("@/components/studio/token-picker");
      const rows = pickerRowsFor(context, "text");
      expect(rows.find((r) => r.id === "article.byline")!.available).toBe(false);
      expect(rows.find((r) => r.id === "article.title")!.available).toBe(true);

      const { box, container, unmount } = await mountPropertyPanelWithReducer(
        sceneWithOneTextLayer(), ["t"], context,
      );

      const trigger = container.querySelector('[data-action="token-picker"][data-kind="text"]') as HTMLButtonElement;
      expect(trigger).not.toBeNull();
      expect(trigger.getAttribute("aria-expanded")).toBe("false");

      await click(trigger); // VRAI clic DOM sur le VRAI déclencheur du Popover
      await flush();
      expect(trigger.getAttribute("aria-expanded")).toBe("true");

      // Le Popover portale son contenu dans `document.body` — jamais dans le conteneur détaché de
      // mount() (même mécanique que le Seam Images ci-dessus).
      const byline = document.body.querySelector('[data-token="article.byline"]') as HTMLButtonElement | null;
      const title = document.body.querySelector('[data-token="article.title"]') as HTMLButtonElement | null;
      expect(byline).not.toBeNull();
      expect(title).not.toBeNull();

      // L'ÉTAT ACCESSIBLE réel, pas une sous-chaîne : la classe Tailwind statique de CES DEUX boutons
      // contient elle-même "disabled:not-allowed"-like fragments potentiels — c'est `aria-disabled`
      // qui distingue, et NI L'UN NI L'AUTRE ne porte l'attribut HTML `disabled` (les deux restent
      // focusables, piège documenté par le brief de cette tâche).
      expect(byline!.hasAttribute("disabled")).toBe(false);
      expect(byline!.getAttribute("aria-disabled")).toBe("true");
      expect(title!.hasAttribute("disabled")).toBe(false);
      expect(title!.getAttribute("aria-disabled")).not.toBe("true");

      // 1) Clic sur la ligne GRISÉE (illégale ici) : AUCUN dispatch, contenu INCHANGÉ.
      await click(byline!);
      expect(box.actions).toEqual([]);
      expect((box.state.scene.layers[0] as { content: string }).content).toBe("Bonjour");

      // 2) Clic sur la ligne DISPONIBLE : le VRAI réducteur reçoit bien setLayerProp, et le contenu
      // du calque est CONCATÉNÉ du jeton — jamais un appel direct à onPick/dispatch simulé.
      await click(title!);
      expect(box.actions.some((a) => a.type === "setLayerProp")).toBe(true);
      expect((box.state.scene.layers[0] as { content: string }).content).toBe("Bonjour{{article.title}}");

      unmount();
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Seam — le sélecteur d'emplacement (image/QR) grise une option ILLÉGALE via `SelectItem disabled`
// plutôt que de l'omettre (Tâche 5, U4, coverage audit — components/studio/property-panel.tsx,
// ImageFields/QrFields). Première utilisation de `disabled` sur `SelectItem` dans ce dépôt (grep
// vérifié) : contrairement à `SwitchField`/`TabsTrigger`, dont le comportement `disabled` est déjà
// exercé ailleurs, celui-ci n'a AUCUN précédent testé — d'où ce test dédié plutôt qu'une confiance
// aveugle dans la lecture de `useFocusableWhenDisabled.js` (node_modules/@base-ui/react) qui a guidé
// l'implémentation. Même piège Base UI que TokenPicker : `<div role="option" aria-disabled="true">`,
// jamais l'attribut HTML `disabled`, et le popup se portale dans `document.body` seulement une fois
// OUVERT — ce test-ci pilote donc le VRAI `<Select>`, pas une simulation.
describe("SelectField (emplacement image/QR) — une option ILLÉGALE reste dans la liste mais n'est PAS sélectionnable au clic (Tâche 5, U4)", () => {
  function sceneWithImageLayerSlot(slot: string): Scene {
    return {
      schemaVersion: 1,
      canvas: { width: 1080, height: 1080, background: "#111111" },
      layers: [{
        id: "img1", name: "Image", visible: true, locked: false,
        frame: { x: 0, y: 0, w: 300, h: 200 },
        type: "image", source: { kind: "slot", slot }, fit: "cover",
      }],
    };
  }

  it.skipIf(!popoverEffectsLive)(
    "newsletter_header : article.image (illégal ici) apparaît GRISÉ dans la liste ; le sélectionner au clic laisse `slot` INCHANGÉ",
    async () => {
      const context: TemplateContext = "newsletter_header";
      // Prémisse dérivée de pickerRowsFor : newsletter_header ne légalise QUE brand.logo côté
      // "image" (CONTEXT_TOKENS.newsletter_header = [edition.title, edition.date, brand.logo]) —
      // article.image y est donc illégal, et reste pourtant dans la liste (Tâche 5).
      const { pickerRowsFor } = await import("@/components/studio/token-picker");
      const rows = pickerRowsFor(context, "image");
      expect(rows.find((r) => r.id === "article.image")!.available).toBe(false);
      expect(rows.find((r) => r.id === "brand.logo")!.available).toBe(true);

      const { box, container, unmount } = await mountPropertyPanelWithReducer(
        sceneWithImageLayerSlot("brand.logo"), ["img1"], context,
      );

      const trigger = container.querySelector('[data-field="image-slot"]') as HTMLElement;
      expect(trigger).not.toBeNull();
      expect(trigger.getAttribute("aria-expanded")).toBe("false");

      await click(trigger);
      await flush();
      expect(trigger.getAttribute("aria-expanded")).toBe("true");

      // Le popup se portale dans `document.body`, jamais dans le conteneur détaché de mount().
      const options = Array.from(document.body.querySelectorAll('[role="option"]')) as HTMLElement[];
      const illegal = options.find((o) => o.textContent?.includes("Image de l'article"));
      expect(illegal).toBeDefined();
      // L'ÉTAT ACCESSIBLE réel : jamais l'attribut HTML `disabled` (SelectItem rend un `<div>`, pas
      // un `<button>`), toujours `aria-disabled="true"`.
      expect(illegal!.hasAttribute("disabled")).toBe(false);
      expect(illegal!.getAttribute("aria-disabled")).toBe("true");

      await click(illegal!); // VRAI clic DOM sur l'option grisée

      // AUCUN commit : le réducteur ne voit passer AUCUNE action, et `source.slot` reste "brand.logo".
      expect(box.actions).toEqual([]);
      const layer = box.state.scene.layers[0];
      expect(layer.type === "image" && layer.source.kind === "slot" ? layer.source.slot : null).toBe("brand.logo");

      unmount();
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Seam 10 — Chantier B, Tâche 1 : le KEYMAP CENTRAL (lib/studio/keymap.ts + hooks/use-editor-
// keymap.ts), à travers de VRAIS événements clavier `window`. tests/studio-keymap.test.ts prouve
// `resolveShortcut`/`isEditingText` en PUR (littéraux, aucun DOM) ; ni lui ni les tests unitaires du
// hook (il n'y en a pas — un hook n'a de sens qu'attaché à un composant) ne disent un mot du CÂBLAGE
// réel : que EditorShell monte bien l'écouteur `window`, que Suppr/flèches ont RÉELLEMENT migré hors
// de Canvas (et pas simplement dupliqués en plus), et que la garde de focus s'applique à un VRAI
// `<input>` du panneau de calques — pas à un littéral `{ tagName: "INPUT" }` de complaisance.
//
// Chaque test ci-dessous RATTACHE son conteneur à `document.body` (même recette que
// tests/studio-mode-switch.test.ts#mountAttached) : un événement dispatché dans un arbre DÉTACHÉ
// n'atteint jamais `window`, où vit l'écouteur central (hooks/use-editor-keymap.ts).
//
// `shellLayerEl` (et non le `layerEl` partagé plus haut) : dès qu'un calque est sélectionné et que
// le panneau « calques » est ouvert, `RenameField` (layer-panel.tsx) pose lui aussi un
// `data-layer-id` sur son `<Input>` de renommage — un `layerEl` non scopé au canevas peut donc
// résoudre vers CE `<input>` plutôt que vers le nœud du calque sur le canevas, selon l'ordre du DOM.
// Trouvé PAR la Tâche 1 elle-même (un premier jet de ce fichier ciblait le mauvais nœud et lisait un
// `style.left` vide) — scopé ici pour de bon.
function shellLayerEl(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector(`[data-testid="studio-canvas"] [data-layer-id="${id}"]`) as HTMLElement | null;
  if (!el) throw new Error(`nœud CANEVAS du calque « ${id} » absent du DOM monté`);
  return el;
}

function shellSceneTwoLayers(): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 1080, height: 1080, background: "#111111" },
    layers: [
      {
        id: "t", name: "Texte", visible: true, locked: false,
        frame: { x: 10, y: 10, w: 200, h: 80 },
        type: "text", content: "Contenu",
        font: { family: "Noto Sans", size: 24, weight: 400 },
        color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
      },
      {
        id: "u", name: "Autre texte", visible: true, locked: false,
        frame: { x: 300, y: 300, w: 150, h: 80 },
        type: "text", content: "Second",
        font: { family: "Noto Sans", size: 24, weight: 400 },
        color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
      },
    ],
  };
}

/** Monte le VRAI `EditorShell` sur `scene`, RATTACHÉ à `document.body` (nécessaire pour que les
 * événements clavier ciblés sur un calque ou un `<input>` du panneau atteignent l'écouteur `window`
 * du keymap central). `cleanup()` démonte ET détache, sur le modèle de
 * tests/studio-mode-switch.test.ts#mountAttached. */
async function mountShellAttached(scene: Scene) {
  const { container, unmount } = await mount(
    React.createElement(EditorShellC, {
      template: TEMPLATE, initialScene: scene, publishedScene: null, versions: [], previewArticles: [],
    }),
  );
  document.body.appendChild(container);
  return {
    container,
    cleanup: () => { unmount(); container.remove(); },
  };
}

function sceneWithOneShapeLayer(): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 1080, height: 1080, background: "#111111" },
    layers: [{
      id: "sh", name: "Forme", visible: true, locked: false,
      frame: { x: 10, y: 10, w: 200, h: 200 },
      type: "shape", shape: "rect", fill: "#CCCCCC",
    }],
  };
}

describe("EditorShell — le keymap central câble ⌘Z/⌘⇧Z/⌘A/Échap/Suppr/flèches sur `window` (Chantier B, Tâche 1)", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("⌘A RÉEL sur `window` sélectionne TOUS les calques", async () => {
    const { container, cleanup } = await mountShellAttached(shellSceneTwoLayers());
    try {
      expect(shellLayerEl(container, "t").getAttribute("data-selected")).toBeNull();
      expect(shellLayerEl(container, "u").getAttribute("data-selected")).toBeNull();

      await pressKey({ key: "a", metaKey: true });

      expect(shellLayerEl(container, "t").getAttribute("data-selected")).toBe("true");
      expect(shellLayerEl(container, "u").getAttribute("data-selected")).toBe("true");
    } finally {
      cleanup();
    }
  });

  // CRITIQUE (revue post-livraison) — c'est CE test, sur le VRAI EditorShell (avec son VRAI
  // PropertyPanel), qui manquait au premier jet : celui-ci utilisait un harnais Canvas+réducteur SANS
  // PropertyPanel qui MASQUAIT le défaut réel. Vérifié RED avant le correctif (phase de capture +
  // garde de popup, hooks/use-editor-keymap.ts + lib/studio/keymap.ts) : avec l'ancien écouteur en
  // bouillonnement, ce test-ci échouait — `shellLayerEl(container, "t").getAttribute("data-selected")`
  // restait `"true"` après Échap, un `<SelectField>` du panneau de propriétés (posé dès qu'un calque
  // est sélectionné, quel que soit son type) interceptant l'événement avant `window`.
  it("Échap RÉEL efface la sélection — à travers le VRAI EditorShell (PropertyPanel COMPRIS)", async () => {
    const { container, cleanup } = await mountShellAttached(shellSceneTwoLayers());
    try {
      await pointer(shellLayerEl(container, "t"), "pointerdown", { clientX: 50, clientY: 30, button: 0 });
      expect(shellLayerEl(container, "t").getAttribute("data-selected")).toBe("true");

      await pressKey({ key: "Escape" });

      expect(shellLayerEl(container, "t").getAttribute("data-selected")).toBeNull();
    } finally {
      cleanup();
    }
  });

  // LA GARDE DE POPUP (revue post-livraison) — le corollaire du passage en capture ci-dessus : un
  // `<Select>` RÉELLEMENT ouvert (pas seulement monté fermé, comme le test précédent) doit encore
  // pouvoir se fermer sur Échap SANS que le keymap central ne désélectionne le calque en même temps.
  //
  // `it.skipIf(!popoverEffectsLive)` — MÊME garde que les seams Images/TokenPicker/SelectField en
  // tête de fichier (Seam 1 et suivants) : ouvrir RÉELLEMENT un `<Select>` (le tiroir inspecteur en
  // `Sheet`, PUIS le popup du `SelectField` lui-même) dépend du même `useIsoLayoutEffect` qu'eux —
  // sans `--isolate`, un fichier voisin peut l'avoir figé en no-op AVANT ce fichier-ci, et le
  // déclencheur `[data-field="shape"]` n'atteint alors jamais le DOM (`bun run test:pure`, qui
  // agrège tous les fichiers dans le même processus, l'a montré rouge — voir task-1-report.md).
  it.skipIf(!popoverEffectsLive)("Échap avec un VRAI <Select> OUVERT ferme le POPUP au lieu de désélectionner (garde de popup)", async () => {
    const { container, cleanup } = await mountShellAttached(sceneWithOneShapeLayer());
    try {
      await pointer(shellLayerEl(container, "sh"), "pointerdown", { clientX: 50, clientY: 50, button: 0 });
      expect(shellLayerEl(container, "sh").getAttribute("data-selected")).toBe("true");

      // Cherché dans `document`, jamais `container` : sous 1280px (largeur par défaut de jsdom, ici),
      // le panneau de propriétés vit dans le tiroir inspecteur (`Sheet`, base-ui `Dialog`), PORTALÉ
      // dans `document.body` — un `container.querySelector` ne le trouve pas à cette largeur.
      const trigger = document.querySelector('[data-field="shape"]') as HTMLButtonElement | null;
      expect(trigger).not.toBeNull();
      await click(trigger!);
      await flush();
      expect(trigger!.getAttribute("aria-expanded")).toBe("true");
      // Le popup est RÉELLEMENT ouvert selon le signal EXACT que `lib/studio/keymap.ts#isPopupOpen`
      // regarde (`aria-haspopup` + `aria-expanded="true"` sur le déclencheur) — pas `[data-open]`, qui
      // se serait AUSSI révélé vrai avant ce clic (sections repliables ouvertes par défaut, tiroir
      // inspecteur déjà ouvert) et n'aurait donc rien prouvé de spécifique à CE popup.
      expect(document.querySelector('[aria-haspopup][aria-expanded="true"]')).not.toBeNull();

      await pressKey({ key: "Escape" });

      // Le POPUP s'est fermé (base-ui a bien reçu l'événement — notre écouteur, en capture, s'est
      // effacé devant lui via la garde de popup)…
      expect(trigger!.getAttribute("aria-expanded")).toBe("false");
      // …et la sélection du calque N'A PAS été effacée par le keymap central au même geste.
      expect(shellLayerEl(container, "sh").getAttribute("data-selected")).toBe("true");
    } finally {
      cleanup();
    }
  });

  it("une flèche RÉELLE déplace le calque sélectionné — Suppr/flèches ont RÉELLEMENT migré hors de Canvas#handleKeyDown", async () => {
    const { container, cleanup } = await mountShellAttached(shellSceneTwoLayers());
    try {
      // Sélectionne « t » par un VRAI pointerdown (sans pointerup — aucun geste de glisser à committer,
      // même recette que les tests de sélection simple plus haut dans ce fichier).
      await pointer(shellLayerEl(container, "t"), "pointerdown", { clientX: 50, clientY: 30, button: 0 });
      expect(shellLayerEl(container, "t").getAttribute("data-selected")).toBe("true");

      await pressKey({ key: "ArrowRight" });
      expect(parseFloat(shellLayerEl(container, "t").style.left)).toBe(11); // 10 + NUDGE_STEP(1)

      await pressKey({ key: "ArrowDown", shiftKey: true });
      expect(parseFloat(shellLayerEl(container, "t").style.top)).toBe(20); // 10 + NUDGE_STEP_SHIFT(10)
    } finally {
      cleanup();
    }
  });

  it("Suppr RÉEL supprime le calque sélectionné", async () => {
    const { container, cleanup } = await mountShellAttached(shellSceneTwoLayers());
    try {
      await pointer(shellLayerEl(container, "u"), "pointerdown", { clientX: 320, clientY: 320, button: 0 });
      expect(shellLayerEl(container, "u").getAttribute("data-selected")).toBe("true");

      await pressKey({ key: "Delete" });

      expect(container.querySelector('[data-testid="studio-canvas"] [data-layer-id="u"]')).toBeNull();
      // « t », lui, n'a pas bougé — Suppr n'agit que sur la sélection, jamais sur le reste de la scène.
      expect(shellLayerEl(container, "t")).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it("⌘Z RÉEL annule le dernier geste committé, ⌘⇧Z RÉEL le rétablit", async () => {
    const { container, cleanup } = await mountShellAttached(shellSceneTwoLayers());
    try {
      await pointer(shellLayerEl(container, "t"), "pointerdown", { clientX: 50, clientY: 30, button: 0 });
      await pressKey({ key: "ArrowRight" }); // UN geste committé (moveLayer -> une entrée d'historique)
      expect(parseFloat(shellLayerEl(container, "t").style.left)).toBe(11);

      await pressKey({ key: "z", metaKey: true });
      expect(parseFloat(shellLayerEl(container, "t").style.left)).toBe(10); // annulé

      await pressKey({ key: "z", metaKey: true, shiftKey: true });
      expect(parseFloat(shellLayerEl(container, "t").style.left)).toBe(11); // rétabli
    } finally {
      cleanup();
    }
  });

  it("LA GARDE DE FOCUS : ⌘Z et ⌘A ciblés sur un VRAI <input> de renommage (layer-panel.tsx) ne dispatchent RIEN (mutation : sans la garde, ce test rougit)", async () => {
    // Panneau « calques » ouvert au montage — seul chemin non interactif pour obtenir le VRAI
    // <input data-action="rename"> de RenameField (même recette que le test ⌘/ plus haut).
    window.localStorage.setItem(
      "studio.editor-prefs",
      JSON.stringify({ ...DEFAULT_PREFS, openPanel: "calques", lastOpenPanel: "calques" }),
    );
    const { container, cleanup } = await mountShellAttached(shellSceneTwoLayers());
    try {
      // Un geste committé D'ABORD : si la garde de ⌘Z ci-dessous ne tenait pas, il y aurait quelque
      // chose de RÉEL à annuler, et ce test le verrait.
      await pointer(shellLayerEl(container, "t"), "pointerdown", { clientX: 50, clientY: 30, button: 0 });
      await pressKey({ key: "ArrowRight" });
      expect(parseFloat(shellLayerEl(container, "t").style.left)).toBe(11);

      const renameInput = container.querySelector(
        '[data-action="rename"][data-layer-id="u"]',
      ) as HTMLInputElement | null;
      expect(renameInput).not.toBeNull();
      // Sélectionne « u » par un VRAI pointerdown sur le canevas (même geste que les autres tests de
      // ce fichier) plutôt que par `renameInput.focus()` : jsdom + le suivi de valeur des champs
      // contrôlés de React (`handleEventsForInputEventPolyfill`, cherchant un `attachEvent` propre à
      // IE, absent de jsdom) rend un VRAI `.focus()` imprévisible dans ce harnais — repéré en
      // instrumentant le montage, voir task-1-report.md. `isEditingText` (lib/studio/keymap.ts) ne
      // regarde de toute façon que `e.target` de l'événement clavier, jamais `document.activeElement` :
      // CIBLER `renameInput` avec `pressKey` ci-dessous prouve la garde exactement de la même façon,
      // sans dépendre d'un focus DOM réel.
      await pointer(shellLayerEl(container, "u"), "pointerdown", { clientX: 320, clientY: 320, button: 0 });
      expect(shellLayerEl(container, "u").getAttribute("data-selected")).toBe("true");
      expect(shellLayerEl(container, "t").getAttribute("data-selected")).toBeNull();

      await pressKey({ key: "z", metaKey: true }, renameInput!);
      // ⌘Z gardé : la position de « t » (annulable) N'A PAS bougé.
      expect(parseFloat(shellLayerEl(container, "t").style.left)).toBe(11);

      await pressKey({ key: "a", metaKey: true }, renameInput!);
      // ⌘A gardé : « t » reste NON sélectionné.
      expect(shellLayerEl(container, "t").getAttribute("data-selected")).toBeNull();
    } finally {
      cleanup();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chantier B, Tâche 2 — le presse-papiers en session (⌘C/⌘V/⌘D), câblé à travers le VRAI EditorShell
// (même discipline que le bloc ⌘Z/⌘A/Échap/Suppr/flèches ci-dessus : un VRAI KeyboardEvent sur
// `window`, un VRAI réducteur derrière). Ce que ce fichier prouve que tests/studio-clipboard.test.ts
// (le clonage et le module clipboard, en pur) et tests/studio-keymap.test.ts (resolveShortcut, en
// pur) ne peuvent PAS prouver à eux seuls : que le hook (hooks/use-editor-keymap.ts) résout
// RÉELLEMENT la sélection courante en calques, appelle RÉELLEMENT `copyToClipboard`/
// `cloneLayersWithNewIds`, et dispatche RÉELLEMENT `addLayers` — jusqu'au DOM rendu par le VRAI
// Canvas.
//
// `clearClipboard()` entre chaque test : le presse-papiers est un singleton de MODULE, partagé par
// tout le processus `bun test` — sans ce nettoyage, un test laisserait son contenu fuiter vers le
// suivant (exactement le risque que documente déjà `afterEach` de `window.localStorage` plus haut
// dans ce fichier, pour la même raison structurelle).
describe("EditorShell — le presse-papiers en session câble ⌘C/⌘V/⌘D sur `window` (Chantier B, Tâche 2)", () => {
  afterEach(() => {
    window.localStorage.clear();
    clearClipboard();
  });

  it("⌘D RÉEL sur un calque sélectionné ajoute UN second calque, décalé de {16,16}, et le SÉLECTIONNE — UN SEUL undo revient à un seul calque", async () => {
    const { container, cleanup } = await mountShellAttached(sceneWithOneShapeLayer());
    try {
      await pointer(shellLayerEl(container, "sh"), "pointerdown", { clientX: 50, clientY: 50, button: 0 });
      expect(shellLayerEl(container, "sh").getAttribute("data-selected")).toBe("true");

      await pressKey({ key: "d", metaKey: true });

      const layerNodes = container.querySelectorAll('[data-testid="studio-canvas"] [data-layer-id]');
      expect(layerNodes).toHaveLength(2);
      // La source n'a PAS bougé…
      expect(parseFloat(shellLayerEl(container, "sh").style.left)).toBe(10);
      // …et exactement UN autre nœud est apparu, décalé de {16,16} par rapport à la source, ET
      // sélectionné à la place d'elle (⌘D transfère la sélection au nouveau calque).
      const clone = Array.from(layerNodes).find((el) => el.getAttribute("data-layer-id") !== "sh")!;
      expect(parseFloat((clone as HTMLElement).style.left)).toBe(26); // 10 + 16
      expect(parseFloat((clone as HTMLElement).style.top)).toBe(26);
      expect(clone.getAttribute("data-selected")).toBe("true");
      expect(shellLayerEl(container, "sh").getAttribute("data-selected")).toBeNull();

      await pressKey({ key: "z", metaKey: true }); // UN SEUL undo

      expect(container.querySelectorAll('[data-testid="studio-canvas"] [data-layer-id]')).toHaveLength(1);
      expect(shellLayerEl(container, "sh")).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it("⌘C puis ⌘V RÉELS : colle un clone décalé de {16,16}, sélectionné, sans toucher la source", async () => {
    const { container, cleanup } = await mountShellAttached(sceneWithOneShapeLayer());
    try {
      await pointer(shellLayerEl(container, "sh"), "pointerdown", { clientX: 50, clientY: 50, button: 0 });
      await pressKey({ key: "c", metaKey: true });

      // Copier seul n'ajoute RIEN à la scène — c'est un geste de LECTURE.
      expect(container.querySelectorAll('[data-testid="studio-canvas"] [data-layer-id]')).toHaveLength(1);

      await pressKey({ key: "v", metaKey: true });

      const layerNodes = container.querySelectorAll('[data-testid="studio-canvas"] [data-layer-id]');
      expect(layerNodes).toHaveLength(2);
      expect(parseFloat(shellLayerEl(container, "sh").style.left)).toBe(10); // source intacte
      const pasted = Array.from(layerNodes).find((el) => el.getAttribute("data-layer-id") !== "sh")!;
      expect(parseFloat((pasted as HTMLElement).style.left)).toBe(26);
      expect(pasted.getAttribute("data-selected")).toBe("true");
    } finally {
      cleanup();
    }
  });

  it("coller DEUX FOIS de suite ajoute deux clones aux ids DISTINCTS — pas le même clone réappliqué", async () => {
    const { container, cleanup } = await mountShellAttached(sceneWithOneShapeLayer());
    try {
      await pointer(shellLayerEl(container, "sh"), "pointerdown", { clientX: 50, clientY: 50, button: 0 });
      await pressKey({ key: "c", metaKey: true });
      await pressKey({ key: "v", metaKey: true });
      await pressKey({ key: "v", metaKey: true });

      const ids = Array.from(container.querySelectorAll('[data-testid="studio-canvas"] [data-layer-id]'))
        .map((el) => el.getAttribute("data-layer-id"));
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3); // aucun doublon

      // Le SECOND collage reste sélectionné seul (⌘V remplace la sélection par ce qu'il vient de
      // coller) — la preuve que les deux collages sont deux gestes indépendants, pas un geste dupliqué.
      const selected = container.querySelectorAll('[data-testid="studio-canvas"] [data-selected="true"]');
      expect(selected).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("⌘V avec le presse-papiers VIDE ne dispatche RIEN — aucun calque ajouté, AUCUNE entrée d'historique (⌘Z reste sans effet)", async () => {
    const { container, cleanup } = await mountShellAttached(sceneWithOneShapeLayer());
    try {
      // Aucun ⌘C avant : le presse-papiers du module est vide (nettoyé par afterEach ci-dessus).
      await pressKey({ key: "v", metaKey: true });
      expect(container.querySelectorAll('[data-testid="studio-canvas"] [data-layer-id]')).toHaveLength(1);

      // Anti-vacuité : PAS d'entrée d'historique fantôme à défaire — un ⌘Z ici ne fait RIEN, la scène
      // reste identique (si un `commit()` fantôme avait eu lieu, ce ⌘Z « annulerait » silencieusement
      // un vrai geste précédent au lieu de ne rien faire).
      await pressKey({ key: "z", metaKey: true });
      expect(shellLayerEl(container, "sh").style.left).toBe("10px");
    } finally {
      cleanup();
    }
  });

  it("le presse-papiers TRAVERSE deux gabarits (deux montages EditorShell distincts) — module-level, pas un état de composant", async () => {
    // Gabarit A : copie « sh ».
    const shellA = await mountShellAttached(sceneWithOneShapeLayer());
    await pointer(shellLayerEl(shellA.container, "sh"), "pointerdown", { clientX: 50, clientY: 50, button: 0 });
    await pressKey({ key: "c", metaKey: true });
    shellA.cleanup(); // démonte ENTIÈREMENT le premier EditorShell — plus aucun état React vivant

    // Gabarit B : une scène DIFFÉRENTE (id de calque différent, gabarit vide au départ pour ce calque).
    const otherScene: Scene = {
      schemaVersion: 1,
      canvas: { width: 1080, height: 1080, background: "#222222" },
      layers: [],
    };
    const shellB = await mountShellAttached(otherScene);
    try {
      await pressKey({ key: "v", metaKey: true });

      const nodes = shellB.container.querySelectorAll('[data-testid="studio-canvas"] [data-layer-id]');
      expect(nodes).toHaveLength(1);
      // Le calque collé est bien un CLONE de « sh » (même style de départ, un id NEUF, décalé) — pas
      // le calque original du gabarit A ni un id partagé avec lui.
      expect(nodes[0].getAttribute("data-layer-id")).not.toBe("sh");
      expect(parseFloat((nodes[0] as HTMLElement).style.left)).toBe(26); // 10 + 16
    } finally {
      shellB.cleanup();
    }
  });

  it("LA GARDE DE FOCUS : ⌘C/⌘V/⌘D ciblés sur un VRAI <input> de renommage ne dispatchent RIEN (le navigateur garde la main sur son propre copier/coller)", async () => {
    window.localStorage.setItem(
      "studio.editor-prefs",
      JSON.stringify({ ...DEFAULT_PREFS, openPanel: "calques", lastOpenPanel: "calques" }),
    );
    const { container, cleanup } = await mountShellAttached(shellSceneTwoLayers());
    try {
      const renameInput = container.querySelector(
        '[data-action="rename"][data-layer-id="t"]',
      ) as HTMLInputElement | null;
      expect(renameInput).not.toBeNull();

      await pointer(shellLayerEl(container, "t"), "pointerdown", { clientX: 50, clientY: 30, button: 0 });
      expect(shellLayerEl(container, "t").getAttribute("data-selected")).toBe("true");

      await pressKey({ key: "c", metaKey: true }, renameInput!);
      await pressKey({ key: "d", metaKey: true }, renameInput!);
      await pressKey({ key: "v", metaKey: true }, renameInput!);

      // Toujours DEUX calques (« t », « u ») — aucun ajout, la garde a bloqué les trois raccourcis.
      expect(container.querySelectorAll('[data-testid="studio-canvas"] [data-layer-id]')).toHaveLength(2);
    } finally {
      cleanup();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chantier B, Tâche 4 — pan (Espace-glisser) + zoom molette centré curseur, à travers de VRAIS
// événements DOM sur `editor-shell.tsx#canvasWrapRef` (data-testid="canvas-backdrop") — PAS
// canvas.tsx, qui ne porte pas le conteneur `overflow-auto` (voir le commentaire de tête de ce
// conteneur dans editor-shell.tsx). `mountShellAttached`/`shellLayerEl`/`sceneWithOneShapeLayer`
// viennent du bloc « presse-papiers » juste au-dessus.

function backdropEl(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-testid="canvas-backdrop"]') as HTMLElement | null;
  if (!el) throw new Error('« canvas-backdrop » absent du DOM monté');
  return el;
}

function artboardEl(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-testid="artboard"]') as HTMLElement | null;
  if (!el) throw new Error('« artboard » absent du DOM monté');
  return el;
}

describe("EditorShell — molette ⌘/Ctrl : zoom centré sur le curseur, défilement corrigé DANS LA MÊME FRAME que la nouvelle échelle (Chantier B, Tâche 4)", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("⌘-molette AGRANDIT et garde le point CANEVAS sous le curseur EXACTEMENT fixe — le défilement corrigé atteint le VRAI DOM", async () => {
    const { container, cleanup } = await mountShellAttached(sceneWithOneShapeLayer());
    try {
      const backdrop = backdropEl(container);
      // §0 non-régression : avant toute interaction molette/Espace, rien de spécial.
      expect(backdrop.style.cursor).toBe("");
      expect(backdrop.scrollLeft).toBe(0);
      expect(backdrop.scrollTop).toBe(0);

      backdrop.scrollLeft = 40;
      backdrop.scrollTop = 20;

      // `fitScale` reste à sa valeur par défaut (1) — jsdom ne mesure aucun `clientWidth` réel, donc
      // `computeCanvasScale` (editor-shell.tsx) n'a jamais de quoi produire une valeur différente ; et
      // `getBoundingClientRect()` d'un élément jsdom vaut toujours {top:0,left:0,…}, donc `cursor` égale
      // `clientX`/`clientY` bruts. `prevScale` = fitScale(1) × facteur "fit"(1) = 1 : EXACTEMENT ce que
      // `scale` vaut dans editor-shell.tsx au moment de ce test.
      const prevScale = 1;
      const cursor = { x: 130, y: 90 };
      const scroll = { x: backdrop.scrollLeft, y: backdrop.scrollTop };
      // Le MÊME calcul que le gestionnaire réel (editor-shell.tsx#handleCanvasWheel), à partir des
      // MÊMES fonctions PURES importées — ce test prouve le CÂBLAGE (le vrai DOM reçoit-il le résultat
      // ?), pas une redécouverte indépendante de la formule.
      const rawNextScale = wheelZoomScale(prevScale, -100);
      const nextFactor = clampZoom(rawNextScale / 1); // fitScale = 1
      const nextScale = 1 * nextFactor;
      const expected = zoomAtCursor(prevScale, nextScale, cursor, scroll, { width: 0, height: 0 });

      await wheel(backdrop, { ctrlKey: true, deltaY: -100, clientX: cursor.x, clientY: cursor.y });

      // (a) l'échelle a RÉELLEMENT changé — l'artboard a grandi : la preuve que `setZoom` a bien été
      // appelé avec le facteur attendu, pas seulement calculé sans jamais être appliqué.
      expect(nextScale).toBeGreaterThan(prevScale); // deltaY négatif -> agrandit (sinon ce test ne prouverait rien)
      expect(parseFloat(artboardEl(container).style.width)).toBeCloseTo(1080 * nextScale, 6);

      // (b) le défilement CORRIGÉ (pas l'ancien, pas un défilement quelconque) a atterri au VRAI DOM —
      // c'est ce qui garde le point pointé fixe à l'écran malgré le changement d'échelle. MUTATION
      // (brief Tâche 4, Étape 3) : abandonner la correction de `zoomAtCursor` (renvoyer `scroll`
      // inchangé) ferait rougir CETTE assertion — `expected.scroll` différerait alors de `scroll`.
      expect(backdrop.scrollLeft).toBeCloseTo(expected.scroll.x, 6);
      expect(backdrop.scrollTop).toBeCloseTo(expected.scroll.y, 6);

      // (c) et le point canevas sous le curseur est bien IDENTIQUE avant/après — recalculé directement
      // à partir de ce qui a atterri au DOM, pas à partir d'`expected` (qui pourrait, en théorie,
      // partager un bug avec le code testé) : la vraie propriété que la Tâche 4 promet.
      const canvasPtBefore = { x: (scroll.x + cursor.x) / prevScale, y: (scroll.y + cursor.y) / prevScale };
      const canvasPtAfter = {
        x: (backdrop.scrollLeft + cursor.x) / nextScale,
        y: (backdrop.scrollTop + cursor.y) / nextScale,
      };
      expect(canvasPtAfter.x).toBeCloseTo(canvasPtBefore.x, 6);
      expect(canvasPtAfter.y).toBeCloseTo(canvasPtBefore.y, 6);
    } finally {
      cleanup();
    }
  });

  it("molette SEULE (sans ⌘/Ctrl) ne touche PAS le zoom — pan NATIF, AUCUN preventDefault (spec §2 du brief)", async () => {
    const { container, cleanup } = await mountShellAttached(sceneWithOneShapeLayer());
    try {
      const backdrop = backdropEl(container);
      const widthBefore = artboardEl(container).style.width;

      const event = await wheel(backdrop, { deltaY: -100, clientX: 100, clientY: 100 }); // pas de ctrlKey/metaKey

      // Le navigateur garde la main sur son propre défilement natif — un `preventDefault()` ici
      // BLOQUERAIT le pan natif que le brief demande explicitement de laisser faire.
      expect(event.defaultPrevented).toBe(false);
      expect(artboardEl(container).style.width).toBe(widthBefore); // aucun changement d'échelle
      expect(backdrop.scrollLeft).toBe(0); // et rien n'a été écrit dans scrollLeft/Top non plus
      expect(backdrop.scrollTop).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("le pincement trackpad (un `wheel` avec `ctrlKey` synthétisé par le navigateur) emprunte le MÊME chemin — pas de double traitement", async () => {
    const { container, cleanup } = await mountShellAttached(sceneWithOneShapeLayer());
    try {
      const backdrop = backdropEl(container);
      const widthBefore = parseFloat(artboardEl(container).style.width);

      const event = await wheel(backdrop, { ctrlKey: true, deltaY: -50, clientX: 60, clientY: 40 });

      expect(event.defaultPrevented).toBe(true); // intercepté, comme ⌘/Ctrl-molette — le MÊME chemin
      expect(parseFloat(artboardEl(container).style.width)).toBeGreaterThan(widthBefore);
    } finally {
      cleanup();
    }
  });

  it("un défilement de molette OBSOLÈTE (facteur déjà au CLAMP, la molette continue de tourner) ne corrompt PAS un zoom RÉEL et SANS RAPPORT survenant plus tard (revue chantier B T4, Important)", async () => {
    // LE BUG (trouvé en revue) : `handleCanvasWheel` écrivait `pendingWheelScrollRef` et appelait
    // `setZoom` INCONDITIONNELLEMENT, même quand `nextFactor` retombe sur la MÊME valeur que `factor`
    // (le facteur est déjà au clamp 8×/0,1×, ou un `deltaY` nul) — un geste parfaitement ORDINAIRE
    // (l'utilisateur continue de tourner la molette sans savoir qu'il a atteint la borne). Puisque
    // `scale` ne change alors PAS numériquement, le `useLayoutEffect` keyed sur `[scale]` ne se
    // redéclenche JAMAIS (`Object.is` sur une valeur inchangée) — la correction reste ORPHELINE dans
    // la ref jusqu'au PROCHAIN changement RÉEL de `scale`, par un chemin complètement différent (ici,
    // le bouton « − » du slot), qui l'appliquerait alors À TORT, écrasant un défilement entre-temps
    // devenu obsolète pour un curseur/geste qui n'a plus rien à voir.
    const { container, cleanup } = await mountShellAttached(sceneWithOneShapeLayer());
    try {
      const backdrop = backdropEl(container);

      // 1) ⌘-molette avec un `deltaY` énorme -> facteur immédiatement CLAMPÉ au maximum (8×) en un
      // seul événement (déterministe quelle que soit `WHEEL_ZOOM_SENSITIVITY`, un réglage produit
      // explicitement non figé — voir lib/studio/zoom.ts). Un défilement corrigé, RÉEL, est appliqué
      // ici : l'échelle a RÉELLEMENT changé, l'effet se déclenche.
      await wheel(backdrop, { ctrlKey: true, deltaY: -5000, clientX: 60, clientY: 40 });
      expect(parseFloat(artboardEl(container).style.width)).toBeCloseTo(1080 * 8, 6); // bien au clamp (ZOOM_STEPS max)

      // 2) La molette continue de tourner DANS LE MÊME SENS alors que le facteur est DÉJÀ au clamp —
      // `nextFactor` vaut encore 8 : AUCUN changement d'échelle ne doit avoir lieu (la garde). Un
      // curseur DÉLIBÉRÉMENT différent de l'étape 1, pour qu'une correction calculée à partir de LUI
      // (si elle était écrite à tort) soit clairement distinguable d'un no-op véritable.
      const widthAtClamp = artboardEl(container).style.width;
      await wheel(backdrop, { ctrlKey: true, deltaY: -5000, clientX: 999, clientY: 777 });
      expect(artboardEl(container).style.width).toBe(widthAtClamp); // no-op confirmé : rien n'a bougé

      // 3) Puis quelque chose d'AUTRE fait défiler le conteneur — un pan natif (molette SANS ⌘/Ctrl,
      // Espace-glisser, une poignée de barre de défilement…) : SANS RAPPORT avec le zoom, jamais câblé
      // pour corriger quoi que ce soit. Simulé ICI directement sur `scrollLeft`/`scrollTop` — le
      // MÉCANISME exact importe peu, seul compte qu'un défilement RÉEL a eu lieu entre le no-op de
      // l'étape 2 et le zoom SANS RAPPORT de l'étape 4.
      backdrop.scrollLeft = 500;
      backdrop.scrollTop = 300;

      // 4) Un zoom RÉEL et SANS RAPPORT avec la molette : le bouton « − » du slot
      // (lib/studio/zoom.ts#nextZoom), un chemin qui NE touche JAMAIS `scrollLeft`/`scrollTop` lui-même.
      const zoomOut = container.querySelector('[data-testid="zoom-out"]') as HTMLButtonElement;
      expect(zoomOut).not.toBeNull();
      await click(zoomOut);
      expect(parseFloat(artboardEl(container).style.width)).toBeCloseTo(1080 * 6, 6); // nextZoom(8,-1) = 6 : l'échelle a bien changé

      // Le défilement de l'étape 3 doit SURVIVRE intact — AUCUNE correction de molette obsolète ne
      // doit l'écraser. AVANT le correctif : le `pendingWheelScrollRef` laissé par l'étape 2
      // s'appliquerait ICI (premier changement RÉEL de `scale` après son écriture), ramenant le
      // défilement à une valeur calculée pour un curseur/geste qui n'a plus rien à voir.
      expect(backdrop.scrollLeft).toBe(500);
      expect(backdrop.scrollTop).toBe(300);
    } finally {
      cleanup();
    }
  });
});

describe("EditorShell — l'écouteur `wheel` est posé NON PASSIF (revue chantier B T4, Important — passage réel navigateur)", () => {
  // Ce que le contrôleur a trouvé en conditions RÉELLES (jsdom ne simule pas la passivité d'un
  // écouteur, donc AUCUN test contre le COMPORTEMENT — molette bloquée, page qui ne zoome pas — ne
  // peut détecter ce défaut-là ici) : `onWheel={handleCanvasWheel}` (une prop JSX React) délègue au
  // SEUL écouteur `wheel` racine que React pose, PASSIF par défaut — `e.preventDefault()` y est un
  // no-op silencieux. Le canevas zoomait bien au bon endroit, mais le NAVIGATEUR zoomait AUSSI la
  // page entière. Ce test épingle donc le CÂBLAGE (comment l'écouteur est posé), pas le symptôme
  // (que jsdom ne peut pas observer) — la seule façon de garder ce correctif honnête sous `bun test`.
  it("`canvasWrapRef` reçoit un VRAI `addEventListener('wheel', …, { passive: false })` natif — pas une prop `onWheel` React", async () => {
    // `spyOn` seul ne rapporte pas `this` (bun:test) — un monkey-patch manuel le capture, pour SCOPER
    // l'assertion au SEUL `canvasWrapRef` (data-testid="canvas-backdrop"). Nécessaire : l'arbre
    // EditorShell monte d'autres composants base-ui qui posent LEUR PROPRE écouteur "wheel" ailleurs
    // (ex. `ScrollAreaViewport`, `NumberFieldRoot` du panneau de propriétés — `NumberFieldRoot`
    // documente d'ailleurs LE MÊME piège dans son propre code source : « React attaches onWheel as a
    // passive listener, so calling preventDefault there is ignored ») — un simple filtre sur le TYPE
    // d'événement compterait AUSSI leurs écouteurs à eux, dont certains sont légitimement passifs (ce
    // ne sont pas les nôtres, pas notre affaire), et ferait planter ce test pour une raison qui n'a
    // rien à voir avec le correctif vérifié ici.
    const calls: Array<{ target: EventTarget; options: unknown }> = [];
    const original = HTMLElement.prototype.addEventListener;
    HTMLElement.prototype.addEventListener = function (
      this: HTMLElement,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type === "wheel") calls.push({ target: this, options });
      return original.call(this, type, listener, options);
    } as typeof HTMLElement.prototype.addEventListener;

    try {
      const { container, cleanup } = await mountShellAttached(sceneWithOneShapeLayer());
      try {
        const backdrop = backdropEl(container);
        const ourCalls = calls.filter((c) => c.target === backdrop);
        // AU MOINS un écouteur "wheel" sur `canvasWrapRef` lui-même — l'effet de
        // editor-shell.tsx#handleCanvasWheel doit avoir tourné (conteneur monté, `layout !==
        // "too-small"` en jsdom par défaut) — sinon ce test ne prouverait rien (anti-vacuité).
        expect(ourCalls.length).toBeGreaterThan(0);
        for (const call of ourCalls) {
          // MUTATION (revue) : omettre `{ passive: false }`, ou le poser à `true`/`undefined`/`false`
          // (arg booléen legacy = `useCapture`, PAS `passive`), doit rougir CETTE assertion — c'est
          // exactement le défaut réel trouvé par le contrôleur.
          expect(typeof call.options).toBe("object");
          expect((call.options as AddEventListenerOptions).passive).toBe(false);
        }
      } finally {
        cleanup();
      }
    } finally {
      HTMLElement.prototype.addEventListener = original;
    }
  });

  it("un aller-retour Montage -> Rendu réel -> Montage (ModeSwitch) RÉ-ATTACHE l'écouteur `wheel` sur le NOUVEAU nœud — régression trouvée en repassage navigateur", async () => {
    // LE BUG (trouvé en repassage navigateur, PAS par bun test) : `canvas-backdrop` est démonté par
    // DEUX conditions indépendantes, pas une seule — `layout !== "too-small"` ET `mode === "montage"`
    // (`mode === "rendu"` monte `<RenderMode>` à la place, un arbre ENTIÈREMENT différent). Le premier
    // jet de l'effet ne dépendait que de `[layout]` : un aller-retour de MODE (ModeSwitch, ou le
    // raccourci « R ») démonte l'ancien `canvas-backdrop` et en monte un NOUVEAU nœud DOM SANS jamais
    // faire varier `layout` — l'effet ne se redéclenchait donc JAMAIS, le nouveau nœud n'avait AUCUN
    // écouteur `wheel`, et le bug d'origine (⌘/Ctrl-molette zoome la PAGE, pas le canevas) revenait
    // silencieusement après un aller-retour de mode pourtant tout à fait ordinaire.
    const calls: Array<{ target: EventTarget; options: unknown }> = [];
    const original = HTMLElement.prototype.addEventListener;
    HTMLElement.prototype.addEventListener = function (
      this: HTMLElement,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type === "wheel") calls.push({ target: this, options });
      return original.call(this, type, listener, options);
    } as typeof HTMLElement.prototype.addEventListener;

    try {
      const { container, cleanup } = await mountShellAttached(sceneWithOneShapeLayer());
      try {
        const firstBackdrop = backdropEl(container);
        expect(calls.some((c) => c.target === firstBackdrop)).toBe(true); // le PREMIER nœud a bien reçu son écouteur

        const modeRendu = container.querySelector('[data-action="mode-rendu"]') as HTMLElement | null;
        const modeMontage = container.querySelector('[data-action="mode-montage"]') as HTMLElement | null;
        expect(modeRendu).not.toBeNull();
        expect(modeMontage).not.toBeNull();

        await click(modeRendu!); // Montage -> Rendu réel : `canvas-backdrop` DÉMONTÉ (RenderMode à la place)
        expect(container.querySelector('[data-testid="canvas-backdrop"]')).toBeNull();

        await click(modeMontage!); // Rendu réel -> Montage : un NOUVEAU `canvas-backdrop` est monté

        const secondBackdrop = backdropEl(container);
        expect(secondBackdrop).not.toBe(firstBackdrop); // bien un NŒUD DOM DIFFÉRENT, pas le même réutilisé

        const ourCallsOnSecondNode = calls.filter((c) => c.target === secondBackdrop);
        // LE cœur du correctif : le NOUVEAU nœud, lui aussi, a reçu un `addEventListener("wheel", …,
        // { passive: false })` — pas zéro appel (ce qu'un effet keyed sur `[layout]` seul laisserait,
        // puisque `layout` n'a jamais changé pendant tout cet aller-retour).
        expect(ourCallsOnSecondNode.length).toBeGreaterThan(0);
        for (const call of ourCallsOnSecondNode) {
          expect(typeof call.options).toBe("object");
          expect((call.options as AddEventListenerOptions).passive).toBe(false);
        }
      } finally {
        cleanup();
      }
    } finally {
      HTMLElement.prototype.addEventListener = original;
    }
  });
});

describe("EditorShell — Espace-glisser : pan du conteneur, curseur grab/grabbing, SANS toucher aucun calque (Chantier B, Tâche 4)", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("Espace maintenu -> curseur « grab » ; pointer-drag DÉMARRÉ SUR UN CALQUE change scrollLeft/scrollTop SANS le déplacer ni le sélectionner", async () => {
    const { container, cleanup } = await mountShellAttached(sceneWithOneShapeLayer());
    try {
      const backdrop = backdropEl(container);
      expect(backdrop.style.cursor).toBe(""); // §0 : rien de spécial avant Espace

      await pressKey({ key: " ", code: "Space" }); // bubbling document -> window, même chemin que ⌘/ (voir plus haut)
      expect(backdrop.style.cursor).toBe("grab");

      const layerBefore = {
        x: parseFloat(shellLayerEl(container, "sh").style.left),
        y: parseFloat(shellLayerEl(container, "sh").style.top),
      };

      // Le pointerdown démarre SUR LE CALQUE lui-même (pas sur le fond vide) — la preuve la plus
      // dure : ce même geste, SANS Espace, sélectionnerait/déplacerait « sh » (voir le bloc « tirer un
      // calque » plus haut dans ce fichier). En mode pan, la CAPTURE de canvasWrapRef doit intercepter
      // l'événement avant qu'il n'atteigne le gestionnaire de Canvas.
      await pointer(shellLayerEl(container, "sh"), "pointerdown", { clientX: 50, clientY: 50, button: 0 });
      expect(backdrop.style.cursor).toBe("grabbing");
      // Le pointerdown n'a NI sélectionné NI armé de glisser sur le calque — la garde de capture a
      // bien fonctionné.
      expect(shellLayerEl(container, "sh").getAttribute("data-selected")).toBeNull();

      // Les événements suivants du MÊME geste (capture pointeur réelle en navigateur) sont dispatchés
      // sur `canvasWrapRef` lui-même — c'est LUI qui porte les écouteurs natifs posés au pointerdown
      // (voir editor-shell.tsx#handleCanvasPointerDownCapture).
      await pointer(backdrop, "pointermove", { clientX: 90, clientY: 65 }); // +40 en x, +15 en y

      // « glisser à droite -> le contenu se déplace à droite -> scrollLeft DIMINUE » (spec §2 du brief)
      expect(backdrop.scrollLeft).toBe(-40);
      expect(backdrop.scrollTop).toBe(-15);

      await pointer(backdrop, "pointerup", { clientX: 90, clientY: 65 });
      expect(backdrop.style.cursor).toBe("grab"); // le GLISSER finit ; Espace reste maintenu -> retombe sur « grab »

      // Et surtout : AUCUN calque n'a bougé, malgré 40×15px de glisser — le geste a changé la VUE
      // (scroll), jamais `state.scene`.
      const layerAfter = {
        x: parseFloat(shellLayerEl(container, "sh").style.left),
        y: parseFloat(shellLayerEl(container, "sh").style.top),
      };
      expect(layerAfter).toEqual(layerBefore);

      await releaseKey({ key: " ", code: "Space" });
      expect(backdrop.style.cursor).toBe(""); // Espace relâché -> retour au curseur par défaut
    } finally {
      cleanup();
    }
  });

  it("relâcher Espace PENDANT un glisser sort du mode pan — un pointermove qui suit ne défile plus", async () => {
    const { container, cleanup } = await mountShellAttached(sceneWithOneShapeLayer());
    try {
      const backdrop = backdropEl(container);

      await pressKey({ key: " ", code: "Space" });
      await pointer(backdrop, "pointerdown", { clientX: 0, clientY: 0, button: 0 });
      await pointer(backdrop, "pointermove", { clientX: 20, clientY: 10 });
      expect(backdrop.scrollLeft).toBe(-20);
      expect(backdrop.scrollTop).toBe(-10);

      await releaseKey({ key: " ", code: "Space" }); // relâché AVANT le pointerup
      // Le curseur retombe IMMÉDIATEMENT au relâchement d'Espace, même glisser en cours — le signal
      // visible que le brief nomme (« Release Space … exits pan mode »). La capture pointeur native
      // (hors de portée de jsdom) peut continuer de router le geste jusqu'au pointerup/pointercancel
      // réel ; ce test porte délibérément sur le CURSEUR, pas sur le défilement, pour cette raison.
      expect(backdrop.style.cursor).toBe("");

      await pointer(backdrop, "pointerup", { clientX: 20, clientY: 10 }); // nettoie le geste en attente
    } finally {
      cleanup();
    }
  });

  it("Espace ciblé sur un VRAI champ de texte n'arme PAS le pan — la garde de focus (isEditingText) protège un espace tapé dans un nom de calque", async () => {
    window.localStorage.setItem(
      "studio.editor-prefs",
      JSON.stringify({ ...DEFAULT_PREFS, openPanel: "calques", lastOpenPanel: "calques" }),
    );
    const { container, cleanup } = await mountShellAttached(shellSceneTwoLayers());
    try {
      const backdrop = backdropEl(container);
      const renameInput = container.querySelector(
        '[data-action="rename"][data-layer-id="t"]',
      ) as HTMLInputElement | null;
      expect(renameInput).not.toBeNull();

      const event = await pressKey({ key: " ", code: "Space" }, renameInput!);

      expect(backdrop.style.cursor).toBe(""); // AUCUN mode pan armé
      expect(event.defaultPrevented).toBe(false); // le champ garde la main : un espace tapé doit rester un espace
    } finally {
      cleanup();
    }
  });
});
