import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import React from "react";
import { installDom, mount, click, pressKey, flush, pointer } from "./dom-harness";
import { editorReducer, initEditorState, type EditorAction, type EditorState } from "@/lib/studio/editor-state";
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
 * `mountCanvasWithReducer` ci-dessus (le panneau est contrôlé : scène et sélection en props). */
async function mountPropertyPanelWithReducer(scene: Scene, initialSelection: string[]) {
  const initial: EditorState = { ...initEditorState(scene), selectedIds: initialSelection };
  const box: { state: EditorState; actions: EditorAction[] } = { state: initial, actions: [] };

  function Host() {
    const [state, rawDispatch] = React.useReducer(editorReducer, initial);
    box.state = state;
    return React.createElement(PropertyPanelC, {
      scene: state.scene,
      selectedIds: state.selectedIds,
      context: "social_post" as TemplateContext,
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
