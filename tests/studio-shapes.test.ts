import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseScene, SHAPE_KINDS, type Scene, type ShapeKind, type ShapeLayer } from "@/lib/studio/scene";
import {
  SHAPE_DESCRIPTORS, descriptorFor, polygonClip, shapeCssFor, shapeLabel, supportsRotation,
  type ShapeCss,
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

describe("PIÈGE POUR LA TÂCHE 3 — à lire quand ce test casse", () => {
  it("le nombre de formes n'a pas changé sans que les deux dettes ci-dessous soient réglées", () => {
    // CE TEST EST CONÇU POUR ÉCHOUER dès que `SHAPE_KINDS` grandit. Ce n'est pas un bug : c'est le
    // seul mécanisme qui force à traiter deux dettes que la Tâche 2 ne POUVAIT pas régler (avec
    // « rect » seul, les deux branches sont du code mort qu'aucune mutation ne peut faire rougir).
    // La revue a été explicite : « rien n'oblige la Tâche 3, il n'y a qu'un commentaire ».
    //
    // AVANT de mettre ce nombre à jour, régler les DEUX :
    //
    //  1. `components/studio/property-panel.tsx` — le champ NUMÉRIQUE « Rayon des coins » affiche 0
    //     pour un rayon en CHAÎNE (« 50% ») et l'ÉCRASE à la première édition. Inatteignable tant
    //     qu'aucune forme n'utilise de pourcentage ; vivant à l'instant où l'ellipse est livrée.
    //
    //  2. `supportsRotation(kind)` doit faire DEUX choses, pas une : griser le contrôle de rotation
    //     AVEC une note en français, ET supprimer la `transform` de rotation pour les formes
    //     découpées DANS LES DEUX CHEMINS DE RENDU. Dans le navigateur `transform` tourne bel et bien
    //     la découpe ; dans satori NON (sonde Tâche 1, réserve 2). Ne griser que le contrôle laisse
    //     toute scène portant DÉJÀ une rotation sur une forme découpée s'afficher différemment dans
    //     l'éditeur et dans l'export — soit exactement le §0 de ce sous-projet, réintroduit par son
    //     propre correctif.
    //
    //  3. Accessoirement : la première description RÉELLEMENT découpée rend `stubShapeCss`
    //     supprimable dans tests/studio-shape-render.test.ts, et la preuve en pixels cesse alors de
    //     passer par une substitution (revue Tâche 2, arbitrage 1).
    expect(SHAPE_KINDS.length).toBe(1);
  });
});
