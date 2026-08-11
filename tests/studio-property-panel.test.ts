import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Scene, Layer } from "@/lib/studio/scene";
import type { AssetRow } from "@/lib/queries/assets";
import { PropertyPanel } from "@/components/studio/property-panel";
// Tâche 6 (U1, spec §6) — même précédent que studio-marque-panel.test.ts / studio-texte-panel.test.ts
// / studio-elements-panel.test.ts / studio-mode-switch.test.ts : on affirme contre une valeur
// IMPORTÉE plutôt qu'une chaîne re-dérivée à la main.
import { DEFAULT_PREFS } from "@/lib/studio/editor-prefs";
// Tâche 4 (U2) : la liste CANONIQUE des six modes, importée plutôt que recopiée — même précédent que
// SHAPE_KINDS pour shape-gallery (une garde de complétude qui compare deux copies manuscrites peut
// dériver sans que rien ne le remarque, revue U1 Tâche 4, Important 1).
import { ALIGN_MODES } from "@/lib/studio/align";

// Même convention que tests/studio-layer-panel.test.ts : pas de DOM sous `bun test`, donc un rendu
// STRUCTUREL (react-dom/server) plutôt qu'une simulation de clic/frappe — la logique de mutation
// (setLayerProp via le vrai réducteur) est déjà couverte indépendamment par
// tests/studio-token-picker.test.ts. Ce fichier vérifie que le panneau construit bien le BON
// formulaire pour CHAQUE type de calque de l'union Layer (Tâche 8), sans planter, et qu'il respecte
// la règle de filtrage des jetons même dans les champs qui ne passent pas par TokenPicker (le
// sélecteur d'emplacement image/QR construit sa propre liste d'options).

function scene(layers: Layer[]): Scene {
  return { schemaVersion: 1, canvas: { width: 1200, height: 675, background: "#0B0B0B" }, layers };
}

const textLayer: Layer = {
  id: "t", name: "Titre", visible: true, locked: false,
  frame: { x: 10, y: 10, w: 400, h: 100 }, rotation: 5, opacity: 0.9,
  type: "text", content: "Bonjour {{article.title}}",
  font: { family: "Noto Sans", size: 40, weight: 700, italic: true },
  color: "#FFFFFF", align: "center", vAlign: "middle", lineHeight: 1.3,
  letterSpacing: 2, maxLines: 2, autoFit: true,
  shadow: { x: 1, y: 2, blur: 3, color: "#000000" },
  stroke: { width: 1, color: "#FF0000" },
};

const imageLayer: Layer = {
  id: "i", name: "Image", visible: true, locked: false,
  frame: { x: 0, y: 0, w: 300, h: 200 },
  type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover",
  radius: 8, blur: 4, overlay: "#00000080",
};

const shapeLayerSolid: Layer = {
  id: "s1", name: "Fond", visible: true, locked: false,
  frame: { x: 0, y: 0, w: 300, h: 200 },
  type: "shape", shape: "rect", fill: "#123456", radius: 4,
  border: { width: 2, color: "#FFFFFF", sides: ["top", "left"] },
};

const shapeLayerGradient: Layer = {
  id: "s2", name: "Dégradé", visible: true, locked: false,
  frame: { x: 0, y: 0, w: 300, h: 200 },
  type: "shape", shape: "rect",
  fill: { angle: 45, stops: [{ color: "#000000", at: 0 }, { color: "#FFFFFF", at: 1 }] },
};

const qrLayer: Layer = {
  id: "q", name: "QR", visible: true, locked: false,
  frame: { x: 0, y: 0, w: 120, h: 120 },
  type: "qr", slot: "article.url", fg: "#000000", bg: "#FFFFFF", margin: 4,
};

