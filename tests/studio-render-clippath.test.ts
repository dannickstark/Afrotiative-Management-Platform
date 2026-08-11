import { describe, it, expect, beforeAll } from "bun:test";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { renderScene } from "@/lib/studio/render";
import { sceneToElement, type SatoriNode } from "@/lib/studio/element";
import { loadFallbackFonts, type LoadedFont } from "@/lib/studio/fonts";
import type { Scene } from "@/lib/studio/scene";

// ============================================================================
// SONDE clipPath (U3 Tâche 1) — CE FICHIER ÉTABLIT UNE CONNAISSANCE, PAS UNE FONCTIONNALITÉ.
//
// La question : le pipeline RÉEL de ce projet (satori -> resvg -> sharp) sait-il dessiner une forme
// NON RECTANGULAIRE, et par quel mécanisme ? La feuille de route portait une réserve explicite —
// « la présence de clipPath dans la liste vient de la documentation de Satori, pas d'un polygone
// effectivement rendu par ce projet ». Ce fichier la lève, avec des PIXELS.
//
// POURQUOI DES PIXELS, ET RIEN D'AUTRE. Un `clipPath` silencieusement ignoré produit un PNG
// parfaitement valide, parfaitement rectangulaire. Donc :
//   — « le rendu n'a pas levé »        ne prouve rien ;
//   — « les octets ne sont pas vides » ne prouve rien ;
//   — une assertion sur le SVG intermédiaire ne prouve rien de ce que resvg RASTERISE ;
//   — un navigateur ne prouve rien du tout : ce n'est pas le moteur.
// Chaque affirmation ci-dessous compare donc la COULEUR d'un pixel de sortie, et chacune est
// accompagnée d'un TÉMOIN qui produit la classification INVERSE au MÊME point — sans quoi
// l'affirmation ne pourrait pas rougir et n'établirait rien.
//
// POURQUOI PAS renderScene() DE BOUT EN BOUT POUR clipPath. `ShapeLayer` (lib/studio/scene.ts) n'a
// aujourd'hui AUCUN champ capable de porter un clipPath, et `shapeNode()` (lib/studio/element.ts)
// n'en émet aucun : le chemin de production ne PEUT PAS exprimer un polygone avant que la Tâche 2
// ne lui en donne le moyen. Cette tâche a interdiction de toucher un fichier de production, donc la
// sonde reconstruit le pipeline à l'identique (`probe()` ci-dessous) et le PROUVE par un témoin de
// fidélité : sur une scène que le schéma SAIT exprimer, `probe(sceneToElement(scene))` et
// `renderScene(scene)` produisent des octets IDENTIQUES. Ce qui est mesuré ici est donc bien le
// moteur de production, à l'arbre de nœuds près.
// ============================================================================

let fonts: LoadedFont[];
beforeAll(async () => { fonts = await loadFallbackFonts(); });

// Réplique EXACTE des étapes 5 de renderScene() : satori(width/height/fonts/embedFont:true) ->
// Resvg(fitTo width) -> sharp().removeAlpha().jpeg({quality:86, mozjpeg:true}). Le test
// « fidélité » plus bas vérifie que cette réplique n'a pas dérivé.
async function probe(node: SatoriNode, width: number, height: number): Promise<Uint8Array> {
  const svg = await satori(node as never, {
    width, height,
    fonts: fonts as unknown as Parameters<typeof satori>[1]["fonts"],
    embedFont: true,
  });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
  return new Uint8Array(await sharp(png).removeAlpha().jpeg({ quality: 86, mozjpeg: true }).toBuffer());
}

const FILL = "#FF0000";   // rouge pur
const BG = "#0000FF";     // bleu pur
const STROKE = "#00FF00"; // vert pur — la bordure, pour la distinguer des deux autres

