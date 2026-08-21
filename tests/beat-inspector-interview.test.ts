import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import React from "react";
import { installDom, mount, flush } from "./dom-harness";
import type { BeatView } from "@/components/video/beat-list";

// `next/navigation` — même recette que tests/insert-row.test.ts : posée AVANT le premier import du
// composant (import dynamique, les imports statiques sont hissés), avec `...realNavigation` pour ne
// pas perdre les exports (ex. `redirect`) que d'autres modules importés transitivement attendent.
const realNavigation = await import("next/navigation");
mock.module("next/navigation", () => ({
  ...realNavigation,
  useRouter: () => ({
    push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, forward: () => {}, prefetch: () => {},
  }),
}));

// ── Le même piège Popover/Dialog que tests/studio-color-picker.test.ts (voir son commentaire de
// tête) : `@base-ui/utils/useIsoLayoutEffect.mjs` résout `typeof document !== "undefined"` UNE
// SEULE FOIS, à l'évaluation du module — un singleton partagé par tout le processus `bun test`, et
// se fige sur `noop` si un AUTRE fichier a déjà touché un composant base-ui (Sheet, Button, …) SANS
// DOM avant que celui-ci n'ait installé le sien (des dizaines de fichiers du dépôt rendent des
// composants studio/vidéo via `renderToStaticMarkup` sans jamais poser de DOM). Sonde le SYMPTÔME
// directement, à un `await` de NIVEAU MODULE (avant que `describe`/`it.skipIf` ne soient lus), et
// SAUTE (jamais un succès silencieux) les tests qui ont besoin du VRAI contenu du Sheet si le
// processus est déjà empoisonné. Lancer ce fichier SEUL (ou `bun test --isolate`) donne toujours
// sheetEffectsLive = true — vérifié.
//
// `BeatInspector` n'est PAS importé statiquement en tête de fichier : un import statique évaluerait
// sa chaîne de dépendances (jusqu'à @base-ui/react/dialog → useIsoLayoutEffect) AVANT que la sonde
// ci-dessous n'ait pu installer un DOM, empoisonnant le singleton depuis CE fichier lui-même.
let sheetEffectsLive = false;
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
    sheetEffectsLive = ran;
  } finally {
    probeTeardown();
  }
}
if (!sheetEffectsLive) {
  console.warn(
    "\n[tests/beat-inspector-interview.test.ts] tests dépendant du VRAI contenu du Sheet sautés — " +
    "useIsoLayoutEffect a été figé sur un noop par un autre fichier de ce process `bun test`. " +
    "Relancer avec `bun test --isolate …` (ou ce fichier seul) pour qu'ils s'exécutent réellement — " +
    "voir tests/studio-color-picker.test.ts pour l'explication complète.\n",
  );
}

// Globals que jsdom 30 (sans `pretendToBeVisual`) ne fournit pas et que `installDom()` n'installe
// pas — même liste, pour la même raison, que `installExtraGlobals()` dans
// tests/studio-color-picker.test.ts : le Portail/gestion du focus de Dialog fait `instanceof
// Element` (le global BARE) et calcule un positionnement (`getComputedStyle`) dès le montage.
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

function beat(over: Partial<BeatView> = {}): BeatView {
  return {
    id: "u1", externalId: "b-01-reponse", position: 1, kind: "reponse",
    spokenText: "<p>Réponse.</p>",
    directionNote: null, screenText: null, transitionIn: null, transitionOut: null,
    estimatedDurationSec: 4, durationOverrideSec: null, locallyEdited: false, inserts: [],
    speakerId: null, answersBeatId: null,
    ...over,
  };
}

const speakers = [
  { id: "s1", name: "Awa" },
  { id: "s2", name: "Kofi" },
];

const questionBeats = [
  { id: "q1", position: 0, spokenText: "<p>Quelle est votre histoire ?</p>" },
];

let teardownDom: () => void;
let teardownExtraGlobals: () => void;
let BeatInspectorC: typeof import("@/components/video/beat-inspector").BeatInspector;

beforeAll(async () => {
  teardownDom = installDom();
  teardownExtraGlobals = installExtraGlobals();
  ({ BeatInspector: BeatInspectorC } = await import("@/components/video/beat-inspector"));
});

afterAll(() => {
  teardownExtraGlobals();
  teardownDom();
});

let currentUnmount: (() => void) | null = null;
afterEach(() => {
  currentUnmount?.();
  currentUnmount = null;
  // Le Sheet porte dans `document.body` (jamais le conteneur de `mount()`) — un test dont
  // l'unmount ne nettoierait pas laisserait un Sheet fantôme polluer les `document.body.querySelector`
  // du test suivant.
  document.body.innerHTML = "";
});

describe("BeatInspector — mode interview", () => {
  it.skipIf(!sheetEffectsLive)("affiche le select Locuteur avec les noms des intervenants", async () => {
    const { unmount } = await mount(
      React.createElement(BeatInspectorC, {
        beat: beat(), open: true, onOpenChange: () => {}, onSaved: () => {},
        speakers, questionBeats,
      }),
    );
    currentUnmount = unmount;
    await flush();

    const select = document.body.querySelector("#beat-speaker") as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(select!.innerHTML).toContain("Awa");
    expect(select!.innerHTML).toContain("Kofi");
  });

  it.skipIf(!sheetEffectsLive)("affiche le select Répond à avec les questions, pour un beat réponse", async () => {
    const { unmount } = await mount(
      React.createElement(BeatInspectorC, {
        beat: beat(), open: true, onOpenChange: () => {}, onSaved: () => {},
        speakers, questionBeats,
      }),
    );
    currentUnmount = unmount;
    await flush();

    const select = document.body.querySelector("#beat-answers") as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(select!.innerHTML).toContain("Quelle est votre histoire");
  });

  it.skipIf(!sheetEffectsLive)("n'affiche pas le select Répond à pour un beat narration", async () => {
    const { unmount } = await mount(
      React.createElement(BeatInspectorC, {
        beat: beat({ kind: "narration" }), open: true, onOpenChange: () => {}, onSaved: () => {},
        speakers, questionBeats,
      }),
    );
    currentUnmount = unmount;
    await flush();

    expect(document.body.querySelector("#beat-speaker")).not.toBeNull();
    expect(document.body.querySelector("#beat-answers")).toBeNull();
  });
});