// Tâche 3 (U2) : le composant reçoit désormais `selectedIds: string[]`. Ce scaffolding garde son
// paramètre `selectedId: string | null` — le cas d'UNE seule sélection, celui que la trentaine
// d'appels ci-dessous exerce — et le traduit ici. `renderMulti` ci-dessous couvre l'autre cas.
function render(
  layers: Layer[], selectedId: string | null, context: Parameters<typeof PropertyPanel>[0]["context"],
  assets: AssetRow[] = [], sectionsOpen: Record<string, boolean> = DEFAULT_PREFS.sectionsOpen,
) {
  return renderMulti(layers, selectedId === null ? [] : [selectedId], context, assets, sectionsOpen);
}

function renderMulti(
  layers: Layer[], selectedIds: string[], context: Parameters<typeof PropertyPanel>[0]["context"],
  assets: AssetRow[] = [], sectionsOpen: Record<string, boolean> = DEFAULT_PREFS.sectionsOpen,
) {
  const noop = () => {};
  return renderToStaticMarkup(
    React.createElement(PropertyPanel, {
      scene: scene(layers), selectedIds, context, dispatch: noop, assets,
      sectionsOpen, onSectionsOpenChange: noop,
    }),
  );
}

// Localise la balise ouvrante d'un `data-testid` donné, sans dépendre d'un texte affiché à côté
// (ex. "Police") qui bougerait si un libellé changeait un jour.
function openingTag(html: string, attr: string, value: string): string {
  const match = new RegExp(`<[a-z]+[^>]*${attr}="${value}"[^>]*>`).exec(html);
  if (!match) throw new Error(`balise introuvable dans le HTML rendu : ${attr}="${value}"`);
  return match[0];
}

// Tâche 6 : `TypeSection` (property-panel.tsx) pose `data-section={sectionId}` sur le `Collapsible`
// racine — Base UI y ajoute lui-même `data-open`/`data-closed` selon l'état courant (jamais les deux
// à la fois, voir node_modules/@base-ui/react/utils/collapsibleOpenStateMapping.js) ; on lit CET
// attribut plutôt que de chercher les champs enfants dans le HTML, qui — Collapsible.Panel garde son
// défaut `keepMounted={false}` — DISPARAISSENT du DOM sérialisé quand la section est fermée (voir le
// dernier test de ce bloc, qui exploite justement cette disparition/réapparition).
//
// `\sdata-open(=|\s|\/|>)` plutôt qu'un `.includes("data-open")` naïf : la leçon des tâches
// précédentes sur `disabled:` dans une classe Tailwind s'applique de la même façon ici — un nom de
// classe ou un autre attribut pourrait contenir la sous-chaîne "data-open" sans être CET attribut.
function sectionIsOpen(html: string, sectionId: string): boolean {
  const tag = openingTag(html, "data-section", sectionId);
  return /\sdata-open(=|\s|\/|>)/.test(tag);
}

const imageAsset: AssetRow = {
  id: "asset-1", kind: "image", name: "Logo", url: "https://exemple.com/logo.png",
  mime: "image/png", bytes: 1024, width: 200, height: 200,
  fontFamily: null, fontWeight: null, fontStyle: null, uploadedByName: null, createdAt: new Date(),
};

describe("PropertyPanel — état vide", () => {
  it("invite à sélectionner un calque quand rien n'est sélectionné", () => {
    const html = render([textLayer], null, "social_post");
    expect(html).toContain('data-testid="property-panel-empty"');
    expect(html).not.toContain('data-testid="property-panel"');
  });

  it("invite aussi à sélectionner un calque si l'id sélectionné n'existe plus dans la scène", () => {
    const html = render([textLayer], "inexistant", "social_post");
    expect(html).toContain('data-testid="property-panel-empty"');
  });
});

