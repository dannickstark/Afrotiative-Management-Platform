import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CONTEXT_TOKENS, TOKEN_KINDS, TOKEN_IDS, TEMPLATE_CONTEXTS, validateScene,
  type TemplateContext, type Scene,
} from "@/lib/studio";
import type { TokenKind } from "@/lib/studio/tokens";
import { TokenPicker, tokensFor, TOKEN_LABELS } from "@/components/studio/token-picker";
import { editorReducer, initEditorState, setLayerProp, type EditorAction } from "@/lib/studio/editor-state";

// Même convention que tests/studio-layer-panel.test.ts et tests/studio-drag.test.ts : pas de DOM
// dans `bun test`, donc la STRUCTURE se vérifie en rendant en chaîne HTML (react-dom/server) et le
// COMPORTEMENT en composant les fonctions pures avec le vrai réducteur (Tâche 4).

const ALL_KINDS: TokenKind[] = ["text", "image", "color", "url"];

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

// ─────────────────────────────────────────────────────────────────────────────
describe("TOKEN_LABELS — exhaustivité et langue", () => {
  it("porte une étiquette FRANÇAISE non vide pour CHAQUE jeton du catalogue", () => {
    // Un jeton oublié ici s'afficherait sous sa forme technique brute ({{article.byline}}) dans le
    // sélecteur plutôt qu'en français — cette boucle sur TOKEN_IDS (pas une liste recopiée à la
    // main) fait échouer le test dès qu'un nouveau jeton est ajouté à TOKEN_KINDS sans étiquette.
    for (const id of TOKEN_IDS) {
      expect(TOKEN_LABELS[id]).toBeDefined();
      expect(TOKEN_LABELS[id].trim().length).toBeGreaterThan(0);
      // Pas la forme technique elle-même recopiée telle quelle en guise d'étiquette.
      expect(TOKEN_LABELS[id]).not.toBe(id);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("tokensFor — filtrage PUR par contexte ET par type (le contrat requis)", () => {
  it("un gabarit article_image ne propose JAMAIS article.url — la règle V1 rendue visible", () => {
    // article.url n'existe qu'APRÈS publication WordPress ; l'image à la une est rendue AVANT
    // (lib/studio/tokens.ts). CONTEXT_TOKENS.article_image ne le liste pas — tokensFor doit hériter
    // cette absence, pas la recoder.
    const urlTokens = tokensFor("article_image", "url");
    expect(urlTokens).toEqual([]);
    for (const kind of ALL_KINDS) {
      expect(tokensFor("article_image", kind)).not.toContain("article.url");
    }
  });

  it("un gabarit social_post, en revanche, propose bien article.url (contexte APRÈS publication)", () => {
    expect(tokensFor("social_post", "url")).toEqual(["article.url"]);
  });

  it("un champ couleur ne propose jamais de jeton de type texte — vérifié pour TOUS les contextes", () => {
    for (const context of TEMPLATE_CONTEXTS) {
      const colorTokens = tokensFor(context, "color");
      for (const id of colorTokens) expect(TOKEN_KINDS[id]).toBe("color");
      // Négatif explicite : aucun jeton "text" du même contexte ne doit apparaître dans la liste
      // "color" — un bug qui renverrait CONTEXT_TOKENS[context] sans filtrer ferait échouer ceci.
      const textTokensOfContext = CONTEXT_TOKENS[context].filter((id) => TOKEN_KINDS[id] === "text");
      for (const textId of textTokensOfContext) expect(colorTokens).not.toContain(textId);
    }
  });

  it("exhaustivité croisée : pour CHAQUE contexte et CHAQUE type, tokensFor == CONTEXT_TOKENS filtré par TOKEN_KINDS (aucun oubli, aucun ajout)", () => {
    for (const context of TEMPLATE_CONTEXTS) {
      for (const kind of ALL_KINDS) {
        const expected = CONTEXT_TOKENS[context].filter((id) => TOKEN_KINDS[id] === kind);
        expect(tokensFor(context, kind)).toEqual(expected);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("TokenPicker — composant (rendu structurel réel, pas seulement la fonction pure)", () => {
  it("ne rend RIEN pour un contexte/type sans aucun jeton disponible (article_image × url)", () => {
    const html = render(React.createElement(TokenPicker, { context: "article_image", kind: "url", onPick: () => {} }));
    expect(html).toBe("");
    expect(html).not.toContain("article.url");
  });

  it("rend un déclencheur pour un contexte/type qui a des jetons disponibles (article_image × color)", () => {
    const html = render(React.createElement(TokenPicker, { context: "article_image", kind: "color", onPick: () => {} }));
    expect(html).toContain('data-action="token-picker"');
    expect(html).toContain('data-kind="color"');
  });

  it("le déclencheur pour recap_card × text existe (recap_card a bien des jetons texte)", () => {
    const html = render(React.createElement(TokenPicker, { context: "recap_card", kind: "text", onPick: () => {} }));
    expect(html).toContain('data-action="token-picker"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// « Changer une propriété produit une scène qui valide toujours » — le troisième test requis par
// le brief Tâche 8. La sélection d'un jeton dans TokenPicker aboutit à un dispatch(setLayerProp(...))
// exactement comme n'importe quelle autre édition du panneau de propriétés (Tâche 8) : ce test
// compose le VRAI réducteur (Tâche 4) avec un jeton renvoyé par tokensFor, pour la même garantie
// que layer-panel.test.ts applique déjà aux boutons monter/descendre.
describe("Lier un jeton via TokenPicker produit une scène qui valide toujours", () => {
  function makeScene(): Scene {
    return {
      schemaVersion: 1,
      canvas: { width: 1200, height: 675, background: "#0B0B0B" },
      layers: [{
        id: "title", name: "Titre", visible: true, locked: false,
        frame: { x: 40, y: 40, w: 400, h: 120 },
        type: "text", content: "Texte fixe",
        font: { family: "Noto Sans", size: 32, weight: 400 },
        color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
      }],
    };
  }

  it("lier category.color (jeton color) au champ couleur d'un calque texte, dans un contexte article_image", () => {
    const context: TemplateContext = "article_image";
    let state = initEditorState(makeScene());
    const dispatch = (action: EditorAction) => { state = editorReducer(state, action); };

    const [token] = tokensFor(context, "color");
    expect(token).toBe("category.color"); // pas de surprise silencieuse si CONTEXT_TOKENS change d'ordre
    dispatch(setLayerProp("title", { color: `{{${token}}}` }));

    expect((state.scene.layers[0] as { color: string }).color).toBe("{{category.color}}");
    expect(validateScene(state.scene, context)).toEqual([]);
  });

  it("lier chaque jeton texte disponible au contenu d'un calque texte, pour chaque contexte — toujours valide", () => {
    for (const context of TEMPLATE_CONTEXTS) {
      for (const token of tokensFor(context, "text")) {
        let state = initEditorState(makeScene());
        const dispatch = (action: EditorAction) => { state = editorReducer(state, action); };
        dispatch(setLayerProp("title", { content: `{{${token}}}` }));
        expect(validateScene(state.scene, context)).toEqual([]);
      }
    }
  });

  it("à l'inverse, lier un jeton du MAUVAIS type reste détecté par validateScene — le filtrage de l'UI n'est pas le seul garde-fou", () => {
    // Défense en profondeur : même si TokenPicker ne propose jamais ce jeton pour un champ couleur
    // (déjà prouvé ci-dessus), un contenu construit autrement avec le mauvais type doit rester
    // refusé par validateScene — le vrai filet de sécurité reste côté serveur (saveTemplateScene /
        // publishTemplate), pas seulement l'UI.
    const context: TemplateContext = "article_image";
    let state = initEditorState(makeScene());
    const dispatch = (action: EditorAction) => { state = editorReducer(state, action); };
    const [textToken] = tokensFor(context, "text");
    dispatch(setLayerProp("title", { color: `{{${textToken}}}` })); // jeton "text" dans un champ couleur
    const errors = validateScene(state.scene, context);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toContain(textToken);
  });
});
