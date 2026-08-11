import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import React from "react";
import { installDom, mount, click, pressKey } from "./dom-harness";
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
// ── Limite de plateforme découverte pendant cette tâche, PAS un correctif silencieux de
// tests/dom-harness.ts — détaillée dans task-2-report.md ────────────────────────────────────────
//
// Le seam Images (onPick) DEVRAIT s'exercer en cliquant une VRAIE vignette derrière le VRAI Popover
// de components/studio/asset-picker.tsx#ImageAssetPicker. Ce clic FONCTIONNE, à 100%, quand ce
// fichier tourne SEUL (`bun test tests/studio-interactions.test.ts`) : `useIsoLayoutEffect`
// (@base-ui/utils) résout correctement `typeof document !== "undefined"` UNE FOIS `installDom()`
// appelé, ImagesPanel/asset-picker.tsx sont importés dynamiquement APRÈS coup, et le Popover monte
// réellement sa vignette dans `document.body`.
//
// Il échoue dès que ce fichier tourne aux côtés de N'IMPORTE LEQUEL des ~20 fichiers qui rendent un
// composant studio via `renderToStaticMarkup` SANS jamais poser de DOM — dont
// tests/studio-texte-panel.test.ts ET tests/studio-editor-shell.test.ts, EXACTEMENT la combinaison
// exigée par l'Étape 4 du brief. Cause racine, vérifiée empiriquement (voir l'historique de ce
// fichier pour la démonstration pas à pas) : `useIsoLayoutEffect.mjs` fige sa réponse À
// L'ÉVALUATION DU MODULE (un singleton ES partagé par tout le processus `bun test`), pas à chaque
// appel. Si CE FICHIER voisin importe, même statiquement et sans jamais monter de DOM, un composant
// qui touche `Button` (donc `useButton.mjs`, donc `useIsoLayoutEffect.mjs`) AVANT que
// `installDom()` n'ait tourné ICI, le module se fige sur `noop` pour le reste du processus — et bun
// exécute les fichiers de test dans un ordre qui n'est NI l'ordre alphabétique NI l'ordre des
// arguments CLI (vérifié), donc aucun repoussement de nos propres imports ne peut gagner cette
// course : le fichier voisin peut s'exécuter dans SA TOTALITÉ avant que la moindre ligne de CE
// fichier ne tourne. Une fois figé, plus aucun `mock.module()` ultérieur ne change quoi que ce
// soit : les modules consommateurs déjà évalués ont capturé la valeur `noop` dans une liaison
// `const`, jamais réassignée. Contournement essayé et ABANDONNÉ : remplacer `ImageAssetPicker` par
// un double via `mock.module("@/components/studio/asset-picker", …)` — techniquement, ça fait
// marcher CE fichier, mais `@/components/studio/asset-picker` est un module PARTAGÉ (aussi importé,
// réel et non modifié, par tests/studio-asset-picker.test.ts et tests/studio-property-panel.test.ts
// via property-panel.tsx) : le mock empoisonne alors LEURS propres imports d'images-panel.tsx/
// property-panel.tsx pour le reste du processus (vérifié : casse 6 tests dans ces deux fichiers,
// et aucun `mock.module()` de restauration en `afterAll` ne répare la chose, puisque CES modules-là
// — pas seulement asset-picker.tsx — sont eux-mêmes des singletons déjà évalués avec le double
// capturé dedans). Aucun correctif n'est possible depuis CE fichier sans soit (a) un préchargement
// DOM global — explicitement interdit par les Contraintes globales, précisément pour la raison
// inverse (protéger les ~1300 tests existants) — soit (b) modifier @base-ui/react en amont. Ce
// n'est ni un bogue de composant ni un bogue du harnais de la Tâche 1.
//
// Compromis retenu, HONNÊTE plutôt que dissimulé : le test « calque image sélectionné » ci-dessous
// pilote un VRAI clic DOM sur le VRAI déclencheur du Popover (`data-testid="asset-picker"`) et
// vérifie une conséquence RÉELLE et OBSERVABLE de ce clic (`aria-expanded` bascule à `"true"` — la
// preuve qu'un clic RÉEL atteint le VRAI `onClick` composé par @base-ui/react, pas un appel direct)
// — c'est tout ce qu'un clic PEUT prouver ici, la vignette elle-même ne pouvant plus monter dans ce
// contexte multi-fichiers. L'assignation qu'un clic sur cette vignette produirait EST ENSUITE
// vérifiée en composant `pickImageForSelection` (exportée par images-panel.tsx PRÉCISÉMENT pour ce
// type de composition, même idiome que insertDynamicTextLayer/buildPresetTextLayer déjà utilisés
// ailleurs dans ce sous-projet) avec le VRAI réducteur. Limite assumée et documentée dans le rapport
// de tâche : cette dernière étape ne détecterait PAS une mutation qui romprait spécifiquement le
// CORPS de la fermeture `onPick={(assetId) => pickImageForSelection(selectedLayer, assetId,
// dispatch)}` (ex. un mauvais calque capturé) sans jamais retirer le Popover lui-même — un vrai clic
// de bout en bout le détecterait, mais n'est pas atteignable dans cette combinaison de fichiers.
//
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

let pickImageForSelectionC: typeof import("@/components/studio/panels/images-panel").pickImageForSelection;

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

  ({ ImagesPanel: ImagesPanelC, pickImageForSelection: pickImageForSelectionC } =
    await import("@/components/studio/panels/images-panel"));
  ({ TextePanel: TextePanelC } = await import("@/components/studio/panels/texte-panel"));
  ({ EditorShell: EditorShellC } = await import("@/components/studio/editor-shell"));
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
  it("calque IMAGE sélectionné -> un VRAI clic ouvre le VRAI Popover (aria-expanded), et l'assignation qu'il produirait retombe sur CE calque via le VRAI réducteur", async () => {
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

    await click(trigger); // VRAI clic DOM — voir le commentaire de tête pour la limite de plateforme
    // qui empêche la vignette elle-même de monter dans cette combinaison de fichiers : `aria-expanded`
    // bascule bien à "true" (le VRAI onClick composé par @base-ui/react a été atteint, pas contourné).
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    // La conséquence qu'un clic sur la vignette « Alpha » produirait — composée avec le VRAI
    // réducteur, comme dynamic-text.ts#insertDynamicTextLayer/text-presets.ts#buildPresetTextLayer
    // le sont déjà ailleurs dans ce sous-projet (voir le commentaire de tête pour la limite assumée).
    const selectedLayer = state.scene.layers.find((l) => l.id === "img1") ?? null;
    pickImageForSelectionC(selectedLayer, "a1", dispatch);

    const layer = state.scene.layers.find((l) => l.id === "img1");
    expect(layer?.type).toBe("image");
    expect(layer?.type === "image" ? layer.source : null).toEqual({ kind: "asset", assetId: "a1" });

    unmount();
  });

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