// ── Tâche 3 (U2, spec §3) — « les sections par type UNIQUEMENT pour une sélection simple, et un
// message honnête en français pour une sélection multiple » ─────────────────────────────────────
describe("PropertyPanel — sélection multiple", () => {
  it("n'affiche AUCUNE section par type, ni la bande de géométrie, pour deux calques sélectionnés", () => {
    const html = renderMulti([textLayer, imageLayer], ["t", "i"], "social_post");
    expect(html).toContain('data-testid="property-panel-multi"');
    // Les trois surfaces mono-calque doivent TOUTES être absentes : `property-sections` (les
    // sections par type), la bande de géométrie (elle édite UN cadre) et l'état vide (une sélection
    // multiple n'est pas « rien de sélectionné »).
    expect(html).not.toContain('data-testid="property-sections"');
    expect(html).not.toContain('data-testid="geometry-strip"');
    expect(html).not.toContain('data-testid="property-panel-empty"');
    // Et aucun champ propre au type texte ne fuit (le calque "t" est le PREMIER de selectedIds : un
    // composant resté sur `selectedIds[0]` afficherait bien ses champs et échouerait ici).
    expect(html).not.toContain("Ajustement auto");
  });

  it("dit combien de calques sont sélectionnés, en français", () => {
    const two = renderMulti([textLayer, imageLayer], ["t", "i"], "social_post");
    expect(two).toContain("2 calques sélectionnés");

    // Trois : le compte vient bien de la sélection, ce n'est pas une phrase figée.
    const three = renderMulti([textLayer, imageLayer, qrLayer], ["t", "i", "q"], "social_post");
    expect(three).toContain("3 calques sélectionnés");
    expect(three).not.toContain("2 calques sélectionnés");
  });

  it("revenir à UNE seule sélection rend de nouveau les sections par type", () => {
    // La contre-épreuve du premier test : sans elle, un composant qui n'afficherait JAMAIS de
    // sections passerait tout le describe ci-dessus.
    const html = renderMulti([textLayer, imageLayer], ["t"], "social_post");
    expect(html).toContain('data-testid="property-sections"');
    expect(html).not.toContain('data-testid="property-panel-multi"');
    expect(html).toContain("Ajustement auto");
  });
});

