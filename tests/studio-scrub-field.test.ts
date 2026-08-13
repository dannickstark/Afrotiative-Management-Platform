import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import React from "react";
import { installDom, mount, pointer, pressKey } from "./dom-harness";

// tests/studio-scrub-field.test.ts — Chantier C, Tâche 3 (brief) : le VRAI câblage DOM de la
// poignée de balayage de `NumberField` (components/studio/property-fields.tsx), via le harnais U0
// (tests/dom-harness.ts) — de VRAIS `pointerdown`/`pointermove`/`pointerup`/`keydown` DOM sur
// l'ÉTIQUETTE, jamais un appel direct à un gestionnaire React introspecté. Même discipline que
// tests/studio-panel-resize-handle.test.ts, le modèle le plus proche du dépôt pour un glisser
// piloté au DOM (composant importé dynamiquement APRÈS `installDom()`, sans dépendance à Popover/
// ResizeObserver/next-navigation — `NumberField` n'en a besoin d'aucun).
let teardownDom: () => void;
let NumberFieldC: typeof import("@/components/studio/property-fields").NumberField;

beforeAll(async () => {
  teardownDom = installDom();
  ({ NumberField: NumberFieldC } = await import("@/components/studio/property-fields"));
});

afterAll(() => {
  teardownDom();
});

// Chaque test monte son propre `NumberField` et le démonte à la fin (`afterEach` ci-dessous filet de
// sécurité si un test omettait `unmount()`) — pas de conteneur partagé entre tests.
let currentUnmount: (() => void) | null = null;
afterEach(() => {
  currentUnmount?.();
  currentUnmount = null;
});

/** L'assembleur local que le brief demande d'écrire : monte le VRAI `NumberField`, RATTACHE son
 * conteneur à `document.body` (même idiome que tests/studio-mode-switch.test.ts#mountAttached : un
 * `element.focus()` ne déplace `document.activeElement` que pour un élément RÉELLEMENT dans le
 * document — sans quoi l'assertion « clic-pour-taper » passerait pour de mauvaises raisons), retrouve
 * l'étiquette (`[data-scrub]`) et l'`<input>`, et expose trois gestes de haut niveau construits sur
 * de VRAIS `PointerEvent`/`KeyboardEvent` DOM (via `pointer()`/`pressKey()`, tests/dom-harness.ts). */
async function mountNumberField(props: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
}) {
  const { container, unmount: rawUnmount } = await mount(React.createElement(NumberFieldC, props));
  document.body.appendChild(container);
  const unmount = () => {
    rawUnmount();
    container.remove();
  };
  currentUnmount = unmount;

  const label = container.querySelector("[data-scrub]") as HTMLElement;
  const input = container.querySelector("input") as HTMLInputElement;
  if (!label) throw new Error("étiquette [data-scrub] absente du DOM monté");
  if (!input) throw new Error("<input> absent du DOM monté");

  async function fireLabelDrag(opts: { fromX: number; toXs: number[]; upX: number; modifiers?: { shiftKey?: boolean; altKey?: boolean } }) {
    await pointer(label, "pointerdown", { clientX: opts.fromX, ...opts.modifiers });
    for (const x of opts.toXs) {
      await pointer(label, "pointermove", { clientX: x, ...opts.modifiers });
    }
    await pointer(label, "pointerup", { clientX: opts.upX, ...opts.modifiers });
  }

  async function fireLabelClick(opts: { x: number }) {
    await pointer(label, "pointerdown", { clientX: opts.x });
    await pointer(label, "pointerup", { clientX: opts.x });
  }

  async function fireLabelDragThenEscape(opts: { fromX: number; toX: number }) {
    await pointer(label, "pointerdown", { clientX: opts.fromX });
    await pointer(label, "pointermove", { clientX: opts.toX });
    await pressKey({ key: "Escape" }, label);
  }

  return { container, label, input, fireLabelDrag, fireLabelClick, fireLabelDragThenEscape, unmount };
}

