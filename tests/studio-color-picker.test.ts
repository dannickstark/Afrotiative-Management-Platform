import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installDom, mount, click, flush, pointer } from "./dom-harness";
import type { TemplateContext } from "@/lib/studio/tokens";

// tests/studio-color-picker.test.ts — Chantier C, Tâche 4 (brief) : le VRAI sélecteur de couleur
// (components/studio/color-picker.tsx), monté via le harnais U0 (tests/dom-harness.ts), de VRAIS
// événements DOM (clic, glisser pointeur) plutôt qu'un appel direct à un gestionnaire React
// introspecté — même discipline que tests/studio-scrub-field.test.ts (NumberField) et
// tests/studio-interactions.test.ts (Popover/TokenPicker).
//
// ── Le même piège Popover que tests/studio-interactions.test.ts (voir son commentaire de tête,
// ligne ~21) : `@base-ui/utils/useIsoLayoutEffect.mjs` résout `typeof document !== "undefined"` UNE
// SEULE FOIS, à l'évaluation du module — un singleton partagé par tout le processus `bun test`. Si
// un AUTRE fichier a déjà importé, sans DOM, un composant touchant Popover/Button avant que CE
// fichier n'installe le sien, le Popover réel de `<ColorPicker>` n'ouvrira jamais son contenu ici
// non plus. La sonde ci-dessous mesure le SYMPTÔME directement (comme dans studio-interactions) et
// SAUTE (jamais un succès silencieux) les tests qui ont besoin du VRAI contenu du Popover si
// l'environnement est déjà poison. Lancer ce fichier SEUL (ou `bun test --isolate`) donne toujours
// popoverEffectsLive = true.
// La sonde tourne à un `await` de NIVEAU MODULE (jamais dans `beforeAll`) — `describe`/`it.skipIf`
// plus bas s'exécutent SYNCHRONEMENT à l'évaluation du fichier, avant qu'un `beforeAll` async n'ait
// la moindre chance de tourner : `popoverEffectsLive` DOIT donc already être à sa valeur finale au
// moment où `it.skipIf(!popoverEffectsLive)` est lu, exactement le même ordre que
// tests/studio-interactions.test.ts (son commentaire de tête explique le mécanisme complet).
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
    const probe = await mount(React.createElement(Probe));
    probe.unmount();
    popoverEffectsLive = ran;
  } finally {
    probeTeardown();
  }
}
if (!popoverEffectsLive) {
  console.warn(
    "\n[tests/studio-color-picker.test.ts] tests dépendant du VRAI contenu du Popover sautés — " +
    "useIsoLayoutEffect a été figé sur un noop par un autre fichier de ce process `bun test`. " +
    "Relancer avec `bun test --isolate …` (ou ce fichier seul) pour qu'ils s'exécutent réellement — " +
    "voir tests/studio-interactions.test.ts pour l'explication complète.\n",
  );
}

// Globals que jsdom 30 (sans `pretendToBeVisual`) ne fournit pas et que `installDom()` (Tâche 1, U0)
// n'installe pas — même liste, pour la même raison, que `installExtraGlobals()` dans
// tests/studio-interactions.test.ts (son commentaire de tête l'explique en détail) : Popover monte
// un contexte floating-ui-react DÈS le montage (pas seulement à l'ouverture), qui fait
// `value instanceof Element` (le global BARE, pas `window.Element`) et calcule un positionnement
// (`getComputedStyle`, planifié par `requestAnimationFrame`) même pour un popup fermé. Sans ces
// globals, monter `<ColorPicker>` lève `ReferenceError: Element is not defined` au tout premier
// rendu, avant la moindre interaction — vérifié directement (RED sans ce bloc).
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
let ColorPickerC: typeof import("@/components/studio/color-picker").ColorPicker;
let recentColorsModule: typeof import("@/components/studio/color-picker");

beforeAll(async () => {
  teardownDom = installDom();
  teardownExtraGlobals = installExtraGlobals();
  recentColorsModule = await import("@/components/studio/color-picker");
  ({ ColorPicker: ColorPickerC } = recentColorsModule);
});

afterAll(() => {
  teardownExtraGlobals();
  teardownDom();
});

let currentUnmount: (() => void) | null = null;
afterEach(() => {
  currentUnmount?.();
  currentUnmount = null;
  // `recentColors` est un singleton de MODULE (session) — le vider entre les tests évite qu'une
  // pastille « récente » laissée par un test ne décale les index d'un autre (même discipline que
  // `clearClipboard()` dans tests/studio-interactions.test.ts).
  recentColorsModule.recentColors.length = 0;
});