// ── Tâche 4 (U2, spec §4) — la rangée aligner/répartir ───────────────────────────────────────────
// Elle vit dans geometry-strip.tsx (la place que U1 lui avait laissée) et apparaît DEUX fois : comme
// troisième rangée de la bande de géométrie pour une sélection simple, et seule au-dessus du message
// honnête pour une sélection multiple — le seul endroit du panneau qui ait un sens à plus d'un calque.
describe("PropertyPanel — rangée aligner/répartir (Tâche 4)", () => {
  // `attrOn` isole la balise ouvrante d'un bouton avant de chercher un attribut : un
  // `html.includes("disabled")` global serait vrai dès qu'UN SEUL bouton de la page est désactivé, et
  // `disabled:opacity-50` figure de toute façon dans la classe Tailwind de chaque bouton (le piège
  // déjà rencontré par tests/studio-interactions.test.ts sur le sélecteur d'assets).
  function isDisabled(html: string, action: string): boolean {
    return /\sdisabled(=|\s|\/|>)/.test(openingTag(html, "data-action", action));
  }

  const lockedLayer: Layer = {
    id: "lk", name: "Verrouillé", visible: true, locked: true,
    frame: { x: 0, y: 0, w: 50, h: 50 },
    type: "shape", shape: "rect", fill: "#FFFFFF",
  };
  // Trois formes non pivotées, à des x différents — de quoi rendre la répartition légale (>= 3).
  const trio: Layer[] = [0, 1, 2].map((i) => ({
    id: `p${i}`, name: `Forme ${i}`, visible: true, locked: false,
    frame: { x: i * 100, y: 0, w: 40, h: 40 },
    type: "shape", shape: "rect", fill: "#CCCCCC",
  }));

  it("est présente pour une sélection MULTIPLE, à côté du message honnête et sans la bande de géométrie", () => {
    const html = renderMulti([textLayer, imageLayer], ["t", "i"], "social_post");
    expect(html).toContain('data-testid="align-row"');
    expect(html).toContain('data-testid="property-panel-multi"');
    expect(html).not.toContain('data-testid="geometry-strip"');
  });

  it("est présente pour une sélection SIMPLE, DANS la bande de géométrie et avant le conteneur défilant", () => {
    const html = render([imageLayer], "i", "article_image");
    const stripIdx = html.indexOf('data-testid="geometry-strip"');
    const rowIdx = html.indexOf('data-testid="align-row"');
    const scrollIdx = html.indexOf('data-testid="property-sections"');
    expect(stripIdx).toBeGreaterThan(-1);
    expect(rowIdx).toBeGreaterThan(stripIdx); // descendante de la bande, jamais un frère placé avant
    expect(rowIdx).toBeLessThan(scrollIdx); // et toujours hors du conteneur défilant
  });

  it("est absente quand RIEN n'est sélectionné — il n'y a rien à aligner", () => {
    expect(render([textLayer], null, "social_post")).not.toContain('data-testid="align-row"');
  });

  it("porte un bouton pour CHACUN des six modes de la liste canonique, plus les deux répartitions", () => {
    const html = renderMulti(trio, ["p0", "p1", "p2"], "social_post");
    for (const mode of ALIGN_MODES) {
      expect(html).toContain(`data-action="align-${mode}"`);
    }
    expect(html).toContain('data-action="distribute-horizontal"');
    expect(html).toContain('data-action="distribute-vertical"');
  });

  it("les deux boutons de répartition sont DÉSACTIVÉS en dessous de trois participants, et actifs à trois", () => {
    const one = render([trio[0]], "p0", "social_post");
    const two = renderMulti(trio, ["p0", "p1"], "social_post");
    const three = renderMulti(trio, ["p0", "p1", "p2"], "social_post");
    // TROIS calques sélectionnés dont un VERROUILLÉ ne font que DEUX participants : le seuil se compte
    // en participants, pas en `selectedIds.length`. Sans ce cas, un seuil écrit sur la longueur de la
    // sélection passerait les trois autres.
    const threeWithLocked = renderMulti([...trio, lockedLayer], ["p0", "p1", "lk"], "social_post");
    for (const action of ["distribute-horizontal", "distribute-vertical"]) {
      expect(isDisabled(one, action)).toBe(true);
      expect(isDisabled(two, action)).toBe(true);
      expect(isDisabled(threeWithLocked, action)).toBe(true);
      // La contre-épreuve : sans elle, des boutons désactivés en PERMANENCE passeraient les deux
      // premières assertions.
      expect(isDisabled(three, action)).toBe(false);
    }
  });

  it("les six boutons d'alignement restent ACTIFS pour une sélection simple — c'est le plan de travail qui sert de référence", () => {
    const html = render([trio[0]], "p0", "social_post");
    for (const mode of ALIGN_MODES) expect(isDisabled(html, `align-${mode}`)).toBe(false);
  });

  it("tout est DÉSACTIVÉ quand le seul calque sélectionné est VERROUILLÉ (aucun participant)", () => {
    const html = render([lockedLayer], "lk", "social_post");
    for (const mode of ALIGN_MODES) expect(isDisabled(html, `align-${mode}`)).toBe(true);
    expect(isDisabled(html, "distribute-horizontal")).toBe(true);
  });

  it("l'infobulle nomme la RÉFÉRENCE, et ce n'est pas la même à un calque qu'à plusieurs", () => {
    const single = openingTag(render([trio[0]], "p0", "social_post"), "data-action", "align-left");
    expect(single).toContain("plan de travail");

    const multi = openingTag(renderMulti(trio, ["p0", "p1"], "social_post"), "data-action", "align-left");
    expect(multi).toContain("sélection");
    expect(multi).not.toContain("plan de travail");
  });

  it("prévient que la ROTATION est ignorée — mais seulement quand un participant est réellement pivoté", () => {
    // textLayer porte `rotation: 5` ; imageLayer n'a pas de rotation. La note n'apparaît donc que là
    // où elle apprend quelque chose, plutôt que d'être un avertissement permanent que personne ne lit.
    const rotated = render([textLayer], "t", "social_post");
    expect(rotated).toContain('data-testid="align-rotation-note"');
    const straight = render([imageLayer], "i", "article_image");
    expect(straight).not.toContain('data-testid="align-rotation-note"');
  });

  // ── Tâche 5 (U2) : la même discipline pour la LIMITE D'ACCROCHAGE d'un calque pivoté ────────────
  it("prévient qu'un calque PIVOTÉ s'accroche différemment — et seulement s'il l'est vraiment", () => {
    // La revue de la Tâche 5 a tranché : la limite ne doit pas mourir en silence (la Tâche 4 avait
    // établi le précédent avec sa note de rotation ci-dessus). Deux moitiés à dire honnêtement, et le
    // test exige les deux dans le texte rendu : l'accrochage est DÉSACTIVÉ pendant un
    // redimensionnement, et pendant un DÉPLACEMENT les guides marquent le cadre non pivoté, pas le
    // contour visible à l'écran.
    const rotated = render([textLayer], "t", "social_post"); // rotation: 5
    expect(rotated).toContain('data-testid="snap-rotation-note"');
    expect(rotated).toContain("redimensionnement");
    expect(rotated).toContain("contour visible");
    // Contre-épreuve : sans rotation, aucune note — sinon un avertissement permanent que personne ne lit.
    const straight = render([imageLayer], "i", "article_image");
    expect(straight).not.toContain('data-testid="snap-rotation-note"');
  });
});

