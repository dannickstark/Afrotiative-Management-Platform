import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import React from "react";
import { act } from "react";
import { installDom, mount } from "./dom-harness";
import { parseScene, type Layer, type Scene } from "@/lib/studio/scene";
import { percentToOpacity } from "@/lib/studio/field-scrub";
import type { EditorAction } from "@/lib/studio/editor-state";
import { DEFAULT_PREFS } from "@/lib/studio/editor-prefs";

// tests/studio-inspector-integration.test.ts — Chantier C, Tâche 6 (brief, Étape 1) : la passe §0 de
// NON-RÉGRESSION qui clôt le chantier « refonte des champs de l'inspecteur ». Ce fichier ne teste
// AUCUNE maths nouvelle (déjà couvertes par tests/studio-field-scrub.test.ts, tests/studio-color.test.ts)
// ni AUCUN câblage DOM déjà épinglé fil à fil (tests/studio-scrub-field.test.ts, tests/studio-slider-
// field.test.ts, tests/studio-color-picker.test.ts) : il monte le VRAI `PropertyPanel` — la même porte
// d'entrée qu'un designer utilise réellement — sur les QUATRE types de calque, et vérifie que
// l'ASSEMBLAGE des cinq tâches précédentes ne s'est pas mal recollé quelque part :
//   (a) taper dans un champ numérique commit toujours à l'identique (le VRAI `dispatch`, la VRAIE
//       action `setLayerProp`) ;
//   (b) un `ColorField` dont la valeur est un `{{jeton}}` affiche l'état LIÉ (le damier) ;
//   (c) un calque laissé à pleine opacité n'écrit PAS de clé `opacity` — via le SEUL curseur qui reste
//       (`data-testid="appearance-opacity"`), le doublon de la bande de géométrie ayant été retiré
//       dans CETTE tâche (voir geometry-strip.tsx) ;
//   (d) LE PLUS IMPORTANT — une scène sans `opacity` ni couleur alpha fait un aller-retour deep-equal
//       par `parseScene`, la preuve que tout le chantier n'a ajouté AUCUNE dérive de sérialisation.
// Globals que jsdom 30 (sans `pretendToBeVisual`) ne fournit pas et que `installDom()` (U0) n'installe
// pas — même recette, pour la même raison, que tests/studio-color-picker.test.ts#installExtraGlobals
// (son commentaire de tête l'explique en détail) : `PropertyPanel` monte un `ColorField` par calque
// (ne serait-ce que « Couleur »/« Remplissage »/« Voile »/« premier plan »), et CHACUN embarque
// `<ColorPicker>` — un `Popover` qui monte un contexte floating-ui-react DÈS le montage (pas seulement
// à l'ouverture) et fait `value instanceof Element` (le global BARE) plus un calcul de positionnement
// planifié par `requestAnimationFrame`, même popup FERMÉ. Sans ces globals, monter `<PropertyPanel>`
// lève `ReferenceError: Element is not defined` au tout premier rendu — vérifié directement (RED sans
// ce bloc, avant de l'ajouter).
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

afterAll(() => {
  teardownExtraGlobals();
  teardownDom();
});

let currentUnmount: (() => void) | null = null;
afterEach(() => {
  currentUnmount?.();
  currentUnmount = null;
});

function scene(layers: Layer[]): Scene {
  return { schemaVersion: 1, canvas: { width: 1200, height: 675, background: "#0B0B0B" }, layers };
}

async function mountPanel(layer: Layer, dispatch: (a: EditorAction) => void) {
  const { container, unmount: rawUnmount } = await mount(
    React.createElement(PropertyPanelC, {
      scene: scene([layer]),
      selectedIds: [layer.id],
      context: "social_post",
      dispatch,
      assets: [],
      sectionsOpen: DEFAULT_PREFS.sectionsOpen,
      onSectionsOpenChange: () => {},
    }),
  );
  currentUnmount = () => rawUnmount();
  return { container, html: container.innerHTML };
}

/** Localise la balise ouvrante d'un `data-testid` donné — même idiome que
 * tests/studio-property-panel.test.ts#openingTag, redéfini localement (petite fonction, pas encore
 * partagée entre fichiers de test dans ce dépôt). */