// Trois couleurs primaires SATURÉES et mutuellement éloignées de 255 sur au moins deux canaux : le
// JPEG (encodage réel de production, qualité 86 + sous-échantillonnage de chrominance) les rend à
// ±1, très en deçà de la tolérance, et AUCUN mélange bord-à-bord ne peut être confondu avec l'une
// d'elles. Un pixel qui n'est aucune des trois est renvoyé TEL QUEL (« rgba(...) ») : le message
// d'échec de bun affiche alors la valeur réellement lue, pas un booléen.
type Sampler = (x: number, y: number) => string;
const TOLERANCE = 24;

async function sampler(bytes: Uint8Array): Promise<Sampler> {
  const { data, info } = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return (x, y) => {
    const i = (y * info.width + x) * info.channels;
    const p = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    const near = (t: number[]) => t.every((v, k) => Math.abs(p[k] - v) <= TOLERANCE);
    if (near([255, 0, 0])) return "remplissage";
    if (near([0, 0, 255])) return "fond";
    if (near([0, 255, 0])) return "bordure";
    return `rgba(${p.join(",")})`;
  };
}

function canvasNode(w: number, h: number, children: SatoriNode[]): SatoriNode {
  return { type: "div", props: { style: { display: "flex", position: "relative", width: w, height: h, backgroundColor: BG }, children } };
}
function boxNode(w: number, h: number, style: Record<string, unknown>, x = 0, y = 0): SatoriNode {
  return { type: "div", props: { style: { position: "absolute", left: x, top: y, width: w, height: h, display: "flex", backgroundColor: FILL, ...style } } };
}
// Une seule boîte, plein canevas, avec le style à l'essai.
async function paint(w: number, h: number, style: Record<string, unknown>): Promise<Sampler> {
  return sampler(await probe(canvasNode(w, h, [boxNode(w, h, style)]), w, h));
}

// Triangle canonique de la feuille de route. NOTER L'ABSENCE D'ESPACE APRÈS LES VIRGULES : le test
// « géométrie percentuelle » plus bas explique pourquoi ce n'est pas un détail de style.
const TRIANGLE = "polygon(50% 0,100% 100%,0 100%)";

describe("sonde clipPath — fidélité de la sonde au pipeline de production", () => {
  // Sans ce témoin, TOUT ce fichier ne mesurerait qu'un pipeline de test inventé pour l'occasion,
  // et les conclusions ne s'appliqueraient à rien. Mutation qui le fait rougir : changer un seul
  // paramètre de `probe` (quality, mozjpeg, embedFont, fitTo) le rend faux immédiatement.
  it("produit exactement les octets de renderScene() sur une scène que le schéma sait exprimer", async () => {
    const scene: Scene = {
      schemaVersion: 1,
      canvas: { width: 400, height: 400, background: BG },
      layers: [{
        id: "s", name: "carré", visible: true, locked: false,
        frame: { x: 0, y: 0, w: 400, h: 400 },
        type: "shape", shape: "rect", fill: FILL, radius: 60,
      }],
    };
    const production = await renderScene({ scene, values: {} });
    const replica = await probe(sceneToElement(scene, new Map()), 400, 400);

    expect(production.mime).toBe("image/jpeg");
    expect(production.degraded).toBe(false);
    expect(replica.length).toBe(production.bytes.length);
    expect(Buffer.from(replica).equals(Buffer.from(production.bytes))).toBe(true);
  });
});

