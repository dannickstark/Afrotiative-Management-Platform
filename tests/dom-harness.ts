// tests/dom-harness.ts — U0 Tâche 1 : harnais DOM OPT-IN pour `bun test`.
//
// Pourquoi opt-in (§1 du plan) : `bunfig.toml` précharge test-setup.ts pour CHAQUE fichier de test.
// Y installer `window`/`document` ferait basculer tous les `typeof window === "undefined"` du
// dépôt — dont la garde d'hydratation de hooks/use-editor-prefs.ts et les branches serveur des
// helpers de config — et changerait silencieusement quel chemin ~1300 tests existants exercent.
// Donc : un fichier appelle `installDom()` explicitement, obtient un DOM pour sa durée, et
// `installDom()` renvoie un teardown qui RESTAURE l'état antérieur de `globalThis` — jamais une
// suppression à l'aveugle. Aucune dépendance nouvelle : jsdom et @types/jsdom sont déjà présents
// mais inutilisés, et React 19 exporte `act` directement (react-dom/test-utils est déprécié).
import { JSDOM } from "jsdom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Sentinelle distincte de `undefined` : une clé peut être ABSENTE de globalThis (jamais définie) ou
// PRÉSENTE avec la valeur `undefined` — deux états différents que `delete` vs réassignation doivent
// distinguer pour restaurer exactement, pas approximativement.
const NOT_PRESENT = Symbol("dom-harness:not-present");

// Les globals que le harnais installe et restaure — exactement la liste de §2 du plan (window,
// document, navigator, HTMLElement, Node, Event, KeyboardEvent, MouseEvent, localStorage) plus le
// stub IntersectionObserver que render-mode.tsx exige. `IS_REACT_ACT_ENVIRONMENT` est géré à part
// (voir plus bas) : ce n'est pas un global DOM, c'est un commutateur de React lui-même.
//
// EXPORTÉE (revue finale U0+U2) : le garde-fou de complétude de tests/dom-harness.test.ts en avait
// une COPIE À LA MAIN, ce qui en faisait un garde-fou sur sa propre copie — ajouter un global ici sans
// mettre la copie à jour laissait le test vert, exactement le défaut que U1 avait livré dans son
// garde-fou de galerie de formes (corrigé là-bas de la même façon : exporter la vraie liste et la
// faire consommer par les deux côtés, cf. SHAPE_KINDS dans lib/studio/scene.ts).
export const DOM_GLOBAL_KEYS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Node",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "localStorage",
  "IntersectionObserver",
] as const;

export type DomGlobalKey = (typeof DOM_GLOBAL_KEYS)[number];

/** Le commutateur de React, installé/restauré par le même cycle mais volontairement HORS de
 * `DOM_GLOBAL_KEYS` (ce n'est pas un global DOM). Exporté pour la même raison que la liste : le
 * garde-fou de complétude doit pouvoir énumérer TOUT ce que `installDom()` touche sans le recopier. */
export const REACT_ACT_ENV_KEY = "IS_REACT_ACT_ENVIRONMENT";

/** Une instance du stub IntersectionObserver — le callback est CONSERVÉ (jamais jeté) sur
 * l'instance elle-même, et sur `instances` au niveau du constructeur, pour qu'une tâche future
 * (spec : « a later task may want to trigger its callback ») puisse le déclencher à la main, sans
 * devoir intercepter la construction depuis l'intérieur du composant qui l'a créé. */
export interface StubIntersectionObserverInstance extends IntersectionObserver {
  callback: IntersectionObserverCallback;
}

interface StubIntersectionObserverCtor {
  new (callback: IntersectionObserverCallback, options?: IntersectionObserverInit): StubIntersectionObserverInstance;
  instances: StubIntersectionObserverInstance[];
}