describe("NumberField scrubby (Chantier C, Tâche 3) — glisser sur l'étiquette", () => {
  it("un glisser sur l'étiquette commit UNE fois la valeur balayée, jamais pendant les pointermove", async () => {
    const onCommit = mock((_v: number) => {});
    const { fireLabelDrag } = await mountNumberField({ label: "X", value: 10, step: 1, onCommit });

    // glisser de +40px sans modificateur, pxPerStep=4 (défaut de scrubValue) → 10 pas × step 1 → 20.
    await fireLabelDrag({ fromX: 100, toXs: [110, 130], upX: 140 });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toBe(20);
  });

  it("Maj pendant le glisser MULTIPLIE la sensibilité par 10 (relayée depuis le VRAI shiftKey du PointerEvent)", async () => {
    const onCommit = mock((_v: number) => {});
    const { fireLabelDrag } = await mountNumberField({ label: "X", value: 0, step: 1, onCommit });

    // +4px avec Maj → 1 pas × 10 → 10 (sans Maj, +4px ne donnerait que 1).
    await fireLabelDrag({ fromX: 0, toXs: [2], upX: 4, modifiers: { shiftKey: true } });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toBe(10);
  });

  it("Alt pendant le glisser atteint une valeur SOUS le step nominal (grille ×0.1, relayée depuis le VRAI altKey)", async () => {
    const onCommit = mock((_v: number) => {});
    const { fireLabelDrag } = await mountNumberField({ label: "X", value: 0, step: 1, onCommit });

    // +4px avec Alt → 1 pas × 0.1 → brut 0.1, arrondi à la grille fine (step*0.1=0.1) → 0.1.
    await fireLabelDrag({ fromX: 0, toXs: [2], upX: 4, modifiers: { altKey: true } });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toBeCloseTo(0.1, 5);
  });

  it("un clic sans mouvement (dx < seuil de 3px) ne commit pas et focalise l'input (clic-pour-taper préservé)", async () => {
    const onCommit = mock((_v: number) => {});
    const { input, fireLabelClick } = await mountNumberField({ label: "X", value: 10, onCommit });

    await fireLabelClick({ x: 100 });

    expect(onCommit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });

  it("un dx sous le seuil de 3px (mouvement infime) est traité comme un clic — ne commit pas", async () => {
    const onCommit = mock((_v: number) => {});
    const { input, fireLabelDrag } = await mountNumberField({ label: "X", value: 10, step: 1, onCommit });

    // dx final = 2px < seuil de 3px : un clic-pour-taper malgré un tremblement de main, pas un balayage.
    await fireLabelDrag({ fromX: 100, toXs: [101], upX: 102 });

    expect(onCommit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });

  it("Escape pendant le glisser annule (pas de commit)", async () => {
    const onCommit = mock((_v: number) => {});
    const { fireLabelDragThenEscape } = await mountNumberField({ label: "X", value: 10, step: 1, onCommit });

    await fireLabelDragThenEscape({ fromX: 100, toX: 130 });

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("glisser jusqu'à revenir EXACTEMENT à la valeur de départ ne commit rien (moved=true mais v===value)", async () => {
    const onCommit = mock((_v: number) => {});
    const { fireLabelDrag } = await mountNumberField({ label: "X", value: 10, step: 1, onCommit });

    // Glisse de +40 (>seuil) puis revient très exactement à dx=0 au relâchement : la valeur finale
    // égale la valeur de départ — aucune raison de committer ni de pousser une entrée d'historique.
    await fireLabelDrag({ fromX: 100, toXs: [140], upX: 100 });

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("un champ DÉSACTIVÉ ignore le pointerdown sur l'étiquette — aucun geste ne s'arme", async () => {
    const onCommit = mock((_v: number) => {});
    const { input, fireLabelDrag } = await mountNumberField({ label: "X", value: 10, step: 1, onCommit, disabled: true });

    await fireLabelDrag({ fromX: 100, toXs: [140], upX: 180 });

    expect(onCommit).not.toHaveBeenCalled();
    // Et le focus n'est pas non plus tombé dans l'input désactivé — le geste entier a été ignoré.
    expect(document.activeElement).not.toBe(input);
  });

  // PORTÉE : le clavier de l'`<input>` (flèches, Entrée, Échap, blur -> commit) n'est PAS retesté ici
  // — le brief l'exige INCHANGÉ, et son code (le `onKeyDown`/`onBlur` de l'`<input>`, plus bas dans
  // property-fields.tsx) n'a pas bougé d'une ligne. Un aller-retour `.value` natif + `dispatchEvent` +
  // `.focus()` réel s'est heurté ici au même piège déjà consigné dans
  // tests/studio-interactions.test.ts (« jsdom + le suivi de valeur des champs (IE, absent de jsdom)
  // rend un VRAI `.focus()` imprévisible dans ce harnais ») — React retombe sur un polyfill IE
  // (`attachEvent`) que jsdom ne fournit pas. Ajouter un test fragile sur du code non touché n'aurait
  // rien épinglé de nouveau ; les tests existants de property-panel.tsx/geometry-strip.tsx qui
  // montent déjà `NumberField` continuent de couvrir ce chemin par ailleurs.
});