describe("sonde clipPath — mécanisme 1 : clipPath + polygon()", () => {
  // LA question. Le triangle occupe tout le canevas ; ses deux coins hauts sont EXCLUS par le
  // polygone. Points d'échantillonnage choisis loin de toute arête (≥ 30 px) pour qu'aucun
  // anticrénelage ni artefact JPEG ne puisse expliquer le résultat.
  it("découpe réellement un triangle : les coins hauts exclus sont du fond, le centre du remplissage", async () => {
    const px = await paint(400, 400, { clipPath: TRIANGLE });
    expect(px(20, 20)).toBe("fond");    // 5 % depuis le coin haut-gauche — arête du triangle à x=190
    expect(px(380, 20)).toBe("fond");   // symétrique haut-droit — arête à x=210
    expect(px(200, 200)).toBe("remplissage");
    expect(px(60, 390)).toBe("remplissage");  // bas-gauche : DANS le triangle
    expect(px(340, 390)).toBe("remplissage"); // bas-droit  : DANS le triangle
  });

  // ANTI-VACUITÉ, et c'est la garde qui compte le plus dans ce fichier : le test ci-dessus passerait
  // à l'identique si resvg peignait un triangle pour une raison sans rapport avec clipPath. Ici, le
  // MÊME nœud, le MÊME point, SANS la déclaration clipPath — et la classification s'inverse. C'est
  // la mutation du test précédent, exécutée en permanence plutôt que promise dans un commentaire.
  it("TÉMOIN : sans la déclaration clipPath, le même pixel de coin est du remplissage", async () => {
    const px = await paint(400, 400, {});
    expect(px(20, 20)).toBe("remplissage");
    expect(px(380, 20)).toBe("remplissage");
    expect(px(200, 200)).toBe("remplissage");
  });

  it("découpe aussi une étoile à cinq branches (polygone à 10 sommets)", async () => {
    const star = "polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)";
    const px = await paint(400, 400, { clipPath: star });
    expect(px(20, 20)).toBe("fond");            // coin — hors de toute branche
    expect(px(200, 200)).toBe("remplissage");   // cœur de l'étoile
    expect(px(200, 380)).toBe("fond");          // ENTRE les deux branches basses : le creux existe
  });

  it("découpe un remplissage en DÉGRADÉ aussi bien qu'un aplat", async () => {
    // shapeNode() peint un dégradé via backgroundImage et NON backgroundColor — deux chemins
    // distincts dans satori (rect.ts : `fills.push(url(#...))` contre `fills.push(color)`). Que le
    // premier soit découpé ne se déduit pas du second.
    const px = await sampler(await probe(canvasNode(400, 400, [{
      type: "div",
      props: { style: { position: "absolute", left: 0, top: 0, width: 400, height: 400, display: "flex",
        backgroundImage: `linear-gradient(90deg, ${FILL} 0%, ${FILL} 100%)`, clipPath: TRIANGLE } },
    }]), 400, 400));
    expect(px(20, 20)).toBe("fond");
    expect(px(200, 200)).toBe("remplissage");
    expect(px(60, 390)).toBe("remplissage");
  });
});

describe("sonde clipPath — RÉSERVE 1 : la géométrie percentuelle dépend de l'espacement de la chaîne", () => {
  // satori/src/parser/shape.ts, parsePolygon :
  //     points.split(',').map((v) => v.split(' ').map((k, i) =>
  //       lengthToNumber(k, …, i === 0 ? width : height, …)))
  // Un espace APRÈS une virgule fabrique un premier jeton VIDE dans le point suivant : l'abscisse
  // glisse alors à l'indice 1 et se résout contre la HAUTEUR du cadre au lieu de sa LARGEUR. Sur un
  // cadre CARRÉ l'erreur est invisible (largeur == hauteur) — c'est exactement pourquoi elle peut
  // traverser une revue. Sur 800x400 elle écrase la moitié droite du triangle, SANS lever.
  it("écrit avec des espaces après les virgules, le polygone est silencieusement déformé (cadre non carré)", async () => {
    const px = await paint(800, 400, { clipPath: "polygon(50% 0, 100% 100%, 0 100%)" });
    // (700,380) est DANS le triangle voulu (arête droite à x=780 pour y=380) — et pourtant :
    expect(px(700, 380)).toBe("fond");
    // Le découpage a bien eu lieu (ce n'est pas « clipPath ignoré ») : le centre-bas reste peint.
    expect(px(200, 300)).toBe("remplissage");
    expect(px(20, 20)).toBe("fond");
  });

  it("TÉMOIN : sans espace après les virgules, le MÊME polygone sur le MÊME cadre est correct", async () => {
    const px = await paint(800, 400, { clipPath: "polygon(50% 0,100% 100%,0 100%)" });
    expect(px(700, 380)).toBe("remplissage");
    expect(px(200, 300)).toBe("remplissage");
    expect(px(20, 20)).toBe("fond");
  });

  it("TÉMOIN : en unités absolues, l'espacement n'a plus d'importance", async () => {
    // Contournement alternatif : des px au lieu des %, puisque l'axe de référence ne sert alors plus.
    const px = await paint(800, 400, { clipPath: "polygon(400px 0px, 800px 400px, 0px 400px)" });
    expect(px(700, 380)).toBe("remplissage");
    expect(px(40, 20)).toBe("fond");
  });
});