function createIntersectionObserverStub(): StubIntersectionObserverCtor {
  const instances: StubIntersectionObserverInstance[] = [];

  class StubIntersectionObserver implements IntersectionObserver {
    readonly root: Element | Document | null = null;
    readonly rootMargin: string = "";
    readonly thresholds: ReadonlyArray<number> = [];
    callback: IntersectionObserverCallback;

    constructor(callback: IntersectionObserverCallback, _options?: IntersectionObserverInit) {
      this.callback = callback;
      instances.push(this);
    }

    observe(_target: Element): void {
      // no-op délibéré (spec Tâche 1, Étape 3) : ce stub n'observe rien réellement — un appelant qui
      // veut simuler une entrée dans le viewport invoque `callback` lui-même via `instances`.
    }

    unobserve(_target: Element): void {}

    disconnect(): void {}

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  (StubIntersectionObserver as unknown as StubIntersectionObserverCtor).instances = instances;
  return StubIntersectionObserver as unknown as StubIntersectionObserverCtor;
}

/**
 * Installe un DOM jsdom sur `globalThis` pour la durée où le fichier appelant en a besoin, et
 * renvoie un teardown qui RESTAURE (jamais ne supprime à l'aveugle) l'état antérieur exact.
 *
 * Empilable : appeler `installDom()` alors qu'un DOM est déjà installé (par exemple par le
 * `beforeAll` du fichier lui-même) fonctionne — le teardown de l'appel imbriqué restaure les
 * références qui étaient en place juste avant CET appel, pas un état "vide" global.
 */
export function installDom(): () => void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const win = dom.window as unknown as Window & typeof globalThis;

  const g = globalThis as Record<string, unknown>;

  const snapshot = new Map<DomGlobalKey, unknown | typeof NOT_PRESENT>();
  for (const key of DOM_GLOBAL_KEYS) {
    snapshot.set(key, Object.prototype.hasOwnProperty.call(g, key) ? g[key] : NOT_PRESENT);
  }
  const priorActEnv = Object.prototype.hasOwnProperty.call(g, REACT_ACT_ENV_KEY)
    ? (g[REACT_ACT_ENV_KEY] as unknown)
    : NOT_PRESENT;

  g.window = win;
  g.document = win.document;
  g.navigator = win.navigator;
  g.HTMLElement = win.HTMLElement;
  g.Node = win.Node;
  g.Event = win.Event;
  g.KeyboardEvent = win.KeyboardEvent;
  g.MouseEvent = win.MouseEvent;
  g.localStorage = win.localStorage;
  g.IntersectionObserver = createIntersectionObserverStub();
  // React (via `act`) exige ce commutateur pour flusher synchronement les effets en environnement de
  // test — sans lui, `act()` émet un avertissement « not configured to support act(...) ». Scopé au
  // même cycle install/teardown que le reste : un fichier qui n'opte jamais dans installDom() ne le
  // voit jamais apparaître sur globalThis.
  g[REACT_ACT_ENV_KEY] = true;

  let torn = false;
  return function teardown() {
    if (torn) return; // idempotent : un double appel ne doit pas re-restaurer une valeur déjà restaurée par un AUTRE appel entre-temps.
    torn = true;
    for (const key of DOM_GLOBAL_KEYS) {
      const prev = snapshot.get(key);
      if (prev === NOT_PRESENT) delete g[key];
      else g[key] = prev;
    }
    if (priorActEnv === NOT_PRESENT) delete g[REACT_ACT_ENV_KEY];
    else g[REACT_ACT_ENV_KEY] = priorActEnv;
    win.close();
  };
}

export type Mounted = {
  container: HTMLElement;
  unmount: () => void;
};

/**
 * Monte un élément React dans un conteneur DÉTACHÉ (jamais inséré dans `document.body` — §2 du
 * plan) et attend que le rendu initial ET ses effets aient tourné avant de résoudre. Un conteneur
 * détaché suffit : `createRoot` attache son écouteur d'événements délégué directement sur ce
 * conteneur, donc un événement dispatché sur un descendant remonte bien jusqu'à lui par la chaîne
 * `parentNode` locale, sans que le conteneur ait besoin d'être rattaché au document réel.
 */
export async function mount(element: React.ReactElement): Promise<Mounted> {
  const container = document.createElement("div");
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(element);
  });

  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
    },
  };
}

/** Dispatche un VRAI MouseEvent "click" qui bubble depuis `el`, enveloppé dans `act` pour que les
 * effets déclenchés par le gestionnaire React aient le temps de tourner avant de résoudre. Ce n'est
 * PAS un raccourci qui invoque une prop `onClick` trouvée par introspection — la remontée DOM réelle
 * est le point même du harnais (spec §2 : « calling a handler directly is what the five uncovered
 * seams already fail to catch »).
 *
 * `init` (Chantier D, Tâche 4, additif — le défaut reproduit l'appel d'origine bit à bit, donc aucun
 * appelant existant ne change de comportement) : permet à un test de poser des modificateurs, par ex.
 * `{ shiftKey: true }` pour le geste « Maj-clic applique le réglage à toute la sélection » du widget
 * de contraintes — même besoin que `pointer()` un peu plus bas, qui accepte déjà un `MouseEventInit`. */
export async function click(el: Element, init: MouseEventInit = {}): Promise<void> {
  await act(async () => {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, view: window, ...init });
    el.dispatchEvent(event);
  });
}