async function mountColorPicker(props: { value: string; context: TemplateContext; onCommit: (v: string) => void }) {
  const { container, unmount: rawUnmount } = await mount(React.createElement(ColorPickerC, props));
  document.body.appendChild(container);
  const unmount = () => { rawUnmount(); container.remove(); };
  currentUnmount = unmount;

  const trigger = container.querySelector('[data-testid="color-picker-trigger"]') as HTMLButtonElement | null;
  if (!trigger) throw new Error('déclencheur [data-testid="color-picker-trigger"] absent du DOM monté');

  async function open() {
    await click(trigger!);
    await flush();
  }

  // Le Popover portale son contenu dans `document.body` (@base-ui/react/popover), jamais dans le
  // conteneur détaché de `mount()` — même précédent que tests/studio-interactions.test.ts.
  async function openAndClickSwatch(index: number) {
    await open();
    const swatches = document.body.querySelectorAll('[data-testid="color-swatch"]');
    const swatch = swatches[index] as HTMLButtonElement | undefined;
    if (!swatch) throw new Error(`pastille de nuancier #${index} absente du Popover ouvert`);
    await click(swatch);
  }

  async function openTokenTabAndPickFirst() {
    await open();
    const tokenTab = document.body.querySelector('[data-testid="color-token-tab"]') as HTMLElement | null;
    if (!tokenTab) throw new Error('onglet « Jeton » [data-testid="color-token-tab"] absent');
    await click(tokenTab);
    await flush();
    const firstAvailable = document.body.querySelector('[data-token][data-available="true"]') as HTMLElement | null;
    if (!firstAvailable) throw new Error("aucune ligne de jeton DISPONIBLE dans l'onglet Jeton");
    await click(firstAvailable);
  }

  // Tape un hex dans le champ `color-hex` puis déclenche son commit au blur — VRAIS événements DOM
  // ("input" natif via le setter du PROTOTYPE HTMLInputElement, jamais `.value =` direct, qui
  // laisserait le tracker de valeur de React croire que rien n'a changé ; "focusout" natif pour le
  // blur, jamais `.focus()`/`.blur()` réels — voir le commentaire de tête de
  // tests/studio-scrub-field.test.ts sur l'imprévisibilité de `.focus()` avec le suivi de valeur des
  // champs contrôlés de React sous jsdom).
  async function openTypeHexBlur(hex: string) {
    await open();
    const hexInput = document.body.querySelector('[data-testid="color-hex"]') as HTMLInputElement | null;
    if (!hexInput) throw new Error('champ [data-testid="color-hex"] absent du Popover ouvert');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(hexInput, hex);
      hexInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await act(async () => {
      hexInput.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
    });
    await flush();
  }

  return { container, trigger, open, openAndClickSwatch, openTokenTabAndPickFirst, openTypeHexBlur, unmount };
}