describe("sonde clipPath — RÉSERVE 2 : transform ne fait PAS tourner le découpage", () => {
  // satori/src/builder/rect.ts : quand `style.transform` est présent, le rectangle de remplissage
  // reçoit `clip-path: undefined` et l'ensemble est enveloppé dans `<g clip-path="…">`. Le groupe
  // vit dans le repère du PARENT : le remplissage tourne, le masque NON. Une forme découpée à
  // laquelle un designer applique une rotation ne tourne donc pas — sans erreur, sans avertissement.
  it("un triangle découpé puis pivoté de 90° garde son sommet EN HAUT", async () => {
    const px = await paint(400, 400, { clipPath: TRIANGLE, transform: "rotate(90deg)" });
    expect(px(200, 30)).toBe("remplissage"); // sommet NON pivoté — toujours peint
    expect(px(380, 200)).toBe("fond");       // sommet ATTENDU après 90° — jamais peint
  });

  it("TÉMOIN : la sortie pivotée est identique à la sortie NON pivotée aux mêmes points", async () => {
    const px = await paint(400, 400, { clipPath: TRIANGLE });
    expect(px(200, 30)).toBe("remplissage");
    expect(px(380, 200)).toBe("fond");
  });

  it("TÉMOIN : la rotation elle-même FONCTIONNE — sur une forme non découpée elle déplace bien les pixels", async () => {
    // Sans ce témoin, la réserve ci-dessus serait indiscernable de « satori ignore transform ».
    // Carré 200x200 en (100,100) pivoté de 45° : le losange obtenu perd ses anciens coins et gagne
    // des pointes que le carré d'origine n'atteignait pas.
    const px = await sampler(await probe(canvasNode(400, 400, [boxNode(200, 200, { transform: "rotate(45deg)" }, 100, 100)]), 400, 400));
    expect(px(115, 115)).toBe("fond");          // ancien coin du carré : effacé par la rotation
    expect(px(200, 80)).toBe("remplissage");    // pointe du losange : hors du carré d'origine
    expect(px(200, 200)).toBe("remplissage");
  });

  it("CONTOURNEMENT : faire tourner les COORDONNÉES du polygone produit bien une forme pivotée", async () => {
    // Rotation de 90° horaire des sommets autour du centre : (x,y) -> (400-y, x).
    // (200,0)->(400,200) · (400,400)->(0,400) · (0,400)->(0,0)
    const px = await paint(400, 400, { clipPath: "polygon(400px 200px,0px 400px,0px 0px)" });
    expect(px(380, 200)).toBe("remplissage"); // le sommet est MAINTENANT à droite
    expect(px(200, 30)).toBe("fond");         // et n'est plus en haut
    expect(px(200, 200)).toBe("remplissage");
  });
});

