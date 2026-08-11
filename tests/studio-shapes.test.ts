import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseScene, SHAPE_KINDS, type Scene, type ShapeKind, type ShapeLayer } from "@/lib/studio/scene";
import {
  SHAPE_DESCRIPTORS, descriptorFor, layerBorder, layerSupportsRotation, polygonClip, shapeCssFor,
  shapeLabel, supportsBorder, supportsRotation, type ShapeCss,
} from "@/lib/studio/shapes";
import { sceneToElement } from "@/lib/studio/element";
import { SHAPE_TILES } from "@/lib/studio/shape-gallery";
import { LayerView } from "@/components/studio/layer-view";

// ============================================================================
// U3 Tâche 2 — UNE description de forme, consommée par les DEUX chemins de rendu.
//
// §0 du plan : il existe DEUX implémentations indépendantes du dessin d'une forme, et aucune ne
// connaît l'autre — `shapeNode()` (lib/studio/element.ts) alimente Satori donc le PNG exporté ;
// `ShapeContent()` (components/studio/layer-view.tsx) alimente le canevas que le designer regarde.
// Une tâche qui en instruit UNE seule livre un éditeur en désaccord avec son propre export, SANS
// qu'aucun test ne rougisse. Ce fichier est le garde-fou qui rend ce désaccord impossible : tout ce
// qu'il vérifie, il le vérifie EN ITÉRANT `SHAPE_KINDS` (jamais une copie recopiée à la main — U1 a
// livré exactement ce défaut dans sa galerie de formes, et le harnais de U0 l'a relivré dans son
// garde-fou de globals) et sur LES DEUX chemins.
//
// Cadre de test NON CARRÉ (800×400) partout. C'est une règle, pas un goût : la sonde (Tâche 1) a
// mesuré qu'un `polygon()` percentuel écrit avec une espace après la virgule résout son abscisse
// contre la HAUTEUR du cadre — défaut TOTALEMENT invisible sur un cadre carré.
// ============================================================================

const BASE = { visible: true, locked: false } as const;
const FRAME = { x: 0, y: 0, w: 800, h: 400 } as const; // non carré, cf. en-tête

// Le calque de référence d'une forme : porte un `radius` pour qu'AUCUNE description ne puisse
// renvoyer une CSS vide et faire passer les boucles ci-dessous à vide (cf. l'anti-vacuité plus bas).
function shapeLayerOf(kind: ShapeKind, extra: Partial<ShapeLayer> = {}): ShapeLayer {
  return { ...BASE, id: "s", name: "forme", frame: { ...FRAME }, type: "shape", shape: kind, fill: "#FF0000", radius: 12, ...extra } as ShapeLayer;
}

// ── Chemin EXPORT : le style réellement remis à Satori par sceneToElement(). ─────────────────────
function exportStyleOf(layer: ShapeLayer): Record<string, unknown> {
  const scene = {
    schemaVersion: 1 as const,
    canvas: { width: 800, height: 400, background: "#0000FF" },
    layers: [layer],
  } satisfies Scene;
  const root = sceneToElement(scene, new Map());
  const children = (root.props as { children: { props: { style: Record<string, unknown> } }[] }).children;
  return children[0].props.style;
}

// ── Chemin ÉDITEUR : les déclarations CSS réellement sérialisées par React. ──────────────────────
// On lit le SECOND attribut `style=` du HTML : le premier est le cadre posé par LayerView, le
// second est le div peint par ShapeContent. Les déclarations sont PARSÉES (jamais cherchées par
// `toContain`) — un `toContain("border-radius:12px")` passerait aussi bien sur
// `border-top-left-radius:12px`, exactement le piège de sous-chaîne relevé en revue de U1/U2.
function editorDeclsOf(layer: ShapeLayer): Map<string, string> {
  const html = renderToStaticMarkup(
    React.createElement(LayerView, { layer, frame: layer.frame, rotation: 0, selected: false }),
  );
  const styles = [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]);
  if (styles.length < 2) throw new Error(`ShapeContent n'a pas peint de div stylé : ${html}`);
  const decls = new Map<string, string>();
  for (const decl of styles[1].split(";")) {
    const i = decl.indexOf(":");
    if (i === -1) continue;
    decls.set(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
  }
  return decls;
}

// La traduction propriété React -> propriété CSS, et la sérialisation d'une VALEUR par React.
// PIÈGE VÉRIFIÉ (témoin capturé avant refactor) : React écrit `border-radius:0`, JAMAIS
// `border-radius:0px` — un nombre reçoit « px » sauf s'il vaut 0 ou si la propriété est sans unité.
function cssName(prop: string): string {
  return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}