describe("ColorPicker — Chantier C, Tâche 4", () => {
  it.skipIf(!popoverEffectsLive)(
    "cliquer une pastille de nuancier commit son hex, EXACTEMENT celui cliqué (anti-vacuité : une couleur fixe rougirait ceci)",
    async () => {
      const onCommit = mock((_v: string) => {});
      const first = await mountColorPicker({ value: "#000000", context: "article_image", onCommit });

      await first.openAndClickSwatch(0); // première pastille de BRAND_SWATCHES

      expect(onCommit).toHaveBeenCalledTimes(1);
      const committed = onCommit.mock.calls[0][0];
      expect(committed).toMatch(/^#[0-9a-f]{6}$/);
      first.unmount(); // referme (et retire du DOM) le premier Popover AVANT d'en ouvrir un second —
      // le Popover portale dans `document.body` (jamais le conteneur de `mount()`), donc laisser le
      // premier ouvert décalerait les index de `querySelectorAll` du second.

      // Anti-vacuité RENFORCÉE : cliquer une AUTRE pastille (index 1, une couleur différente de
      // l'index 0) doit committer une VALEUR DIFFÉRENTE — un composant qui committerait toujours la
      // MÊME couleur fixe, quelle que soit la pastille cliquée, passerait la seule assertion de
      // regex ci-dessus mais rougirait celle-ci.
      const onCommit2 = mock((_v: string) => {});
      const second = await mountColorPicker({ value: "#000000", context: "article_image", onCommit: onCommit2 });
      await second.openAndClickSwatch(1);
      expect(onCommit2).toHaveBeenCalledTimes(1);
      expect(onCommit2.mock.calls[0][0]).not.toBe(committed);
    },
  );

  it.skipIf(!popoverEffectsLive)(
    "l'onglet Jeton commit {{id}} — la liaison U4 préservée EXACTEMENT (une couleur reste une valeur UNIQUE, littérale OU jeton)",
    async () => {
      const onCommit = mock((_v: string) => {});
      const { openTokenTabAndPickFirst } = await mountColorPicker({ value: "#000000", context: "article_image", onCommit });

      await openTokenTabAndPickFirst();

      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit.mock.calls[0][0]).toMatch(/^\{\{.+\}\}$/);
    },
  );

  it.skipIf(!popoverEffectsLive)(
    "taper un hex COURT + blur commit le hex NORMALISÉ (#f00 -> #ff0000), via formatHex",
    async () => {
      const onCommit = mock((_v: string) => {});
      const { openTypeHexBlur } = await mountColorPicker({ value: "#000000", context: "article_image", onCommit });

      await openTypeHexBlur("#f00");

      expect(onCommit).toHaveBeenCalledWith("#ff0000");
    },
  );

  it.skipIf(!popoverEffectsLive)(
    "§0 : une valeur {{jeton}} initiale affiche l'état LIÉ (damier, jamais une couleur inventée) ET ouvre l'onglet Jeton",
    async () => {
      const onCommit = mock((_v: string) => {});
      const { container, open } = await mountColorPicker({
        value: "{{category.color}}", context: "article_image", onCommit,
      });

      // Le déclencheur affiche le damier — jamais `backgroundColor` (qui essaierait de peindre le
      // texte littéral "{{category.color}}" comme une couleur CSS, ce qui échouerait silencieusement).
      const swatchPreview = container.querySelector('[data-testid="color-swatch-preview"]') as HTMLElement;
      expect(swatchPreview.style.backgroundImage).toContain("repeating-linear-gradient");
      expect(swatchPreview.style.backgroundColor).toBe("");
      // Et le texte affiché est bien la forme `{{jeton}}` brute, pas un hex fabriqué.
      expect(container.textContent).toContain("{{category.color}}");

      await open();

      // L'onglet Jeton est bien celui qui a le focus/l'état ACTIF à l'ouverture — reflet direct du
      // fait que la valeur courante EST un jeton (jamais l'onglet Couleur, qui montrerait un repli
      // noir opaque sans lien apparent avec la valeur réellement liée).
      const tokenTab = document.body.querySelector('[data-testid="color-token-tab"]') as HTMLElement;
      expect(tokenTab.getAttribute("data-active")).not.toBeNull();
    },
  );

  // Revue coordinateur (Important 1) : `Tabs` (components/ui/tabs.tsx, @base-ui/react) est NON
  // contrôlé — `defaultValue` ne choisit l'onglet actif qu'AU PREMIER MONTAGE de `Tabs` lui-même. Le
  // test §0 ci-dessus MONTE une nouvelle instance avec une valeur `{{jeton}}` DÈS le départ — il ne
  // peut donc pas épingler la régression réelle : la MÊME instance de `ColorPicker`, restée montée
  // ET LE POPOVER RESTANT OUVERT (fermer puis rouvrir démonte déjà `PopoverContent` — donc `Tabs` —
  // et réapplique `defaultValue` de toute façon, quelle que soit la clé ; vérifié directement en
  // retirant `key` : le scénario « fermer/rouvrir » reste vert même SANS le correctif, un faux
  // témoin qu'une première version de ce test a failli garder), dont `value` bascule d'un littéral à
  // un `{{jeton}}` PENDANT que le Popover est ouvert (ex. un ⌘Z/⌘⇧Z qui change `layer.color` pendant
  // que l'utilisateur regarde le sélecteur). Ce test-ci REND (`root.render`, jamais un remontage) le
  // MÊME arbre React avec une nouvelle prop `value` SANS fermer le Popover entre les deux.
  it.skipIf(!popoverEffectsLive)(
    "un ColorPicker OUVERT dont la valeur bascule littéral -> {{jeton}} (sans fermer/rouvrir) affiche l'onglet Jeton (jamais le dernier onglet actif)",
    async () => {
      const onCommit = mock((_v: string) => {});
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root: Root = createRoot(container);
      // Enregistré AVANT toute assertion (jamais seulement en fin de test) : un `expect` qui rougit
      // au milieu de ce test ne doit PAS laisser ce Popover/`root` orphelin dans `document.body` —
      // une fuite qui polluerait les `document.body.querySelector` des tests SUIVANTS (vécu : une
      // première version de ce test, RED sur l'assertion clé, faisait aussi rougir le test du glisser
      // teinte qui le suit, par pollution de `document.body`, pas par un vrai défaut du glisser).
      currentUnmount = () => { act(() => { root.unmount(); }); container.remove(); };

      await act(async () => {
        root.render(React.createElement(ColorPickerC, { value: "#ffffff", context: "article_image", onCommit }));
      });

      const trigger = container.querySelector('[data-testid="color-picker-trigger"]') as HTMLButtonElement;
      expect(trigger).not.toBeNull();

      // Ouvre avec la valeur LITTÉRALE — l'onglet Couleur (défaut) est actif, jamais Jeton, ce que
      // l'assertion ci-dessous vérifie AVANT de considérer prouvé quoi que ce soit sur l'après.
      await click(trigger);
      await flush();
      const couleurTab = document.body.querySelector('[role="tab"]:not([data-testid="color-token-tab"])') as HTMLElement;
      const tokenTabBefore = document.body.querySelector('[data-testid="color-token-tab"]') as HTMLElement;
      expect(couleurTab).not.toBeNull();
      expect(couleurTab.getAttribute("data-active")).not.toBeNull();
      expect(tokenTabBefore.getAttribute("data-active")).toBeNull();

      // MÊME instance, MÊME Popover OUVERT (aucun clic de fermeture entre les deux `render`) : la
      // valeur bascule vers un jeton — le geste qu'un ⌘Z produirait sur ce même calque pendant que le
      // sélecteur reste affiché.
      await act(async () => {
        root.render(React.createElement(ColorPickerC, { value: "{{category.color}}", context: "article_image", onCommit }));
      });
      await flush();

      const tokenTabAfter = document.body.querySelector('[data-testid="color-token-tab"]') as HTMLElement;
      expect(tokenTabAfter).not.toBeNull();
      // Sans la clé `key={isToken ? "jeton" : "couleur"}` sur `<Tabs>`, `defaultValue` n'est jamais
      // ré-évalué pour un `Tabs` déjà monté et l'onglet Couleur resterait actif ici — RED sans le
      // correctif (vérifié directement : ce test rougit si on retire la clé).
      expect(tokenTabAfter.getAttribute("data-active")).not.toBeNull();
    },
  );

  it.skipIf(!popoverEffectsLive)(
    "un glisser COMPLET sur le curseur teinte, jusqu'au bord DROIT, commit UNE SEULE FOIS un hex VALIDE — jamais de NaN (carry-forward T1)",
    async () => {
      const onCommit = mock((_v: string) => {});
      const { open } = await mountColorPicker({ value: "#ff0000", context: "article_image", onCommit });
      await open();

      const hueTrack = document.body.querySelector('[data-testid="color-hue"]') as HTMLElement;
      expect(hueTrack).not.toBeNull();
      // jsdom ne mesure jamais de layout réel (getBoundingClientRect toujours à zéro) — on pose un
      // rectangle explicite pour que le ratio position->fraction soit déterministe, même précédent
      // que canvas-context-menu.tsx (VirtualElement) pour un besoin similaire ailleurs dans ce dépôt.
      hueTrack.getBoundingClientRect = () => ({
        left: 0, top: 0, right: 200, bottom: 12, width: 200, height: 12, x: 0, y: 0, toJSON: () => ({}),
      });

      await pointer(hueTrack, "pointerdown", { clientX: 0, clientY: 6 });
      // clientX = 200 == fraction 1.0 == h = 360 EXACTEMENT avant normalisation — le cas que le
      // carry-forward T1 demande de couvrir.
      await pointer(hueTrack, "pointermove", { clientX: 200, clientY: 6 });
      await pointer(hueTrack, "pointerup", { clientX: 200, clientY: 6 });

      expect(onCommit).toHaveBeenCalledTimes(1); // UNE SEULE entrée d'historique pour tout le glisser
      const committed = onCommit.mock.calls[0][0] as string;
      expect(committed).toMatch(/^#[0-9a-f]{6}$/); // jamais "#NaNNaNNaN"
      expect(committed).not.toContain("NaN");
    },
  );
});