describe("PropertyPanel — calque texte", () => {
  it("rend sans planter et reflète les valeurs du calque", () => {
    const html = render([textLayer], "t", "social_post");
    expect(html).toContain('data-testid="property-panel"');
    expect(html).toContain("Bonjour {{article.title}}");
    expect(html).toContain('value="40"'); // taille de police
    expect(html).toContain('value="10"'); // frame.x
    expect(html).toContain('value="0.9"'); // opacité
    // Ombre et contour sont activés sur ce calque : leurs champs détaillés doivent apparaître.
    expect(html).toContain("Épaisseur");
    expect(html).toContain("Ajustement auto");
  });

  it("le bouton d'insertion de jeton du champ CONTENU n'est présent que si le contexte offre des jetons texte", () => {
    const withTokens = render([textLayer], "t", "social_post");
    expect(withTokens).toContain('data-kind="text"');
  });

  // Repéré en vérifiant l'écran réel dans un navigateur (bun test seul ne l'aurait jamais détecté,
  // renderToStaticMarkup exécute pourtant la même fonction de rendu que le vrai navigateur ici) :
  // Base UI <SelectValue> n'affiche PAS automatiquement le libellé du <SelectItem> sélectionné —
  // sans mappeur explicite, le sélecteur affichait sa valeur technique brute ("left", "bottom",
  // "700") au lieu du libellé français ("Gauche", "Bas", "700 — Gras").
  it("les sélecteurs affichent le LIBELLÉ FRANÇAIS choisi, jamais la valeur technique brute", () => {
    const html = render([textLayer], "t", "social_post"); // align: "center", vAlign: "middle", weight: 700
    expect(html).toContain("Centre");
    expect(html).toContain("Milieu");
    expect(html).toContain("700 — Gras");
    // Négatif : la valeur technique nue ne doit apparaître nulle part comme texte affiché (elle
    // peut légitimement apparaître dans un attribut value="…" d'un <option>, ce que ce test ne
    // cible pas — il cible le TEXTE affiché par SelectValue, capturé ci-dessus).
    expect(html).not.toContain(">center<");
    expect(html).not.toContain(">middle<");
  });
});

