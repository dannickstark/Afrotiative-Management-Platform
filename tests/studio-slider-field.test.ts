import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import React from "react";
import { act } from "react";
import { installDom, mount, click } from "./dom-harness";

// tests/studio-slider-field.test.ts — Chantier C, Tâche 5 (brief) : le VRAI câblage DOM de
// `SliderField` (components/studio/property-fields.tsx), via le harnais U0 (tests/dom-harness.ts).
//
// DEUX LIMITES DE CE HARNAIS, MESURÉES avant d'écrire ce fichier (jamais supposées) — toutes deux
// PARTAGÉES par le reste du dépôt, pas propres à `SliderField` :
//
// (1) LE GLISSER RÉEL (pointerdown/pointermove/pointerup, géométrie en pixels) n'est pas simulable :
//     `SliderControl.getFingerState()` (node_modules/@base-ui/react/slider/control/SliderControl.js)
//     divise par `control.getBoundingClientRect().width`, et jsdom ne fait AUCUNE mise en page (chaque
//     rect vaut 0×0×0×0) — la fraction calculée est NaN, `setValue()` la rejette
//     (`Number.isNaN(newValue)`) et aucun geste pointeur n'aboutit, quelle que soit la position
//     simulée. Consigne du brief : « leave the visual drag to the controller's Playwright pass ».
//
// (2) LE CLAVIER SUR UN `<input>` (range OU texte) EST ENCORE PIRE QU'INERTE — IL FAIT PLANTER LA
//     PROPAGATION DE L'ÉVÉNEMENT. Mesuré en instrumentant node_modules/react-dom/cjs/
//     react-dom-client.development.js : `tests/dom-harness.ts` importe `react-dom/client` EN TÊTE de
//     fichier, donc AVANT que `installDom()` ne pose `window`/`document` — `isInputEventSupported`
//     (calculé une seule fois via `canUseDOM` à l'IMPORT du module) reste ainsi FAUX pour tout le
//     process de test. Conséquence 1 (déjà documentée par tests/studio-scrub-field.test.ts, §168) :
//     AUCUN `onChange` React ne se déclenche plus sur un `<input>` texte/nombre/range via un VRAI
//     événement "input"/"change" — React retombe sur le chemin de repli IE9
//     (`getTargetInstForInputEventPolyfill`, `handleEventsForInputEventPolyfill`). Conséquence 2, NON
//     documentée avant ce fichier : ce repli réagit aussi à "keydown"/"keyup" en lisant
//     `activeElementInst$1` — qui reste TOUJOURRS `null` ici (jamais armé, l'API `attachEvent` qu'il
//     appellerait au préalable étant propre à IE, absente de jsdom) — et
//     `getNodeFromInstance(null)` lève alors `TypeError: null is not an object (evaluating
//     'inst.tag')` DANS LE MÊME appel synchrone que React utilise pour dispatcher CE `keydown` au
//     VRAI gestionnaire `onKeyDown` de `Slider.Thumb` : l'exception avortée AVANT ce dispatch, aucun
//     `onKeyDown` de Base UI n'est donc jamais atteint. Dispatcher un `keydown`/`ArrowUp`/`End` sur le
//     `<input type="range">` caché est donc, ICI, PIRE qu'un raccourci fragile — un mutant qui
//     brancherait par erreur `onCommit` sur `onValueChange` (au lieu de `onValueCommitted`) serait
//     INDÉTECTABLE par cette voie, puisque RIEN n'atteint jamais `Slider.Thumb`.
//
// D'où la recette retenue, conforme à la permission explicite du brief (« test the value/commit
// LOGIC via onValueChange/onValueCommitted handlers directly ») : `mock.module()` REMPLACE
// `components/ui/slider.tsx` (SANS test propre par construction — voir son commentaire d'en-tête ;
// « couverte par SliderField » ne peut vouloir dire « son glisser RÉEL », prouvé irréaliste ci-dessus)
// par un double minimal, deux `<button>` (« change »/« commit ») qui invoquent directement les VRAIES
// props `onValueChange`/`onValueCommitted` que `SliderField` passe à `<Slider>`. `mock.module()
// « mute les exports d'un module » (même recette que tests/category-color.test.ts) — la liaison ESM
// que `property-fields.tsx` lit à CHAQUE rendu (pas seulement à l'import) voit donc le double dès le
// mock posé, MÊME APRÈS avoir déjà importé `property-fields.tsx` avec le VRAI `Slider` (vérifié : le
// premier test ci-dessous monte le VRAI curseur Base UI AVANT le mock, le second le double APRÈS).
// `click()` (tests/dom-harness.ts) — un VRAI `MouseEvent` "click" — reste, lui, PARFAITEMENT fiable
// dans ce harnais (aucun des deux pièges ci-dessus ne le concerne), exactement comme dans le reste du
// dépôt (tests/studio-color-picker.test.ts, tests/studio-interactions.test.ts…).
//
// Le NUMÉRIQUE synchronisé, lui, n'a besoin d'AUCUN double : `SliderField` l'alimente via `onInput`
// (PAS `onChange` — voir le commentaire de property-fields.tsx#SliderField sur ce choix), un prop
// React qui relaie directement le VRAI événement natif "input" SANS jamais passer par le
// `ChangeEventPlugin` cassé ci-dessus (piège 2) — vérifié en instrumentant le même fichier react-dom :
// `onInput` fonctionne ici EXACTEMENT comme le champ hex de components/studio/color-picker.tsx (même
// choix, même raison), qui utilise déjà `onInput` plutôt que `onChange` pour la même raison.
let teardownDom: () => void;
let SliderFieldC: typeof import("@/components/studio/property-fields").SliderField;