describe("sonde clipPath — RÉSERVE 3 : la bordure échappe au découpage", () => {
  const BORDER = {
    borderTop: `20px solid ${STROKE}`, borderRight: `20px solid ${STROKE}`,
    borderBottom: `20px solid ${STROKE}`, borderLeft: `20px solid ${STROKE}`,
  };
  // satori/src/builder/rect.ts dessine la bordure avec `clip-path: url(#rectClipId)` — le masque de
  // BORDURE, jamais `currentClipPath`. Le contour reste donc RECTANGULAIRE alors que le
  // remplissage, lui, est triangulaire.
  it("un triangle découpé bordé garde un contour rectangulaire complet", async () => {
    const px = await sampler(await probe(canvasNode(400, 400, [boxNode(400, 400, { clipPath: TRIANGLE, ...BORDER })]), 400, 400));
    expect(px(8, 8)).toBe("bordure");     // coin haut-gauche : EXCLU par le polygone, peint quand même
    expect(px(200, 8)).toBe("bordure");
    expect(px(200, 200)).toBe("remplissage");
    // Seul le TRAIT échappe : l'intérieur exclu par le polygone reste bien du fond.
    expect(px(60, 40)).toBe("fond");
  });

  it("TÉMOIN : sans bordure, ce même coin exclu est du fond", async () => {
    const px = await paint(400, 400, { clipPath: TRIANGLE });
    expect(px(8, 8)).toBe("fond");
    expect(px(60, 40)).toBe("fond");
  });
});

describe("sonde clipPath — composition avec borderRadius : intersection, sans surprise", () => {
  // Triangle rectangle, angle droit en bas à gauche : `polygon(0 0,100% 100%,0 100%)`.
  // P1 = (30,370) : DANS le triangle, HORS du rectangle arrondi (r=150).
  // P2 = (350,60) : HORS du triangle, DANS le rectangle arrondi.
  // P3 = (100,300) : dans les deux — ancre « quelque chose est bien peint ».
  const RT = "polygon(0 0,100% 100%,0 100%)";

  it("clipPath seul : P1 peint, P2 non", async () => {
    const px = await paint(400, 400, { clipPath: RT });
    expect(px(30, 370)).toBe("remplissage");
    expect(px(350, 60)).toBe("fond");
    expect(px(100, 300)).toBe("remplissage");
  });

  it("borderRadius seul : P1 non peint, P2 peint — l'inverse exact", async () => {
    const px = await paint(400, 400, { borderRadius: 150 });
    expect(px(30, 370)).toBe("fond");
    expect(px(350, 60)).toBe("remplissage");
    expect(px(100, 300)).toBe("remplissage");
  });

  it("les deux ensemble : ni P1 ni P2 — c'est bien l'INTERSECTION, pas l'un qui écrase l'autre", async () => {
    const px = await paint(400, 400, { clipPath: RT, borderRadius: 150 });
    expect(px(30, 370)).toBe("fond");
    expect(px(350, 60)).toBe("fond");
    expect(px(100, 300)).toBe("remplissage");
  });
});

describe("sonde clipPath — mécanisme 2 : borderRadius « 50 % » comme ellipse", () => {
  it("produit une VRAIE ellipse sur un cadre non carré", async () => {
    const px = await paint(800, 400, { borderRadius: "50%" });
    // Ellipse cx=400 cy=200 rx=400 ry=200. (100,60) : (300/400)² + (140/200)² = 1,05 > 1 -> DEHORS.
    //                                       (150,80) : (250/400)² + (120/200)² = 0,75 < 1 -> DEDANS.
    // Ces deux points ne sont séparés par AUCUNE autre géométrie : seule une ellipse les distingue.
    expect(px(100, 60)).toBe("fond");
    expect(px(150, 80)).toBe("remplissage");
    expect(px(5, 5)).toBe("fond");
    expect(px(400, 200)).toBe("remplissage");
  });

  it("TÉMOIN : sans borderRadius, ces deux points sont tous deux du remplissage", async () => {
    const px = await paint(800, 400, {});
    expect(px(100, 60)).toBe("remplissage");
    expect(px(150, 80)).toBe("remplissage");
    expect(px(5, 5)).toBe("remplissage");
  });

  it("RÉSERVE : un `radius` NUMÉRIQUE ne peut pas produire une ellipse sur un cadre non carré", async () => {
    // Le champ `radius` de ShapeLayer est un `z.number()` — donc des px. Sur 800x400, le plus grand
    // rayon utile (200) donne un STADE (deux demi-cercles + un rectangle), pas une ellipse : le
    // point (100,60), hors de l'ellipse, est ici peint. C'est mesuré à travers renderScene(), donc
    // c'est le comportement du chemin de PRODUCTION tel qu'il existe aujourd'hui : la Tâche 3 devra
    // faire porter la chaîne « 50% » par le modèle, un nombre ne suffit pas.
    const scene: Scene = {
      schemaVersion: 1,
      canvas: { width: 800, height: 400, background: BG },
      layers: [{
        id: "s", name: "stade", visible: true, locked: false,
        frame: { x: 0, y: 0, w: 800, h: 400 },
        type: "shape", shape: "rect", fill: FILL, radius: 200,
      }],
    };
    const px = await sampler((await renderScene({ scene, values: {} })).bytes);
    expect(px(100, 60)).toBe("remplissage"); // une ellipse aurait donné « fond » (test ci-dessus)
    expect(px(400, 5)).toBe("remplissage");  // et le milieu du bord haut est plat : c'est un stade
  });
});