function cssValue(value: number | string): string {
  return typeof value === "number" ? (value === 0 ? "0" : `${value}px`) : value;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// GARDE-FOU DE COMPLÉTUDE — pour CHAQUE forme du schéma, les DEUX chemins.
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("shapes.ts — garde-fou de complétude sur SHAPE_KINDS", () => {
  it("la table de descriptions couvre EXACTEMENT les formes du schéma", () => {
    // La table est typée `Record<ShapeKind, …>` : une forme ajoutée à SHAPE_KINDS sans description
    // ne compile pas. Mais `bun test` ne typecheck PAS — donc la garde doit aussi exister à
    // l'exécution, sinon « ajouter une forme sans la décrire » ne rougirait qu'à `tsc`.
    expect(Object.keys(SHAPE_DESCRIPTORS).sort()).toEqual([...SHAPE_KINDS].sort());
  });

  it("une forme SANS description LÈVE — jamais un repli silencieux sur un rectangle", () => {
    // Le repli silencieux est le scénario que §0 décrit : le designer insère une ellipse, l'export
    // contient un rectangle, et rien n'échoue. Ici, ça lève, en français, en nommant la forme.
    expect(() => descriptorFor("losange" as ShapeKind)).toThrow(/losange/);
    expect(() => shapeCssFor(shapeLayerOf("losange" as ShapeKind))).toThrow(/losange/);
  });

  for (const kind of SHAPE_KINDS) {
    describe(`forme « ${kind} »`, () => {
      it("est décrite : sa clé, son libellé français, son drapeau de découpe", () => {
        const d = descriptorFor(kind);
        expect(d.kind).toBe(kind);
        expect(d.label.trim().length).toBeGreaterThan(0);
        expect(typeof d.clipped).toBe("boolean");
        // U3 Tâche 3 : deux décisions de plus, EXPLICITES par forme plutôt que devinées ailleurs —
        // le rayon s'applique-t-il (sinon il est ignoré, pas mal appliqué), et la galerie insère-t-elle
        // cette forme comme une BARRE fine (la « ligne ») plutôt que comme un carré.
        expect(typeof d.radiusApplies).toBe("boolean");
        expect(typeof d.thin).toBe("boolean");
      });

      it("déclare une CSS non vide, et LES DEUX chemins la peignent à l'identique", () => {
        const layer = shapeLayerOf(kind);
        const declared: ShapeCss = shapeCssFor(layer);

        // ANTI-VACUITÉ, et ce n'en est pas une elle-même : sans cette ligne, une description qui
        // renverrait `{}` ferait passer les deux boucles ci-dessous SANS RIEN VÉRIFIER (le défaut
        // exact relevé en revue de U2 : une garde anti-vacuité qui était elle-même vide).
        const props = Object.entries(declared);
        expect(props.length).toBeGreaterThan(0);

        const exported = exportStyleOf(layer);
        const editor = editorDeclsOf(layer);
        for (const [prop, value] of props) {
          expect(exported[prop]).toBe(value);                                  // Satori -> PNG
          expect(editor.get(cssName(prop))).toBe(cssValue(value as number | string)); // navigateur
        }
      });

      it("le drapeau `clipped` dit la VÉRITÉ sur la CSS émise (arbitrage A)", () => {
        // C'est ce drapeau — pas une liste de noms en dur — qui décide si une forme peut tourner :
        // satori enveloppe une forme découpée dans un `<g clip-path>` exprimé dans le repère du
        // PARENT, que `transform` ne traverse pas (mesuré en pixels, Tâche 1, réserve 2). Une
        // description qui déclarerait `clipped: false` tout en émettant un `clipPath` mentirait à
        // l'interface de la Tâche 3 ; cette assertion l'interdit.
        const declared = shapeCssFor(shapeLayerOf(kind));
        expect(descriptorFor(kind).clipped).toBe("clipPath" in declared);
        expect(supportsRotation(kind)).toBe(!descriptorFor(kind).clipped);
      });

      it("la galerie d'insertion porte le MÊME libellé que la description", () => {
        // Sinon le même mot français existe en deux exemplaires (shape-gallery.ts et shapes.ts) et
        // peut dériver : c'est la famille de défaut que SHAPE_KINDS existe déjà pour tuer.
        const tile = SHAPE_TILES.find((t) => t.kind === "shape" && t.shape === kind);
        expect(tile).toBeDefined();
        expect(tile!.label).toBe(shapeLabel(kind));
      });
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// BALAYAGE de la fonction de choix — « quelle CSS cette forme reçoit-elle ? »
// Les quatre défauts invisibles de U2 étaient des fonctions de choix qui tenaient toutes les
// propriétés asserties EN CHAQUE POINT testé tout en sautant ENTRE les points (jusqu'à 2593 px).
// On balaie donc la seule fonction de choix introduite ici — `css(layer)` — sur une plage large,
// et on exige que les deux chemins restent d'accord en CHAQUE point.
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("shapes.ts — balayage de la fonction de choix (rayon)", () => {
  const NUMERIC = [0.5, 1, 2, 3, 5, 8, 12, 16, 24, 32, 48, 64, 100, 149, 150, 151, 199, 200, 201, 399, 400, 401, 799, 800, 801, 2593, 12.75];
  const STRINGS = ["50%", "0.5%", "8px", "100%", "8px 24px", "8px 24px 8px 24px"];

  for (const kind of SHAPE_KINDS) {
    it(`« ${kind} » : les deux chemins restent d'accord en CHAQUE point du balayage`, () => {
      for (const radius of [...NUMERIC, ...STRINGS]) {
        const layer = shapeLayerOf(kind, { radius });
        const declared = shapeCssFor(layer);
        const exported = exportStyleOf(layer);
        const editor = editorDeclsOf(layer);
        for (const [prop, value] of Object.entries(declared)) {
          expect(`${kind}@${radius} ${prop}=${String(exported[prop])}`).toBe(`${kind}@${radius} ${prop}=${String(value)}`);
          expect(`${kind}@${radius} ${cssName(prop)}=${editor.get(cssName(prop))}`)
            .toBe(`${kind}@${radius} ${cssName(prop)}=${cssValue(value as number | string)}`);
        }
      }
    });
  }

  it("rect : le rayon traverse tel quel, sans seuil ni conversion", () => {
    for (const radius of NUMERIC) {
      expect(shapeCssFor(shapeLayerOf("rect", { radius })).borderRadius).toBe(radius);
    }
    for (const radius of STRINGS) {
      expect(shapeCssFor(shapeLayerOf("rect", { radius })).borderRadius).toBe(radius);
    }
  });

  // Les deux valeurs « rien à arrondir ». Avant cette tâche les deux chemins DIVERGEAIENT sur 0 :
  // l'export omettait la propriété, l'éditeur sérialisait `border-radius:0`. Même pixel, deux
  // sorties — exactement la divergence silencieuse que §0 décrit, en miniature. Ils convergent ici.
  for (const radius of [undefined, 0]) {
    it(`rect avec radius=${String(radius)} : AUCUN border-radius, sur les deux chemins`, () => {
      const layer = shapeLayerOf("rect", { radius });
      expect(shapeCssFor(layer)).toEqual({});
      expect("borderRadius" in exportStyleOf(layer)).toBe(false);
      expect(editorDeclsOf(layer).has("border-radius")).toBe(false);
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// polygonClip — la construction CENTRALISÉE des chaînes de découpe (arbitrage B).
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("shapes.ts — polygonClip", () => {
  const TRIANGLE_PTS = [[50, 0], [100, 100], [0, 100]] as const;

  it("produit la forme COMPACTE : aucune espace après une virgule", () => {
    const s = polygonClip(TRIANGLE_PTS);
    expect(s).toBe("polygon(50% 0%,100% 100%,0% 100%)");
    // Assertion structurelle, indépendante du littéral ci-dessus : chaque sommet est « x% y% » et
    // la SEULE espace d'un sommet est celle qui sépare l'abscisse de l'ordonnée. Une espace après
    // une virgule glisserait l'abscisse à l'indice 1 de satori, qui la résoudrait contre la HAUTEUR
    // du cadre (mesuré en pixels, Tâche 1 réserve 2 — voir aussi le témoin de géométrie dans
    // tests/studio-shape-render.test.ts, qui le prouve encore en pixels À TRAVERS renderScene()).
    const inner = s.slice("polygon(".length, -1);
    for (const point of inner.split(",")) {
      expect(point).toMatch(/^-?[\d.]+% -?[\d.]+%$/);
    }
    expect(inner.split(",")).toHaveLength(3);
  });

  it("aucune chaîne construite ne contient « , » suivi d'une espace, quels que soient les sommets", () => {
    const shapes = [
      TRIANGLE_PTS,
      [[50, 0], [61, 35], [98, 35], [68, 57], [79, 91], [50, 70], [21, 91], [32, 57], [2, 35], [39, 35]],
      [[0, 0], [100, 100], [0, 100]],
      [[33.333333, 0], [100, 66.666666], [0, 100]],
    ] as const;
    for (const pts of shapes) {
      const s = polygonClip(pts as readonly (readonly [number, number])[]);
      expect(s.includes(", ")).toBe(false);
      expect(s.startsWith("polygon(")).toBe(true);
      expect(s.endsWith(")")).toBe(true);
    }
  });

  it("arrondit sans traîner de bruit flottant", () => {
    expect(polygonClip([[100 / 3, 0], [100, 100], [0, 100]])).toBe("polygon(33.3333% 0%,100% 100%,0% 100%)");
  });

  it("refuse ce qui ne peut PAS être un polygone", () => {
    expect(() => polygonClip([[0, 0], [100, 100]])).toThrow(/polygone/i);
    expect(() => polygonClip([[0, 0], [100, 100], [Number.NaN, 0]])).toThrow(/fini/i);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// LE REFACTOR NE CHANGE RIEN POUR `rect` — témoins capturés à HEAD 807080f AVANT toute modification.
// C'est la seule preuve acceptable d'un refactor : la sortie, caractère pour caractère.
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("rect — identité de sortie avant/après refactor", () => {
  const goldenScene: Scene = {
    schemaVersion: 1,
    canvas: { width: 800, height: 400, background: "#0000FF" },
    layers: [
      { ...BASE, id: "a", name: "plein", frame: { x: 0, y: 0, w: 800, h: 400 },
        type: "shape", shape: "rect", fill: "#FF0000", radius: 60 },
      { ...BASE, id: "b", name: "degrade", frame: { x: 40, y: 40, w: 300, h: 200 },
        type: "shape", shape: "rect", fill: { angle: 45, stops: [{ color: "#00FF00", at: 0 }, { color: "#FFFFFF", at: 1 }] },
        radius: 12, rotation: 20, opacity: 0.8 },
      { ...BASE, id: "c", name: "borde", frame: { x: 400, y: 200, w: 300, h: 150 },
        type: "shape", shape: "rect", fill: "transparent", border: { width: 6, color: "#00FF00", sides: ["top", "bottom"] } },
    ],
  };

  // JSON.stringify capture aussi l'ORDRE des clés — `toEqual` ne l'aurait pas fait, et l'ordre est
  // précisément ce qu'un refactor de spread peut changer par accident.
  const GOLDEN_NODE = '{"type":"div","props":{"style":{"display":"flex","position":"relative","width":800,"height":400,"backgroundColor":"#0000FF"},"children":[{"type":"div","props":{"data-layer":"a","style":{"position":"absolute","left":0,"top":0,"width":800,"height":400,"display":"flex","backgroundColor":"#FF0000","borderRadius":60}}},{"type":"div","props":{"data-layer":"b","style":{"position":"absolute","left":40,"top":40,"width":300,"height":200,"display":"flex","opacity":0.8,"transform":"rotate(20deg)","backgroundImage":"linear-gradient(45deg, #00FF00 0%, #FFFFFF 100%)","borderRadius":12}}},{"type":"div","props":{"data-layer":"c","style":{"position":"absolute","left":400,"top":200,"width":300,"height":150,"display":"flex","borderTop":"6px solid #00FF00","borderBottom":"6px solid #00FF00"}}}]}}';

  it("chemin EXPORT : l'arbre de nœuds remis à Satori est identique, ordre des clés compris", () => {
    expect(JSON.stringify(sceneToElement(goldenScene, new Map()))).toBe(GOLDEN_NODE);
  });

  // Témoins ÉDITEUR : le HTML exact que React sérialisait avant le refactor, pour six variantes de
  // remplissage/rayon/bordure. `rotation: 15` et `selected: false` figés pour que le cadre extérieur
  // fasse partie du témoin lui aussi.
  const EDITOR_GOLDENS: Record<string, [Partial<ShapeLayer>, string]> = {
    "sans rayon": [{ radius: undefined },
      '<div data-layer-id="r0" style="position:absolute;left:1px;top:2px;width:30px;height:40px;transform:rotate(15deg);box-sizing:border-box;cursor:move"><div style="width:100%;height:100%;background-color:#123456"></div></div>'],
    "rayon 12": [{ radius: 12 },
      '<div data-layer-id="r0" style="position:absolute;left:1px;top:2px;width:30px;height:40px;transform:rotate(15deg);box-sizing:border-box;cursor:move"><div style="width:100%;height:100%;background-color:#123456;border-radius:12px"></div></div>'],
    "remplissage transparent": [{ fill: "transparent", radius: 3 },
      '<div data-layer-id="r0" style="position:absolute;left:1px;top:2px;width:30px;height:40px;transform:rotate(15deg);box-sizing:border-box;cursor:move"><div style="width:100%;height:100%;border-radius:3px"></div></div>'],
    "remplissage par jeton": [{ fill: "{{category.color}}", radius: undefined },
      '<div data-layer-id="r0" style="position:absolute;left:1px;top:2px;width:30px;height:40px;transform:rotate(15deg);box-sizing:border-box;cursor:move"><div style="width:100%;height:100%;background:repeating-linear-gradient(45deg, #666 0, #666 6px, #999 6px, #999 12px)"></div></div>'],
    "dégradé": [{ fill: { angle: 90, stops: [{ color: "#000000", at: 0 }, { color: "#FFFFFF", at: 1 }] }, radius: 4 },
      '<div data-layer-id="r0" style="position:absolute;left:1px;top:2px;width:30px;height:40px;transform:rotate(15deg);box-sizing:border-box;cursor:move"><div style="width:100%;height:100%;background-image:linear-gradient(90deg, #000000 0%, #FFFFFF 100%);border-radius:4px"></div></div>'],
    "bordure partielle": [{ radius: 5, border: { width: 2, color: "#FFF", sides: ["top", "left"] } },
      '<div data-layer-id="r0" style="position:absolute;left:1px;top:2px;width:30px;height:40px;transform:rotate(15deg);box-sizing:border-box;cursor:move"><div style="width:100%;height:100%;background-color:#123456;border-top:2px solid #FFF;border-left:2px solid #FFF;border-radius:5px"></div></div>'],
  };

  for (const [name, [extra, golden]] of Object.entries(EDITOR_GOLDENS)) {
    it(`chemin ÉDITEUR : « ${name} » sérialise exactement le même HTML qu'avant`, () => {
      const layer = { ...BASE, id: "r0", name: "n", frame: { x: 1, y: 2, w: 30, h: 40 },
        type: "shape", shape: "rect", fill: "#123456", ...extra } as ShapeLayer;
      const html = renderToStaticMarkup(
        React.createElement(LayerView, { layer, frame: layer.frame, rotation: 15, selected: false, scale: 1 }),
      );
      expect(html).toBe(golden);
    });
  }

  // LA SEULE différence de sortie assumée par cette tâche, et elle fait CONVERGER les deux chemins :
  // avant, l'éditeur sérialisait `border-radius:0` là où l'export n'émettait rien. `border-radius:0`
  // est la valeur PAR DÉFAUT de la propriété — donc aucun pixel ne bouge — mais les deux chemins
  // écrivaient deux choses différentes pour la même scène, et c'est ce que cette tâche supprime.
  it("chemin ÉDITEUR : `radius: 0` n'écrit plus `border-radius:0` (convergence assumée)", () => {
    const layer = { ...BASE, id: "r0", name: "n", frame: { x: 1, y: 2, w: 30, h: 40 },
      type: "shape", shape: "rect", fill: "#123456", radius: 0 } as ShapeLayer;
    const html = renderToStaticMarkup(
      React.createElement(LayerView, { layer, frame: layer.frame, rotation: 15, selected: false, scale: 1 }),
    );
    expect(html).toBe('<div data-layer-id="r0" style="position:absolute;left:1px;top:2px;width:30px;height:40px;transform:rotate(15deg);box-sizing:border-box;cursor:move"><div style="width:100%;height:100%;background-color:#123456"></div></div>');
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// MIGRATION DE `radius` (arbitrage C, défaut de plan #12) — vue depuis les formes.
// Le schéma lui-même est testé dans tests/studio-scene.test.ts ; ici on vérifie que la chaîne
// traverse bien les DEUX chemins jusqu'à la CSS.
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("migration de `radius` — une chaîne traverse les deux chemins", () => {
  it("`radius: \"50%\"` arrive intact côté Satori ET côté navigateur", () => {
    const layer = shapeLayerOf("rect", { radius: "50%" });
    expect(exportStyleOf(layer).borderRadius).toBe("50%");
    expect(editorDeclsOf(layer).get("border-radius")).toBe("50%");
  });

  it("une scène portant un rayon en pourcentage se relit par parseScene", () => {
    const scene = {
      schemaVersion: 1,
      canvas: { width: 800, height: 400, background: "#000000" },
      layers: [shapeLayerOf("rect", { radius: "50%" })],
    };
    const back = parseScene(JSON.parse(JSON.stringify(scene)));
    expect((back.layers[0] as ShapeLayer).radius).toBe("50%");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Deux gardes ajoutées après la revue de la Tâche 2. La seconde est un PIÈGE DÉLIBÉRÉ.
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("garde — les libellés sont UNIQUES", () => {
  it("deux formes ne peuvent pas porter le même libellé français", () => {
    // Revue Tâche 2, Mineur 1 : la NON-VACUITÉ du libellé était affirmée, son UNICITÉ non. Or
    // `shape-gallery.ts` pose `name: tile.label` sur le calque inséré : deux libellés identiques
    // donneraient deux tuiles indiscernables dans la galerie ET deux calques indiscernables dans le
    // panneau des calques. Vacant à une seule forme, vivant dès que la Tâche 3 en livre sept.
    const labels = SHAPE_KINDS.map((k) => shapeLabel(k));
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("le catalogue des formes — la garde de comptage, ex-« PIÈGE POUR LA TÂCHE 3 »", () => {
  it("le catalogue compte huit formes, et les trois dettes du piège sont réglées", () => {
    // CE TEST ÉTAIT UN PIÈGE : il affirmait `length === 1` pour ÉCHOUER dès que la Tâche 3 ajoute une
    // forme, parce que trois dettes ne pouvaient pas être réglées avec « rect » seul (chacune était
    // une branche morte qu'aucune mutation ne pouvait faire rougir). Les trois sont réglées, et
    // chacune a désormais un test qui la garde VIVANTE — c'est ce qui remplace le piège :
    //
    //  1. Le champ « Rayon des coins » (property-panel.tsx) n'est plus numérique : il affiche la
    //     valeur STOCKÉE telle qu'elle est et ne l'écrase pas.
    //     → tests/studio-property-panel.test.ts, « le rayon d'une forme (dette 1) » ;
    //       tests/studio-scene.test.ts, « le rayon vu par l'interface ».
    //     → et, pour les formes où le rayon n'a AUCUN sens, le champ disparaît derrière une note
    //       plutôt que d'être appliqué de travers : « le rayon est ignoré, pas mal appliqué » ci-dessous.
    //
    //  2. `supportsRotation(kind)` fait bien DEUX choses : la `transform` de rotation est supprimée
    //     pour les formes découpées DANS LES DEUX CHEMINS DE RENDU (sinon toute scène portant déjà une
    //     rotation sur une forme découpée s'afficherait autrement dans l'éditeur que dans l'export —
    //     le §0 de ce sous-projet réintroduit par son propre correctif), ET le contrôle de rotation est
    //     grisé avec une note française.
    //     → « la rotation, sur les DEUX chemins » ci-dessous (CSS) ;
    //       tests/studio-shape-render.test.ts (PIXELS : la rotation est inerte, octet pour octet) ;
    //       tests/studio-property-panel.test.ts (le contrôle grisé et sa note).
    //
    //  3. `stubShapeCss` est SUPPRIMÉ de tests/studio-shape-render.test.ts : la preuve en pixels d'une
    //     découpe passe maintenant par la description RÉELLE du triangle, sans aucune substitution.
    //
    // Ce que ce test garde encore : le COMPTE. Le changer sans relire ce qui précède est exactement le
    // geste que le piège interdisait ; toute forme ajoutée doit repasser par les quatre garde-fous
    // (les deux chemins, la rotation, le rayon, les pixels) qui itèrent tous `SHAPE_KINDS`.
    expect(SHAPE_KINDS.length).toBe(8);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// U3 TÂCHE 3 — LA FAMILLE DE FORMES.
//
// Ce qui suit itère `SHAPE_KINDS` sans exception : une forme ajoutée sans rayon décidé, sans polygone
// sain ou sans position sur la rotation fait rougir ce fichier, pas une revue.
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Relit une chaîne `polygon(x% y%,…)` en sommets — pour vérifier la TABLE, pas la mise en forme. */
function verticesOf(clipPath: string): Point[] {
  const m = /^polygon\((.*)\)$/.exec(clipPath);
  if (!m) throw new Error(`chaîne de découpe inattendue : ${clipPath}`);
  return m[1].split(",").map((point) => {
    const parts = point.split(" ");
    if (parts.length !== 2) throw new Error(`sommet inattendu « ${point} » dans ${clipPath}`);
    return parts.map((v) => {
      if (!v.endsWith("%")) throw new Error(`sommet non percentuel « ${point} » dans ${clipPath}`);
      return Number(v.slice(0, -1));
    }) as Point;
  });
}

/** Aire signée (formule du lacet), en % ² de la boîte — > 0 dans le sens horaire écran. */
function signedArea(pts: readonly Point[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

type Point = [number, number];
const cross = (p: Point, q: Point, r: Point) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);

// Deux arêtes NON ADJACENTES sont-elles en conflit ? Sert à prouver qu'aucune table de sommets n'est
// auto-sécante : un polygone croisé se rend en « evenodd » et fabrique des trous que personne n'a
// demandés — le genre de faute qu'une coquille dans un tableau produit et qu'un rendu de 30 px ne
// montre pas.
//
// DEUX cas, et le second a été ajouté parce qu'une MUTATION est passée sans lui : permuter deux
// sommets de la bulle produit deux arêtes COLINÉAIRES qui se recouvrent (toutes deux sur y = 72 %)
// plutôt qu'un croisement franc — les quatre tests d'orientation valent alors 0 et le premier cas
// répond « non ». L'aire ne bougeait pas assez pour rougir non plus. C'est exactement la sorte de
// trou qu'on ne trouve qu'en mutant, donc il est refermé ici.
function segmentsConflict(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const sign = (v: number) => (Math.abs(v) < 1e-9 ? 0 : Math.sign(v));
  const d1 = sign(cross(a1, a2, b1)), d2 = sign(cross(a1, a2, b2));
  const d3 = sign(cross(b1, b2, a1)), d4 = sign(cross(b1, b2, a2));
  // 1. Croisement PROPRE (en dehors des extrémités).
  if (d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0 && d1 !== d2 && d3 !== d4) return true;
  // 2. Colinéaires ET recouvrantes. Deux arêtes non adjacentes ne peuvent pas se toucher en UN point
  //    sans partager un sommet (déjà interdit par la garde des doublons), donc tout recouvrement de
  //    longueur non nulle est un défaut.
  if (d1 !== 0 || d2 !== 0) return false;
  const axis = Math.abs(a2[0] - a1[0]) >= Math.abs(a2[1] - a1[1]) ? 0 : 1;
  const chevauchement = Math.min(Math.max(a1[axis], a2[axis]), Math.max(b1[axis], b2[axis]))
    - Math.max(Math.min(a1[axis], a2[axis]), Math.min(b1[axis], b2[axis]));
  return chevauchement > 1e-9;
}

describe("la famille de formes — le rayon est appliqué où il a un sens, IGNORÉ ailleurs", () => {
  // Cadres délibérément extrêmes : `minSize` sur un axe (hooks/use-layer-drag.ts, MIN_SIZE = 1),
  // sur les deux, et des rapports d'aspect violents dans les deux sens. Tous les défauts de U2
  // vivaient à un extrême.
  const FRAMES = [
    { x: 0, y: 0, w: 800, h: 400 },
    { x: 0, y: 0, w: 1, h: 1 },       // minSize sur les DEUX axes
    { x: 0, y: 0, w: 1, h: 400 },     // minSize sur l'axe fin, vertical
    { x: 0, y: 0, w: 800, h: 1 },     // minSize sur l'axe fin, horizontal
    { x: 0, y: 0, w: 2593, h: 7 },    // rapport 370:1
    { x: 0, y: 0, w: 7, h: 2593 },    // et son inverse
  ] as const;

  for (const kind of SHAPE_KINDS) {
    it(`« ${kind} » : la CSS dépend du rayon SI ET SEULEMENT SI la description le dit`, () => {
      const applies = descriptorFor(kind).radiusApplies;
      const sorties = [undefined, 0, 12, 77, "50%", "8px 24px"].map((radius) =>
        JSON.stringify(shapeCssFor(shapeLayerOf(kind, { radius: radius as never }))),
      );
      const distinctes = new Set(sorties).size;
      // `radiusApplies: false` veut dire IGNORÉ, pas « mal appliqué » : la sortie est LA MÊME pour
      // les six valeurs, y compris « 8px 24px ». `true` veut dire qu'au moins deux valeurs de rayon
      // produisent deux CSS différentes — sinon le drapeau mentirait dans l'autre sens.
      expect(`${kind} applique=${applies} sorties distinctes=${distinctes > 1}`)
        .toBe(`${kind} applique=${applies} sorties distinctes=${applies}`);
    });

    it(`« ${kind} » : la CSS ne dépend PAS du cadre — donc aucun extrême ne la dégénère`, () => {
      // La géométrie de toute forme livrée ici est PERCENTUELLE (borderRadius « 50% », sommets en %) :
      // elle est donc invariante d'échelle par construction, et c'est CE fait qui la rend sûre à
      // `minSize` comme à un rapport d'aspect de 370:1. Une description qui se mettrait à calculer en
      // pixels depuis `layer.frame` (un « chevron dont la pointe fait 20 px ») romprait cette
      // invariance et pourrait dégénérer sur un cadre de 1 px — ce test l'interdit.
      const reference = JSON.stringify(shapeCssFor(shapeLayerOf(kind, { frame: { ...FRAMES[0] } })));
      for (const frame of FRAMES) {
        expect(`${kind}@${frame.w}x${frame.h} ${JSON.stringify(shapeCssFor(shapeLayerOf(kind, { frame: { ...frame } })))}`)
          .toBe(`${kind}@${frame.w}x${frame.h} ${reference}`);
      }
    });
  }
});

describe("la famille de formes — la table de sommets de chaque forme découpée", () => {
  const clippedKinds = SHAPE_KINDS.filter((k) => descriptorFor(k).clipped);

  it("il existe bien des formes découpées — sans quoi tout ce bloc serait vide", () => {
    // ANTI-VACUITÉ : `SHAPE_KINDS.filter(...)` vide ferait passer chaque boucle ci-dessous SANS RIEN
    // vérifier (le défaut exact relevé en revue de U2 : une garde anti-vacuité elle-même vide).
    expect(clippedKinds.length).toBeGreaterThan(0);
  });

  for (const kind of clippedKinds) {
    it(`« ${kind} » : sommets DANS la boîte, sans doublon, aire franche, polygone SIMPLE`, () => {
      const clip = shapeCssFor(shapeLayerOf(kind)).clipPath!;
      const pts = verticesOf(clip);
      expect(pts.length).toBeGreaterThanOrEqual(3);

      // 1. DANS la boîte. `clip-path` coupe au bord de l'élément : un sommet à 110 % serait
      //    silencieusement rogné, et la forme dessinée ne serait pas celle de la table.
      for (const [x, y] of pts) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(100);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(100);
      }

      // 2. Aucun sommet consécutif dupliqué (une coquille classique dans une table recopiée).
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        expect(`${kind} sommets ${i} et ${(i + 1) % pts.length} distincts`)
          .toBe(`${kind} sommets ${i} et ${(i + 1) % pts.length} ${a[0] === b[0] && a[1] === b[1] ? "CONFONDUS" : "distincts"}`);
      }

      // 3. Une aire FRANCHE : au moins 10 % de la boîte. Une table dont les sommets s'alignent
      //    presque (aire ≈ 0) donnerait une forme invisible sans que rien ne lève.
      expect(Math.abs(signedArea(pts)) / 100).toBeGreaterThan(10);

      // 4. Polygone SIMPLE : aucun croisement entre deux arêtes non adjacentes.
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 2; j < pts.length; j++) {
          if (i === 0 && j === pts.length - 1) continue; // arêtes adjacentes par la fermeture
          const croise = segmentsConflict(pts[i], pts[(i + 1) % pts.length], pts[j], pts[(j + 1) % pts.length]);
          expect(`${kind} arêtes ${i}/${j} : ${croise ? "SE CROISENT" : "ne se croisent pas"}`)
            .toBe(`${kind} arêtes ${i}/${j} : ne se croisent pas`);
        }
      }
    });

    it(`« ${kind} » : la chaîne est COMPACTE — aucune espace après une virgule`, () => {
      // La règle d'espacement (arbitrage B, réserve 1 de la sonde) appliquée à CHAQUE forme livrée,
      // et pas seulement au constructeur : une description qui assemblerait sa chaîne à la main
      // contournerait `polygonClip` sans que le test de `polygonClip` ne s'en aperçoive.
      const clip = shapeCssFor(shapeLayerOf(kind)).clipPath!;
      expect(clip.includes(", ")).toBe(false);
      expect(clip.startsWith("polygon(")).toBe(true);
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// LA ROTATION, SUR LES DEUX CHEMINS (arbitrage A, dette 2 du piège).
//
// Griser le contrôle ne suffit pas : une scène écrite AVANT cette tâche (ou par un import, ou par
// l'IA) peut déjà porter `rotation` sur une forme découpée. Dans le navigateur, `transform` tourne
// bel et bien la découpe ; dans satori, NON (sonde Tâche 1, réserve 2 — le remplissage tourne, le
// masque non). Laisser la `transform` en place, c'est donc livrer un éditeur en désaccord avec son
// export : §0 de ce sous-projet, réintroduit par son propre correctif. Elle est supprimée DES DEUX.
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("la rotation, sur les DEUX chemins", () => {
  for (const kind of SHAPE_KINDS) {
    it(`« ${kind} » : la transform de rotation est présente SI ET SEULEMENT SI la forme peut tourner`, () => {
      const attendue = supportsRotation(kind);
      const layer = shapeLayerOf(kind, { rotation: 45 });

      // Chemin EXPORT — le style réellement remis à Satori.
      const exportée = exportStyleOf(layer).transform;
      expect(`${kind} export transform=${String(exportée)}`)
        .toBe(`${kind} export transform=${attendue ? "rotate(45deg)" : "undefined"}`);

      // Chemin ÉDITEUR — le PREMIER attribut style du HTML (le cadre posé par LayerView), lu par
      // déclaration parsée plutôt que par `toContain("rotate")` : `transform` peut porter d'autres
      // fonctions, et une sous-chaîne ne dirait pas laquelle.
      const html = renderToStaticMarkup(
        React.createElement(LayerView, { layer, frame: layer.frame, rotation: 45, selected: false }),
      );
      const cadre = /style="([^"]*)"/.exec(html)![1];
      const decls = new Map(cadre.split(";").map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]));
      expect(`${kind} éditeur transform=${String(decls.get("transform"))}`)
        .toBe(`${kind} éditeur transform=${attendue ? "rotate(45deg)" : "undefined"}`);
    });
  }

  it("les deux camps existent — au moins une forme tourne, au moins une ne tourne pas", () => {
    // ANTI-VACUITÉ de la boucle ci-dessus : si toutes les formes tombaient du même côté, elle
    // passerait en ne testant qu'une moitié de la règle.
    const tournent = SHAPE_KINDS.filter((k) => supportsRotation(k));
    expect(tournent.length).toBeGreaterThan(0);
    expect(tournent.length).toBeLessThan(SHAPE_KINDS.length);
  });

  it("un calque NON forme garde sa rotation — la limite est PAR FORME, pas globale", () => {
    // (voir plus bas pour la bordure : même structure, même raison, réserve 3 de la sonde)
    // `layerSupportsRotation` est interrogée par les deux chemins pour TOUT calque : si elle se
    // trompait sur un calque texte ou image, cette tâche casserait la rotation de la moitié de
    // l'éditeur sans qu'aucun test de formes ne le voie.
    const texte = {
      ...BASE, id: "t", name: "t", frame: { ...FRAME }, rotation: 45,
      type: "text", content: "x", font: { family: "Noto Sans", size: 20, weight: 400 },
      color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
    } as unknown as Parameters<typeof sceneToElement>[0]["layers"][number];
    expect(layerSupportsRotation(texte)).toBe(true);
    const scene = { schemaVersion: 1 as const, canvas: { width: 800, height: 400, background: "#0000FF" }, layers: [texte] };
    const root = sceneToElement(scene, new Map());
    const child = (root.props as { children: { props: { style: Record<string, unknown> } }[] }).children[0];
    expect(child.props.style.transform).toBe("rotate(45deg)");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// LA BORDURE, SUR LES DEUX CHEMINS — RÉSERVE 3 DE LA SONDE (revue de la Tâche 3, Medium 4).
//
// La sonde (Tâche 1) a mesuré que **la bordure échappe au découpage** : satori laisse le contour
// RECTANGULAIRE autour d'un remplissage triangulaire, tandis que le navigateur applique `clip-path` à
// l'élément ENTIER, bordure comprise. Un `border` sur une forme découpée s'affiche donc autrement dans
// l'éditeur que dans le PNG livré : §0, mot pour mot.
//
// L'arbitrage F reportait la question à la Tâche 4 « parce qu'aucune forme ne porte de bordure par
// défaut ». Toujours vrai de l'INSERTION (shape-gallery.ts n'en pose aucune) — mais la Tâche 3 a livré
// le sélecteur de forme, donc « rectangle bordé » -> « Triangle » se fait en DEUX CLICS, et la section
// Bordure offrait le contrôle sur les cinq formes découpées.
//
// Le remède est celui de la rotation, pour la même raison : griser le contrôle NE SUFFIT PAS, sinon un
// `border` déjà stocké continue de diverger et la note qui l'annonce est fausse. La bordure est donc
// supprimée DES DEUX CHEMINS, et la valeur stockée survit (elle réapparaît sur un rectangle).
//
// MUTATION QUI FAIT ROUGIR : remettre `layer.border` à la place de `layerBorder(layer)` dans
// lib/studio/element.ts ou dans components/studio/layer-view.tsx (une seule des deux suffit — c'est
// tout l'intérêt de vérifier les deux chemins séparément).
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("la bordure, sur les DEUX chemins (réserve 3)", () => {
  const BORDURE = { width: 6, color: "#00FF00", sides: ["top", "right", "bottom", "left"] } as const;

  for (const kind of SHAPE_KINDS) {
    it(`« ${kind} » : la bordure est peinte SI ET SEULEMENT SI la forme peut en porter`, () => {
      const attendue = supportsBorder(kind);
      const layer = shapeLayerOf(kind, { border: { ...BORDURE, sides: [...BORDURE.sides] } });

      // La valeur STOCKÉE n'est jamais touchée — ni ici ni par le panneau : ce qui change est ce qui
      // est PEINT. C'est le même traitement que `radius` sur une ellipse.
      expect(layer.border).toEqual({ ...BORDURE, sides: [...BORDURE.sides] });
      expect(`${kind} peinte=${layerBorder(layer) !== undefined}`).toBe(`${kind} peinte=${attendue}`);

      // Chemin EXPORT — le style réellement remis à Satori.
      const exportée = exportStyleOf(layer);
      const attenduCss = "6px solid #00FF00";
      for (const prop of ["borderTop", "borderRight", "borderBottom", "borderLeft"]) {
        expect(`${kind} export ${prop}=${String(exportée[prop])}`)
          .toBe(`${kind} export ${prop}=${attendue ? attenduCss : "undefined"}`);
      }

      // Chemin ÉDITEUR — les déclarations réellement sérialisées par React, PARSÉES (jamais
      // `toContain`) : `border-top` et `border-top-left-radius` partagent un préfixe.
      const editor = editorDeclsOf(layer);
      for (const prop of ["border-top", "border-right", "border-bottom", "border-left"]) {
        expect(`${kind} éditeur ${prop}=${String(editor.get(prop))}`)
          .toBe(`${kind} éditeur ${prop}=${attendue ? attenduCss : "undefined"}`);
      }
    });
  }

  it("les deux camps existent — au moins une forme accepte la bordure, au moins une la refuse", () => {
    // ANTI-VACUITÉ de la boucle ci-dessus, exactement comme pour la rotation : si toutes les formes
    // tombaient du même côté, elle ne testerait qu'une moitié de la règle.
    const bordées = SHAPE_KINDS.filter((k) => supportsBorder(k));
    expect(bordées.length).toBeGreaterThan(0);
    expect(bordées.length).toBeLessThan(SHAPE_KINDS.length);
  });

  it("le verdict est celui du DÉCOUPAGE, jamais une liste de noms", () => {
    // Si `supportsBorder` se mettait à énumérer des noms, il pourrait dériver de `clipped` à la
    // prochaine forme ajoutée — le défaut que `SHAPE_KINDS` et `SHAPE_DESCRIPTORS` existent pour tuer.
    for (const kind of SHAPE_KINDS) {
      expect(`${kind} : ${supportsBorder(kind)}`).toBe(`${kind} : ${!descriptorFor(kind).clipped}`);
    }
  });

  it("un côté SEUL suit la même règle — ce n'est pas « tout ou rien » par accident", () => {
    // `sides` partiels : le chemin de code est le même, mais une implémentation qui n'aurait filtré
    // que le cas « quatre côtés » passerait la boucle ci-dessus. (Le rect est le témoin positif.)
    const partiel = { width: 3, color: "#FF00FF", sides: ["top", "left"] as const };
    const triangle = shapeLayerOf("triangle", { border: { ...partiel, sides: [...partiel.sides] } });
    const rect = shapeLayerOf("rect", { border: { ...partiel, sides: [...partiel.sides] } });
    expect(exportStyleOf(triangle).borderTop).toBeUndefined();
    expect(exportStyleOf(triangle).borderLeft).toBeUndefined();
    expect(editorDeclsOf(triangle).get("border-top")).toBeUndefined();
    expect(exportStyleOf(rect).borderTop).toBe("3px solid #FF00FF");
    expect(editorDeclsOf(rect).get("border-top")).toBe("3px solid #FF00FF");
    // Et les côtés NON demandés restent absents partout — le rect prouve que le filtre `sides` vit.
    expect(exportStyleOf(rect).borderRight).toBeUndefined();
  });
});