describe("PropertyPanel — calque image", () => {
  it("rend les trois onglets de source et le sélecteur d'emplacement pour un source.kind=slot", () => {
    const html = render([imageLayer], "i", "article_image");
    expect(html).toContain('data-action="image-source-slot"');
    expect(html).toContain('data-action="image-source-url"');
    expect(html).toContain('data-action="image-source-asset"');
  });

  it("le sélecteur d'emplacement d'un contexte article_image ne propose JAMAIS article.url (jeton de type url, pas image)", () => {
    // Reproduit la même garantie que tests/studio-token-picker.test.ts, mais ici pour un chemin
    // de code DIFFÉRENT (le <Select> d'emplacement image, pas le composant TokenPicker) — un
    // sabotage qui construirait ce <Select> à partir de TOUS les TOKEN_IDS plutôt que de
        // tokensFor(context, "image") passerait le test du token-picker mais échouerait ICI.
    const html = render([imageLayer], "i", "article_image");
    expect(html).not.toContain("article.url");
  });

  // Revue finale V2, Minor 4 : l'onglet "Bibliothèque" servait auparavant un identifiant
  // délibérément introuvable ("bibliotheque-vide") comme repli quand la bibliothèque d'assets était
  // vide — une valeur AUTOSAUVEGARDABLE et PUBLIABLE (validateScene est pure, elle ne résout aucun
  // asset), donc un gabarit pouvait atteindre *publié* dans un état où tout rendu échouait. Le
  // correctif désactive l'onglet plutôt que de fabriquer un identifiant : ces deux tests couvrent
  // les deux bornes.
  it("bibliothèque vide : l'onglet « Bibliothèque » est désactivé, jamais l'identifiant de repli introuvable", () => {
    const html = render([imageLayer], "i", "article_image", []);
    const tab = /<button[^>]*data-action="image-source-asset"[^>]*>/.exec(html);
    expect(tab).not.toBeNull();
    // `disabled=""` PRÉCISÉMENT (React SSR sérialise l'attribut booléen ainsi) — pas un simple
    // `.toContain("disabled")`, qui matcherait aussi les classes utilitaires "disabled:…" et
    // l'attribut `aria-disabled="false"` toujours présents sur ce bouton, désactivé ou non.
    expect(tab![0]).toContain('disabled=""');
    expect(html).not.toContain("bibliotheque-vide");
  });

  it("bibliothèque non vide : l'onglet « Bibliothèque » reste actionnable", () => {
    const html = render([imageLayer], "i", "article_image", [imageAsset]);
    const tab = /<button[^>]*data-action="image-source-asset"[^>]*>/.exec(html);
    expect(tab).not.toBeNull();
    expect(tab![0]).not.toContain('disabled=""');
  });
});

describe("PropertyPanel — calque forme", () => {
  it("remplissage uni : affiche un champ couleur, pas l'éditeur de dégradé", () => {
    const html = render([shapeLayerSolid], "s1", "recap_card");
    expect(html).toContain('value="#123456"');
    expect(html).not.toContain("Ajouter une étape");
  });

  it("remplissage dégradé : affiche l'éditeur de dégradé avec ses étapes", () => {
    const html = render([shapeLayerGradient], "s2", "recap_card");
    expect(html).toContain("Ajouter une étape");
    expect(html).toContain('value="45"'); // angle
  });

  it("bordure activée : reflète l'épaisseur, la couleur et les côtés cochés", () => {
    const html = render([shapeLayerSolid], "s1", "recap_card");
    expect(html).toContain('value="2"'); // épaisseur bordure
    expect(html).toContain('value="#FFFFFF"'); // couleur bordure
  });
});

describe("PropertyPanel — calque QR", () => {
  it("rend les champs slot/fg/bg/margin", () => {
    const html = render([qrLayer], "q", "social_post");
    expect(html).toContain('value="#000000"');
    expect(html).toContain('value="#FFFFFF"');
    expect(html).toContain('value="4"');
  });

  it("un contexte sans aucun jeton URL (recap_card) affiche un message plutôt qu'un sélecteur vide trompeur", () => {
    const html = render([qrLayer], "q", "recap_card");
    expect(html).toContain("Aucun jeton URL disponible");
  });
});