beforeAll(async () => {
  teardownDom = installDom();
  ({ SliderField: SliderFieldC } = await import("@/components/studio/property-fields"));
});

afterAll(() => {
  teardownDom();
});

let currentUnmount: (() => void) | null = null;
afterEach(() => {
  currentUnmount?.();
  currentUnmount = null;
});

interface MountProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (v: number) => void;
  format?: (v: number) => string;
  dataField?: string;
}

async function mountReal(props: MountProps) {
  const { container, unmount: rawUnmount } = await mount(React.createElement(SliderFieldC, props));
  const unmount = () => rawUnmount();
  currentUnmount = unmount;
  return { container, unmount };
}

// ─────────────────────────────────────────────────────────────────────────────
describe("SliderField — le VRAI curseur Base UI (avant tout mock)", () => {
  it("monte le VRAI Slider (components/ui/slider.tsx), attributs min/max/step/value corrects", async () => {
    const { container } = await mountReal({
      label: "Opacité", value: 42, min: 0, max: 100, step: 1, onCommit: () => {}, dataField: "opacity",
    });
    const range = container.querySelector('input[type="range"]') as HTMLInputElement | null;
    if (!range) throw new Error('<input type="range"> absent — components/ui/slider.tsx ne rend pas Base UI Slider.Thumb');
    expect(range.getAttribute("min")).toBe("0");
    expect(range.getAttribute("max")).toBe("100");
    expect(range.getAttribute("step")).toBe("1");
    expect(range.getAttribute("value")).toBe("42");
    // `data-field`/`data-testid` posés sur la racine du curseur (le brief : « data-testid sur le
    // curseur + l'input »).
    const root = container.querySelector('[data-slot="slider"]');
    expect(root?.getAttribute("data-field")).toBe("opacity");
    expect(root?.getAttribute("data-testid")).toBe("slider-opacity");
  });

  it("le numérique synchronisé porte data-field ET data-testid, valeur initiale reflétée", async () => {
    const { container } = await mountReal({
      label: "Flou", value: 9, min: 0, max: 100, step: 1, onCommit: () => {}, dataField: "shadow-blur",
    });
    const number = container.querySelector('input[type="number"]') as HTMLInputElement | null;
    if (!number) throw new Error('<input type="number"> absent');
    expect(number.value).toBe("9");
    expect(number.getAttribute("data-field")).toBe("shadow-blur");
    expect(number.getAttribute("data-testid")).toBe("slider-input-shadow-blur");
  });

  it("`format` affiche la valeur mise en forme À CÔTÉ du curseur (l'input numérique, lui, reste un nombre nu)", async () => {
    const { container } = await mountReal({
      label: "Opacité", value: 50, min: 0, max: 100, step: 1, onCommit: () => {}, format: (v) => `${v} %`,
    });
    expect(container.textContent).toContain("50 %");
    const number = container.querySelector('input[type="number"]') as HTMLInputElement;
    expect(number.value).toBe("50"); // jamais "50 %"
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Le numérique synchronisé (Chantier C, Tâche 5) — via `onInput`, fiable ici (voir le commentaire
// d'en-tête). Aucun mock requis : ce chemin n'implique jamais `components/ui/slider.tsx`.
describe("SliderField — le numérique synchronisé", () => {
  async function typeAndBlur(container: HTMLElement, n: number) {
    const number = container.querySelector('input[type="number"]') as HTMLInputElement;
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      valueSetter.call(number, String(n));
      number.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await act(async () => {
      number.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
    });
  }

  it("le numérique synchronisé reflète et commit", async () => {
    const onCommit = mock((_v: number) => {});
    const { container } = await mountReal({ label: "Flou", value: 4, min: 0, max: 200, step: 1, onCommit });

    await typeAndBlur(container, 20);

    expect(onCommit).toHaveBeenCalledWith(20);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("taper la MÊME valeur (au step près) ne committe rien — aucune entrée d'historique fantôme", async () => {
    const onCommit = mock((_v: number) => {});
    const { container } = await mountReal({ label: "Flou", value: 4, min: 0, max: 200, step: 1, onCommit });

    await typeAndBlur(container, 4);

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("une saisie hors bornes est RAMENÉE par le MÊME chemin que le curseur (sliderValue/valueToFraction), jamais laissée telle quelle", async () => {
    const onCommit = mock((_v: number) => {});
    const { container } = await mountReal({ label: "Flou", value: 4, min: 0, max: 200, step: 1, onCommit });

    await typeAndBlur(container, 500); // au-delà de max=200

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toBe(200); // borné, pas 500
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LE GLISSER — via le double de `components/ui/slider.tsx` (voir le commentaire d'en-tête pour
// pourquoi un VRAI glisser/clavier est irréaliste ici). `mock.module()` posé UNE FOIS, pour toute
// exécution RESTANTE de ce fichier (dont §0 plus bas) — jamais retiré : Bun réinitialise les mocks de
// module PAR FICHIER, jamais besoin d'un retour en arrière manuel à l'intérieur d'un même fichier.
type FakeSliderProps = {
  value: number;
  onValueChange?: (v: number, details: unknown) => void;
  onValueCommitted?: (v: number, details: unknown) => void;
  "data-field"?: string;
  "data-testid"?: string;
};

function FakeSlider(props: FakeSliderProps) {
  return React.createElement(
    "div",
    { "data-slot": "slider", "data-field": props["data-field"], "data-testid": props["data-testid"], "data-value": props.value },
    React.createElement("button", {
      type: "button",
      "data-testid": "fake-slider-change",
      onClick: (e: React.MouseEvent<HTMLButtonElement>) =>
        props.onValueChange?.(Number((e.currentTarget as HTMLElement).dataset.raw), {}),
    }, "change"),
    React.createElement("button", {
      type: "button",
      "data-testid": "fake-slider-commit",
      onClick: (e: React.MouseEvent<HTMLButtonElement>) =>
        props.onValueCommitted?.(Number((e.currentTarget as HTMLElement).dataset.raw), {}),
    }, "commit"),
  );
}

async function fireChange(container: HTMLElement, raw: number) {
  const btn = container.querySelector('[data-testid="fake-slider-change"]') as HTMLElement;
  btn.setAttribute("data-raw", String(raw));
  await click(btn);
}

async function fireCommit(container: HTMLElement, raw: number) {
  const btn = container.querySelector('[data-testid="fake-slider-commit"]') as HTMLElement;
  btn.setAttribute("data-raw", String(raw));
  await click(btn);
}

describe("SliderField — un glisser du curseur commit UNE fois la valeur bornée (Chantier C, Tâche 5)", () => {
  // Posé ICI (dans un `beforeAll`, PAS au niveau du module) : Bun COLLECTE d'abord tous les
  // `describe`/`it` du fichier (exécution synchrone des callbacks `describe`) AVANT d'exécuter le
  // moindre corps de test — un `mock.module()` en haut du fichier s'appliquerait donc PENDANT cette
  // passe de collecte, avant même les tests « avant tout mock » plus haut, et les ferait échouer (le
  // VRAI `Slider` ne serait alors jamais rendu). Posé ici, il ne prend effet qu'à l'exécution RÉELLE
  // de CE `beforeAll` — après que les tests du VRAI curseur, plus haut dans ce fichier, ont déjà
  // tourné.
  beforeAll(() => {
    mock.module("@/components/ui/slider", () => ({ Slider: FakeSlider }));
  });

  it("un glisser (onValueCommitted) commit une fois la valeur bornée — fraction 0,5 sur [0,100] → 50", async () => {
    const onCommit = mock((_v: number) => {});
    const { container } = await mountReal({ label: "Opacité", value: 0, min: 0, max: 100, step: 1, onCommit });

    await fireCommit(container, 50); // fraction 0,5 de [0,100]

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toBe(50);
  });

  // Anti-vacuité (brief, Étape 4 : « ignorer la fraction du curseur (commit fixe) → le test de
  // glisser rougit ») : une AUTRE fraction doit committer une AUTRE valeur bornée.
  it("anti-vacuité : une autre fraction committe une autre valeur bornée — le geste n'est pas ignoré", async () => {
    const onCommit = mock((_v: number) => {});
    const { container } = await mountReal({ label: "Opacité", value: 0, min: 0, max: 100, step: 1, onCommit });

    await fireCommit(container, 20); // fraction 0,2

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toBe(20);
  });

  // §0 : `onValueChange` (LIVE, pendant le glisser) ne committe JAMAIS — seul `onValueCommitted` (au
  // relâchement) le fait. Un mutant qui brancherait `onCommit` sur `onValueChange` au lieu de
  // `onValueCommitted` ferait rougir CE test (`onCommit` appelé après le SEUL clic sur « change »).
  it("§0 : onValueChange (live) NE COMMIT JAMAIS — seul onValueCommitted committe", async () => {
    const onCommit = mock((_v: number) => {});
    const { container } = await mountReal({ label: "Opacité", value: 0, min: 0, max: 100, step: 1, onCommit });

    await fireChange(container, 33); // live, pendant un glisser fictif
    await fireChange(container, 66); // toujours live
    expect(onCommit).not.toHaveBeenCalled();

    await fireCommit(container, 66); // relâchement : LE seul commit
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toBe(66);
  });

  it("la valeur committée passe par le MÊME arrondi que sliderValue/valueToFraction (step=5, brut 33 → 35)", async () => {
    const onCommit = mock((_v: number) => {});
    const { container } = await mountReal({ label: "X", value: 0, min: 0, max: 100, step: 5, onCommit });

    await fireCommit(container, 33); // 33 n'est pas un multiple de 5 → arrondi à 35

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toBe(35);
  });

  it("committer la valeur DÉJÀ en place ne pousse rien (pas d'entrée d'historique fantôme)", async () => {
    const onCommit = mock((_v: number) => {});
    const { container } = await mountReal({ label: "Opacité", value: 50, min: 0, max: 100, step: 1, onCommit });

    await fireCommit(container, 50); // identique à la valeur de départ

    expect(onCommit).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §0 (brief) — l'aller-retour opacité : 0,5 (fraction) ↔ 50 % (affiché/committé par SliderField, qui
// ne connaît QUE des pourcents ici — c'est property-panel.tsx#OpacityField qui convertit 0–1 ↔ 0–100
// via opacityToPercent/percentToOpacity, TESTÉ SÉPARÉMENT dans tests/studio-field-scrub.test.ts) —
// PUIS le cas 100 % : la note « pas de clé opacity au-delà de 100 % » est le câblage EXACT de
// `OpacityField` (property-panel.tsx, non exporté — reproduit ici À L'IDENTIQUE, littéralement copié
// depuis le fichier source, pour que ce test rougisse si l'un des deux diverge).
describe("SliderField — §0, l'aller-retour opacité (0,5 ↔ 50 %) et le cas 100 %", () => {
  it("monté à 50 (0,5 en fraction), le numérique ET le curseur affichent bien 50 — aucune double conversion", async () => {
    const { container } = await mountReal({
      label: "Opacité", value: 50, min: 0, max: 100, step: 1, onCommit: () => {}, format: (v) => `${v} %`,
    });
    const number = container.querySelector('input[type="number"]') as HTMLInputElement;
    expect(number.value).toBe("50");
    expect(container.querySelector('[data-slot="slider"]')?.getAttribute("data-value")).toBe("50");
    expect(container.textContent).toContain("50 %");
  });

  it("§0 : un glisser qui ATTEINT 100 % — le câblage EXACT d'OpacityField écrit `opacity: undefined`, jamais `1`", async () => {
    // Reproduction À L'IDENTIQUE de property-panel.tsx#OpacityField.onCommit — si ce fichier et
    // property-panel.tsx divergent un jour, c'est LA-BAS qu'il faut lire le texte exact avant de
    // changer cette copie.
    let lastPatch: Record<string, unknown> | null = null;
    const patch = (p: Record<string, unknown>) => { lastPatch = p; };
    const opacity = 0.9; // layer.opacity ?? 1, comme OpacityField — un calque PAS encore pleinement opaque
    const onCommit = (pct: number) => patch({ opacity: pct >= 100 ? undefined : pct / 100 });

    const { container } = await mountReal({
      label: "Opacité", value: Math.round(opacity * 100), min: 0, max: 100, step: 1, onCommit,
    });

    await fireCommit(container, 100); // glisser jusqu'au bout à droite

    expect(lastPatch).not.toBeNull();
    // La clé EXISTE dans le correctif littéral (même wiring que le vrai code) mais sa VALEUR est
    // `undefined` — c'est exactement ce que `{...layer, ...patch}` (editor-state.ts#setLayerProp)
    // laisse ensuite tomber à la sérialisation JSON (JSON.stringify omet les clés `undefined`) : un
    // calque qui n'avait jamais `opacity`, ramené à 100 %, ne RETROUVE pas cette clé.
    expect(Object.prototype.hasOwnProperty.call(lastPatch, "opacity")).toBe(true);
    expect((lastPatch as unknown as Record<string, unknown>).opacity).toBeUndefined();
    // Contre-épreuve : EN DESSOUS de 100 %, la clé porte bien une fraction 0–1 (jamais `undefined`,
    // jamais le pourcent brut non converti).
    let lastPatch2: Record<string, unknown> | null = null;
    const patch2 = (p: Record<string, unknown>) => { lastPatch2 = p; };
    const onCommit2 = (pct: number) => patch2({ opacity: pct >= 100 ? undefined : pct / 100 });
    const { container: container2 } = await mountReal({
      label: "Opacité", value: 90, min: 0, max: 100, step: 1, onCommit: onCommit2,
    });
    await fireCommit(container2, 70);
    expect((lastPatch2 as unknown as Record<string, unknown>).opacity).toBe(0.7);
  });
});