describe("sonde clipPath — mécanisme 3 : nœud <svg> en ligne", () => {
  it("satori accepte un <svg> enfant et resvg en rasterise le polygone", async () => {
    // satori sérialise le sous-arbre SVG en `data:image/svg+xml` porté par un `<image>` — le même
    // chemin, déjà éprouvé dans ce dépôt, que le QR code de render.ts. Le polygone n'apparaît donc
    // PAS tel quel dans le SVG de sortie : seuls les pixels peuvent le confirmer.
    const svgNode: SatoriNode = {
      type: "svg",
      props: {
        width: 400, height: 400, viewBox: "0 0 400 400", xmlns: "http://www.w3.org/2000/svg",
        children: { type: "polygon", props: { points: "200,0 400,400 0,400", fill: FILL } },
      },
    };
    const px = await sampler(await probe(canvasNode(400, 400, [{
      type: "div",
      props: { style: { position: "absolute", left: 0, top: 0, width: 400, height: 400, display: "flex" }, children: svgNode },
    }]), 400, 400));
    expect(px(20, 20)).toBe("fond");
    expect(px(380, 20)).toBe("fond");
    expect(px(200, 200)).toBe("remplissage");
    expect(px(60, 390)).toBe("remplissage");
  });
});

describe("sonde clipPath — mécanisme 4 : div pivoté (ligne / diagonale), de bout en bout", () => {
  it("renderScene() peint une diagonale à partir d'un rectangle fin pivoté", async () => {
    // Contrairement à clipPath, la rotation EST exprimable par le schéma actuel (`layer.rotation`) :
    // ce mécanisme-ci est donc mesuré à travers le VRAI point d'entrée de production.
    const scene: Scene = {
      schemaVersion: 1,
      canvas: { width: 400, height: 400, background: BG },
      layers: [{
        id: "l", name: "ligne", visible: true, locked: false,
        frame: { x: 50, y: 196, w: 300, h: 8 }, rotation: 45,
        type: "shape", shape: "rect", fill: FILL,
      }],
    };
    const px = await sampler((await renderScene({ scene, values: {} })).bytes);
    expect(px(140, 140)).toBe("remplissage"); // sur la diagonale
    expect(px(260, 260)).toBe("remplissage"); // sur la diagonale, à l'autre bout
    expect(px(140, 260)).toBe("fond");        // de part et d'autre : rien
    expect(px(260, 140)).toBe("fond");
  });

  it("TÉMOIN : sans rotation, le même calque est horizontal — la diagonale n'existe pas", async () => {
    const scene: Scene = {
      schemaVersion: 1,
      canvas: { width: 400, height: 400, background: BG },
      layers: [{
        id: "l", name: "ligne", visible: true, locked: false,
        frame: { x: 50, y: 196, w: 300, h: 8 },
        type: "shape", shape: "rect", fill: FILL,
      }],
    };
    const px = await sampler((await renderScene({ scene, values: {} })).bytes);
    expect(px(140, 140)).toBe("fond");
    expect(px(260, 260)).toBe("fond");
    expect(px(200, 200)).toBe("remplissage"); // la barre horizontale, elle, est bien là
  });
});