// Tâche 6 (U1, spec §6) : la bande de géométrie épinglée (X, Y, largeur, hauteur, rotation, opacité,
// extraites de l'ex-section « Cadre » qui fermait la liste — le défaut que corrige cette tâche) et
// les sections de type restantes, désormais repliables et mémorisées PAR TYPE de calque.
describe("PropertyPanel — bande de géométrie épinglée (Tâche 6)", () => {
  it("la bande de géométrie est un FRÈRE placé AVANT le conteneur défilant, jamais un descendant", () => {
    const html = render([textLayer], "t", "social_post");
    const stripIdx = html.indexOf('data-testid="geometry-strip"');
    const scrollIdx = html.indexOf('data-testid="property-sections"');
    expect(stripIdx).toBeGreaterThan(-1);
    expect(scrollIdx).toBeGreaterThan(-1);
    // Le HTML sérialisé place tout DESCENDANT après la balise ouvrante de son parent : si la bande
    // apparaît avant même que le conteneur défilant s'ouvre, elle ne peut structurellement PAS en
    // être un descendant — c'est la preuve réelle, plus forte que "apparaît avant le mot 'Police'"
    // (qui passerait même si la bande était le PREMIER enfant du conteneur défilant, donc soumise au
    // même `overflow-auto` que tout le reste).
    expect(stripIdx).toBeLessThan(scrollIdx);
    // Et seul le conteneur défilant porte la classe qui active le défilement — pas la bande : sans
    // cette assertion, un conteneur défilant SANS `overflow-auto` du tout passerait quand même la
    // comparaison de position ci-dessus.
    const stripTag = openingTag(html, "data-testid", "geometry-strip");
    const scrollTag = openingTag(html, "data-testid", "property-sections");
    expect(stripTag).not.toContain("overflow-auto");
    expect(scrollTag).toContain("overflow-auto");
  });

  // Correctif revue finale (Minor) : ce titre affirmait « quel que soit le type de calque » mais ne
  // rendait QUE textLayer — les trois autres fixtures de ce fichier (imageLayer, shapeLayerSolid,
  // qrLayer) n'étaient jamais exercées ici, alors que GeometryStrip (geometry-strip.tsx) est monté
  // pour LES QUATRE (elle ne lit que `layer.frame`/`layer.rotation`/`layer.opacity`, communs à
  // l'union Layer entière — rien de spécifique au texte). La boucle rend le titre vrai.
  it("la bande de géométrie porte les six champs de cadre, quel que soit le type de calque", () => {
    const fixtures: [Layer, string, Parameters<typeof PropertyPanel>[0]["context"]][] = [
      [textLayer, "t", "social_post"],
      [imageLayer, "i", "article_image"],
      [shapeLayerSolid, "s1", "recap_card"],
      [qrLayer, "q", "social_post"],
    ];
    for (const [layer, id, context] of fixtures) {
      const html = render([layer], id, context);
      for (const f of ["frame.x", "frame.y", "frame.w", "frame.h", "rotation", "opacity"]) {
        expect(html).toContain(`data-field="${f}"`);
      }
    }
  });

  it("les six champs de la bande ne sont plus dupliqués dans une section « Cadre »", () => {
    const html = render([textLayer], "t", "social_post");
    // L'ex-section « Cadre » (Tâche 8) a disparu du panneau — ses six champs vivent UNIQUEMENT dans
    // la bande épinglée, jamais recopiés dans une section repliable qui referait doublon.
    expect(html).not.toContain('data-section="cadre"');
  });
});

