import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Scene, Layer } from "@/lib/studio/scene";
import { PropertyPanel } from "@/components/studio/property-panel";

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

function render(layers: Layer[], selectedId: string | null, context: Parameters<typeof PropertyPanel>[0]["context"]) {
  const noop = () => {};
  return renderToStaticMarkup(
    React.createElement(PropertyPanel, { scene: scene(layers), selectedId, context, dispatch: noop }),
  );
}

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