/** Dispatche un VRAI KeyboardEvent "keydown" sur `document` par défaut — les raccourcis clavier de
 * l'éditeur (⌘/, « R », etc.) s'enregistrent via `document`/`window.addEventListener`, jamais via une
 * prop React sur un nœud particulier.
 *
 * `target` (U3 Tâche 5, additif — la valeur par défaut est l'ancien comportement) permet de viser un
 * ÉLÉMENT précis, ce qu'exigent deux besoins distincts :
 *   - une touche adressée à un contrôle focalisé (flèches sur un bouton d'un groupe) doit remonter par
 *     la chaîne DOM de ce contrôle, pas apparaître sur `document` comme si personne n'avait le focus ;
 *   - la garde « pas de raccourci pendant la frappe » (isModeToggleShortcut, lib/studio/studio-mode.ts)
 *     lit `event.target.tagName` — la viser sur un `<input>` RÉEL est la seule façon de l'exercer.
 * ATTENTION : un élément DÉTACHÉ du document ne propage pas jusqu'à `window` (le chemin d'événement
 * s'arrête à la racine de son propre arbre) — rattacher le conteneur monté à `document.body` est
 * nécessaire pour qu'un écouteur `window` voie l'événement.
 *
 * Renvoie l'événement dispatché (additif) : `event.defaultPrevented` est la SEULE façon d'observer
 * qu'un gestionnaire a bien appelé — ou bien s'est abstenu d'appeler — `preventDefault()`, ce qui
 * distingue « le raccourci a été intercepté » de « la touche a été laissée au navigateur » (Cmd+R). */
export async function pressKey(init: KeyboardEventInit, target: EventTarget = document): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

/** Le pendant « relâchement » de `pressKey` ci-dessus — un VRAI KeyboardEvent "keyup", même défaut de
 * cible (`document`, bubbling jusqu'à `window`). Ajoutée pour Chantier B, Tâche 4 (Espace-glisser) :
 * `pressKey` seul ne peut exercer QUE l'armement d'un raccourci maintenu (garde de focus, prévention
 * du défaut) — un geste « maintenir Espace, glisser, RELÂCHER Espace » a aussi besoin du relâchement
 * lui-même comme VRAI événement DOM, pas d'un appel direct au `setState` qui l'observerait. */
export async function releaseKey(init: KeyboardEventInit, target: EventTarget = document): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keyup", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

/** Dispatche un VRAI événement pointeur (pointerdown/pointermove/pointerup/pointercancel) qui bubble
 * depuis `el`, enveloppé dans `act`. jsdom 30 ne construit pas `PointerEvent` de façon fiable (l'API
 * Pointer Events n'y est pas implémentée) — on utilise donc `MouseEvent` avec le NOM de type
 * "pointer*" : `addEventListener("pointerdown", ...)` (React comme le `addEventListener` natif posé
 * par `hooks/use-layer-drag.ts`'s `bind()`) déclenche sur le nom du type, pas sur la classe réelle de
 * l'objet événement, et `MouseEventInit` porte déjà `clientX`/`clientY`/`shiftKey`/`altKey`/`button` —
 * tout ce que `bind()` lit (revue Tâche 2, Important 4 : le câblage DOM de Maj/Alt n'avait aucun test
 * qui passe par de VRAIS événements pointeur, seulement par la machine à geste pure appelée
 * directement). `target.setPointerCapture` n'existe pas sur les éléments jsdom : l'appel `?.()` dans
 * `bind()` le contourne déjà sans notre aide. */
export async function pointer(
  el: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  init: MouseEventInit = {},
): Promise<void> {
  await act(async () => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, view: window, ...init });
    el.dispatchEvent(event);
  });
}

/** Dispatche un VRAI `WheelEvent` "wheel" qui bubble depuis `el`, enveloppé dans `act` (Chantier B,
 * Tâche 4 — molette ⌘/Ctrl zoom-au-curseur / pan). Contrairement à `pointer()` ci-dessus, jsdom
 * implémente une VRAIE classe `WheelEvent` (héritée de `MouseEvent`, donc `deltaY`/`ctrlKey`/
 * `clientX`/`clientY` y sont tous portés) — inutile de synthétiser via un nom de type détourné. */
export async function wheel(el: Element, init: WheelEventInit = {}): Promise<WheelEvent> {
  const event = new window.WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    el.dispatchEvent(event);
  });
  return event;
}

/** Laisse les effets/mises à jour d'état en attente se stabiliser sans dispatcher d'événement —
 * utile après une mise à jour déclenchée par une promesse résolue dans un effet plutôt que par une
 * interaction utilisateur directe. */
export async function flush(): Promise<void> {
  await act(async () => {});
}