describe("PropertyPanel — sections repliables, mémorisées par type de calque (Tâche 6)", () => {
  it("une section jamais explicitement repliée reste OUVERTE par défaut", () => {
    const html = render([textLayer], "t", "social_post", [], DEFAULT_PREFS.sectionsOpen);
    for (const id of ["texte", "police", "apparence", "ombre", "contour"]) {
      expect(sectionIsOpen(html, id)).toBe(true);
    }
  });

  it("repli explicite d'une section sur un type : n'affecte pas la section HOMONYME d'un AUTRE type", () => {
    // "Apparence" existe pour TEXTE et IMAGE sous le même libellé — le cas exact que la namespacing
    // doit couvrir : sans préfixe de type, replier l'une replierait l'autre.
    const sectionsOpen = { "text.apparence": false };
    const textHtml = render([textLayer], "t", "social_post", [], sectionsOpen);
    const imageHtml = render([imageLayer], "i", "article_image", [], sectionsOpen);
    expect(sectionIsOpen(textHtml, "apparence")).toBe(false);
    expect(sectionIsOpen(imageHtml, "apparence")).toBe(true);
  });

  it("repli explicite d'une section sur un type : n'affecte pas une section de nom DIFFÉRENT sur un AUTRE type (cas du brief)", () => {
    const sectionsOpen = { "text.ombre": false };
    const textHtml = render([textLayer], "t", "social_post", [], sectionsOpen);
    expect(sectionIsOpen(textHtml, "ombre")).toBe(false);
    // Un calque forme n'a pas de section "ombre" du tout ; sa section "bordure" à elle, jamais visée
    // par ces prefs, doit rester ouverte — la clé plate "ombre" ne doit influencer AUCUNE section
    // d'un type qui ne la porte même pas.
    const shapeHtml = render([shapeLayerSolid], "s1", "recap_card", [], sectionsOpen);
    expect(sectionIsOpen(shapeHtml, "bordure")).toBe(true);
  });

  it("replier une section n'appelle JAMAIS dispatch — c'est un changement d'affichage pur, jamais une mutation de calque", () => {
    // Remplace la prémisse du brief (`collapseSection(before, "ombre")` appliqué à un Layer brut,
    // puis `after.shadow`) : aucune fonction de ce type n'existe ni ne doit exister — replier une
    // section ne produit JAMAIS de calque transformé, seulement un nouvel état `sectionsOpen`. La
    // preuve directe est qu'aucun rendu, quel que soit l'état replié/déplié fourni, n'appelle
    // `dispatch` (le seul chemin par lequel une scène pourrait changer dans ce composant).
    const calls: unknown[] = [];
    renderToStaticMarkup(
      React.createElement(PropertyPanel, {
        scene: scene([textLayer]), selectedIds: ["t"], context: "social_post", assets: [],
        dispatch: (a: unknown) => { calls.push(a); },
        sectionsOpen: { "text.ombre": false },
        onSectionsOpenChange: () => {},
      }),
    );
    expect(calls).toHaveLength(0);
  });

  it("fermer puis rouvrir une section ne perd aucune valeur : elles vivent dans la scène, jamais dans sectionsOpen", () => {
    // La section Ombre fermée retire ses champs du DOM sérialisé (Collapsible.Panel garde son
    // défaut `keepMounted={false}`) — mais `layer.shadow` lui-même n'est JAMAIS touché : rouvrir la
    // section (même calque, même scène, seul `sectionsOpen` change) le fait réapparaître IDENTIQUE.
    // shadow.blur=3 et shadow.color="#000000" sont des marqueurs uniques dans la fixture `textLayer`
    // (aucun autre champ numérique ne vaut exactement 3 ; aucune autre couleur n'est #000000) —
    // vérifié en lisant chaque champ de la fixture ci-dessus avant de les choisir.
    const closed = render([textLayer], "t", "social_post", [], { "text.ombre": false });
    const open = render([textLayer], "t", "social_post", [], { "text.ombre": true });
    expect(closed).not.toContain('value="3"');
    expect(closed).not.toContain('value="#000000"');
    expect(open).toContain('value="3"');
    expect(open).toContain('value="#000000"');
  });
});