function openingTag(html: string, attr: string, value: string): string {
  const match = new RegExp(`<[a-z]+[^>]*${attr}="${value}"[^>]*>`).exec(html);
  if (!match) throw new Error(`balise introuvable dans le HTML rendu : ${attr}="${value}"`);
  return match[0];
}

function countOf(html: string, needle: string): number {
  let n = 0;
  let from = 0;
  for (;;) {
    const i = html.indexOf(needle, from);
    if (i === -1) return n;
    n += 1;
    from = i + needle.length;
  }
}

/** Tape une valeur dans un `<input type="number">` DOM et déclenche son commit au relâchement du
 * focus — même recette que tests/studio-slider-field.test.ts#typeAndBlur (le SEUL chemin fiable dans
 * ce harnais : `SliderField` relaie `onInput`, pas `onChange`, voir son commentaire d'en-tête — un
 * `NumberField` brut, lui, n'est PAS retestable ainsi ici, voir tests/studio-scrub-field.test.ts#PORTÉE). */
async function typeAndBlur(input: HTMLInputElement, n: number) {
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    valueSetter.call(input, String(n));
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — DÉLIBÉRÉMENT sans `opacity` ni couleur alpha (8 hex) : le point (d) ci-dessous a besoin
// d'une scène qui n'en porte AUCUNE pour prouver qu'un aller-retour ne lui en ajoute pas.
const textLayer: Layer = {
  id: "t", name: "Titre", visible: true, locked: false,
  frame: { x: 10, y: 10, w: 400, h: 100 },
  type: "text", content: "Bonjour",
  font: { family: "Noto Sans", size: 40, weight: 700 },
  color: "#FFFFFF", align: "center", vAlign: "middle", lineHeight: 1.3,
};

const shapeLayer: Layer = {
  id: "s", name: "Fond", visible: true, locked: false,
  frame: { x: 0, y: 0, w: 300, h: 200 },
  type: "shape", shape: "rect", fill: "#123456",
};

const imageLayer: Layer = {
  id: "i", name: "Image", visible: true, locked: false,
  frame: { x: 0, y: 0, w: 300, h: 200 },
  type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover",
};

const qrLayer: Layer = {
  id: "q", name: "QR", visible: true, locked: false,
  frame: { x: 0, y: 0, w: 120, h: 120 },
  type: "qr", slot: "article.url", fg: "#000000", bg: "#FFFFFF", margin: 4,
};

const FOUR_TYPES: readonly [string, Layer][] = [
  ["texte", textLayer],
  ["forme", shapeLayer],
  ["image", imageLayer],
  ["qr", qrLayer],
];

// ─────────────────────────────────────────────────────────────────────────────
// (a) Taper dans un champ numérique commit toujours à l'identique — le curseur d'opacité
// (`OpacityField`, property-panel.tsx) est présent dans TOUS les types de calque (§0, Tâche 5) : le
// même champ sert donc de sonde unique pour les quatre.
describe("§0 — la frappe numérique commit toujours à l'identique, pour les QUATRE types de calque", () => {
  for (const [label, layer] of FOUR_TYPES) {
    it(`calque ${label} : taper un nouveau pourcentage dans « Opacité » committe la fraction attendue via setLayerProp`, async () => {
      const calls: EditorAction[] = [];
      const layerWithOpacity: Layer = { ...layer, opacity: 0.42 } as Layer;
      const { container } = await mountPanel(layerWithOpacity, (a) => calls.push(a));

      const input = container.querySelector('[data-testid="appearance-opacity-input"]') as HTMLInputElement;
      expect(input).not.toBeNull();
      await typeAndBlur(input, 65); // 65 % — différent des 42 % de départ

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        type: "setLayerProp",
        id: layerWithOpacity.id,
        patch: { opacity: percentToOpacity(65) },
      });
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) Un ColorField dont la valeur est un {{jeton}} affiche l'état LIÉ (le damier de
// components/studio/color-picker.tsx#CHECKERBOARD, posé sur `data-testid="color-swatch-preview"` dès
// que `value.startsWith("{{")`). Chaque fixture ci-dessous ne porte QU'UN SEUL champ couleur (aucune
// ombre/contour activés sur le texte, aucun dégradé sur la forme) — une valeur liée dans un champ dont
// c'est le SEUL représentant du panneau, jamais une présence ambiguë parmi plusieurs.
describe("§0 — un ColorField {{jeton}} affiche l'état lié (damier), pour les QUATRE types de calque", () => {
  it("calque texte : « Couleur » en jeton affiche le damier", async () => {
    const { html } = await mountPanel({ ...textLayer, color: "{{brand.primary}}" }, () => {});
    expect(countOf(html, 'data-testid="color-swatch-preview"')).toBe(1);
    expect(openingTag(html, "data-testid", "color-swatch-preview")).toContain("repeating-linear-gradient");
  });

  it("calque forme : « Couleur » (remplissage uni) en jeton affiche le damier", async () => {
    const { html } = await mountPanel({ ...shapeLayer, fill: "{{brand.primary}}" }, () => {});
    expect(countOf(html, 'data-testid="color-swatch-preview"')).toBe(1);
    expect(openingTag(html, "data-testid", "color-swatch-preview")).toContain("repeating-linear-gradient");
  });

  it("calque image : « Voile (overlay) » en jeton affiche le damier", async () => {
    const { html } = await mountPanel({ ...imageLayer, overlay: "{{brand.overlay}}" }, () => {});
    expect(countOf(html, 'data-testid="color-swatch-preview"')).toBe(1);
    expect(openingTag(html, "data-testid", "color-swatch-preview")).toContain("repeating-linear-gradient");
  });

  it("calque qr : « Couleur (premier plan) » en jeton affiche le damier, « Couleur de fond » (littérale) non", async () => {
    const { html } = await mountPanel({ ...qrLayer, fg: "{{brand.primary}}" }, () => {});
    expect(countOf(html, 'data-testid="color-swatch-preview"')).toBe(2); // fg (jeton) + bg (littérale)
    // Les DEUX pastilles portent le même `data-testid` — `openingTag` n'en isole que la PREMIÈRE
    // (fg, rendu avant bg dans QrFields) : elle seule doit porter le damier.
    expect(openingTag(html, "data-testid", "color-swatch-preview")).toContain("repeating-linear-gradient");
    // La seconde (bg, "#FFFFFF") ne doit PAS être un damier — une régression qui rendrait TOUTE pastille
    // en damier (ex. `showsBound` toujours vrai) passerait le test ci-dessus sans être détectée sans
    // cette contre-épreuve.
    const secondSwatchIdx = html.indexOf('data-testid="color-swatch-preview"', html.indexOf('data-testid="color-swatch-preview"') + 1);
    expect(html.slice(secondSwatchIdx, secondSwatchIdx + 200)).not.toContain("repeating-linear-gradient");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) Un calque laissé à pleine opacité n'écrit PAS de clé `opacity` — via le SEUL curseur qui reste,
// `appearance-opacity` (Tâche 6, revue C5 : le doublon `NumberField` de la bande de géométrie, qui
// écrivait TOUJOURS une valeur bornée, jamais `undefined`, a été retiré — voir geometry-strip.tsx).
// Une mutation qui le ferait réapparaître ferait remonter le compte de `data-field="opacity"` à 2 et
// rougirait le second bloc ci-dessous.
describe("§0 — pleine opacité n'écrit AUCUNE clé `opacity` (Tâche 6, correctif d'intégration)", () => {
  it("ramener le curseur à 100 % committe `patch({ opacity: undefined })`, jamais `1`", async () => {
    const calls: EditorAction[] = [];
    const layer: Layer = { ...textLayer, opacity: 0.42 };
    const { container } = await mountPanel(layer, (a) => calls.push(a));

    const input = container.querySelector('[data-testid="appearance-opacity-input"]') as HTMLInputElement;
    await typeAndBlur(input, 100);

    expect(calls).toHaveLength(1);
    const action = calls[0] as { type: string; id: string; patch: Record<string, unknown> };
    expect(action.patch.opacity).toBeUndefined();
    // La clé est bien PRÉSENTE dans le correctif (pour EFFACER `opacity` d'un calque qui l'avait) mais
    // DISPARAÎT à la sérialisation JSON — la preuve la plus directe de « pas de clé opacity » pour un
    // calque qui vient de retomber à 100 % après fusion superficielle (même fusion que le réducteur,
    // editor-state.ts#setLayerProp : `{ ...layer, ...patch }`).
    const merged = { ...layer, ...action.patch };
    expect(JSON.stringify(merged)).not.toContain('"opacity"');
  });

  // Contre-épreuve du retrait : la bande de géométrie ÉPINGLÉE (`data-testid="geometry-strip"`) ne
  // porte PLUS AUCUN `data-field="opacity"` — `SliderField` en pose légitimement DEUX à l'intérieur
  // du curseur `Apparence` lui-même (un sur `<Slider>`, un sur son `<Input>` numérique synchronisé,
  // property-fields.tsx#SliderField ; compter sur TOUT le panneau donnerait donc 2 par construction,
  // même sans aucun doublon — d'où cette assertion SCOPÉE à la bande, pas un compte global). Une
  // mutation qui reposerait le `NumberField` d'opacité supprimé de geometry-strip.tsx ferait réapparaître
  // `data-field="opacity"` DANS CETTE PORTION précise et rougirait ce test.
  for (const [label, layer] of FOUR_TYPES) {
    it(`calque ${label} : la bande de géométrie ne porte plus \`data-field="opacity"\` — le curseur Apparence en reste le seul porteur`, async () => {
      const { html } = await mountPanel(layer, () => {});
      const stripIdx = html.indexOf('data-testid="geometry-strip"');
      const scrollIdx = html.indexOf('data-testid="property-sections"');
      expect(stripIdx).toBeGreaterThan(-1);
      expect(scrollIdx).toBeGreaterThan(-1);
      expect(html.slice(stripIdx, scrollIdx)).not.toContain('data-field="opacity"');
      expect(html).toContain('data-testid="appearance-opacity"');
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) LE PLUS IMPORTANT — une scène sans `opacity` ni couleur alpha fait un aller-retour deep-equal
// par `parseScene`. Si une des cinq tâches de ce chantier avait introduit une dérive de sérialisation
// (un défaut zod qui écrirait une clé absente, une transformation qui recalculerait une valeur…),
// CE test rougirait — aucun des tests ci-dessus (montage DOM d'un seul calque à la fois) ne l'aurait
// détecté, puisqu'aucun n'appelle jamais `parseScene` lui-même.
describe("§0 — LE PLUS IMPORTANT : round-trip deep-equal par parseScene, sans opacity ni couleur alpha", () => {
  it("une scène à quatre calques (texte/forme/image/qr), sans `opacity` ni couleur alpha nulle part, ressort IDENTIQUE de parseScene", () => {
    const s = scene([textLayer, shapeLayer, imageLayer, qrLayer]);
    // Contre-épreuve de la fixture elle-même, avant même d'appeler parseScene : si un jour quelqu'un
    // ajoute par erreur `opacity` ou une couleur à 8 chiffres hex à l'une des quatre fixtures
    // ci-dessus, CETTE assertion le dit tout de suite plutôt que de laisser le test suivant échouer
    // pour une raison qu'il faudrait redécouvrir.
    for (const l of s.layers) expect(Object.prototype.hasOwnProperty.call(l, "opacity")).toBe(false);
    expect(JSON.stringify(s)).not.toMatch(/#[0-9a-fA-F]{8}/);

    const roundTripped = parseScene(s);
    expect(roundTripped).toEqual(s);
    // `toEqual` seul ne distinguerait pas un calque auquel `parseScene` aurait ajouté une clé
    // `opacity: undefined` explicite (toEqual traite `{}` et `{opacity: undefined}` comme égaux) — la
    // sérialisation JSON, elle, les distingue, exactement comme l'autosave (qui compare des JSON) le
    // ferait en pratique.
    expect(JSON.stringify(roundTripped)).toBe(JSON.stringify(s));
  });

  it("un calque à pleine opacité EXPLICITE (`opacity: 1`) ressort identique — parseScene ne l'efface pas de son côté (ce n'est PAS son rôle, seul `OpacityField#onCommit` efface)", () => {
    // Contre-épreuve du point (c) : l'effacement de `opacity` à 100 % est une décision de
    // `OpacityField#onCommit` (property-panel.tsx), jamais du SCHÉMA — une scène qui porte déjà
    // `opacity: 1` (écrite avant cette tâche, ou par un import) reste TELLE QUELLE tant qu'aucun geste
    // ne la retouche. `parseScene` n'a pas à connaître cette convention d'écriture.
    const s = scene([{ ...textLayer, opacity: 1 }]);
    expect(parseScene(s)).toEqual(s);
  });
});
