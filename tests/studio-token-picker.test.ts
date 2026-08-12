import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CONTEXT_TOKENS, TOKEN_KINDS, TOKEN_IDS, TEMPLATE_CONTEXTS, validateScene,
  type TemplateContext, type Scene,
} from "@/lib/studio";
import type { TokenKind } from "@/lib/studio/tokens";
import { TokenPicker, tokensFor, pickerRowsFor, TOKEN_LABELS } from "@/components/studio/token-picker";
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
// Tâche 5 (U4) — pickerRowsFor : contrairement à tokensFor (qui ne renvoie QUE les jetons LÉGAUX du
// contexte, faisant disparaître silencieusement tout le reste — exactement le défaut que cette tâche
// corrige), pickerRowsFor renvoie l'univers COMPLET des jetons du TokenKind demandé. Chaque jeton
// hors CONTEXT_TOKENS[context] porte `available:false` et une raison non vide (au lieu d'être omis) ;
// chaque jeton légal porte `available:true`. Même principe que dynamicTextRowsFor
// (lib/studio/dynamic-text.ts) — mais appliqué au sélecteur GÉNÉRIQUE de n'importe quel champ, pas
// seulement à la section « Texte dynamique ».
describe("pickerRowsFor — l'univers COMPLET du TokenKind, jamais un sous-ensemble qui omet les jetons illégaux", () => {
  it("anti-vacuité : article_image × text contient À LA FOIS une ligne disponible ET une ligne indisponible", () => {
    // article_image (CONTEXT_TOKENS) légalise article.title/excerpt/date/byline/category.name/
    // source.names, mais PAS quote.text ni recap.title (calques d'un AUTRE type de gabarit) — un
    // helper qui marquerait tout disponible, ou qui omettrait encore les illégaux, ne pourrait pas
    // faire passer les deux moitiés de ce test à la fois.
    const rows = pickerRowsFor("article_image", "text");
    const available = rows.filter((r) => r.available);
    const unavailable = rows.filter((r) => !r.available);
    expect(available.length).toBeGreaterThan(0);
    expect(unavailable.length).toBeGreaterThan(0);

    const title = rows.find((r) => r.id === "article.title")!;
    expect(title.available).toBe(true);
    expect(title.reason).toBeUndefined();

    const quoteText = rows.find((r) => r.id === "quote.text")!;
    expect(quoteText.available).toBe(false);
    expect(typeof quoteText.reason).toBe("string");
    expect(quoteText.reason!.trim().length).toBeGreaterThan(0);
    // La formulation reprend celle de validateScene (lib/studio/tokens.ts) / dynamic-text.ts — pas
    // une phrase inventée à part qui pourrait diverger du reste du programme.
    expect(quoteText.reason).toContain("n'est pas disponible dans ce contexte");
  });

  it("l'univers renvoyé est EXACTEMENT tous les TOKEN_IDS de ce TokenKind — aucun oubli, aucun ajout", () => {
    for (const context of TEMPLATE_CONTEXTS) {
      for (const kind of ALL_KINDS) {
        const rows = pickerRowsFor(context, kind);
        const expectedIds = TOKEN_IDS.filter((id) => TOKEN_KINDS[id] === kind);
        expect(rows.map((r) => r.id).sort()).toEqual([...expectedIds].sort());
      }
    }
  });

  it("available suit EXACTEMENT CONTEXT_TOKENS[context], pour chaque contexte et chaque type", () => {
    for (const context of TEMPLATE_CONTEXTS) {
      const legal = new Set<string>(CONTEXT_TOKENS[context]);
      for (const kind of ALL_KINDS) {
        for (const row of pickerRowsFor(context, kind)) {
          expect(row.available).toBe(legal.has(row.id));
          if (row.available) expect(row.reason).toBeUndefined();
          else expect(row.reason).toBeTruthy();
        }
      }
    }
  });

  it("chaque ligne porte l'étiquette FRANÇAISE de TOKEN_LABELS, jamais la forme technique brute", () => {
    for (const row of pickerRowsFor("article_image", "text")) {
      expect(row.label).toBe(TOKEN_LABELS[row.id]);
      expect(row.label).not.toBe(row.id);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("TokenPicker — composant (rendu structurel réel, pas seulement la fonction pure)", () => {
  // Tâche 5 (U4) — CHANGEMENT DE COMPORTEMENT assumé : avant cette tâche, un contexte/type sans
  // AUCUN jeton LÉGAL ne rendait RIEN (`tokens.length === 0` -> `return null`), faisant disparaître
  // silencieusement l'affordance « insérer un jeton » plutôt que de dire pourquoi. article.url est le
  // SEUL jeton de type "url" du catalogue entier (tokens.ts) — il existe donc toujours une ligne à
  // montrer (grisée, avec sa raison) même si CONTEXT_TOKENS.article_image ne le légalise pas. Le
  // déclencheur rend désormais TANT QU'IL EXISTE au moins un jeton de ce TokenKind quelque part dans
  // le catalogue — jamais seulement dans CE contexte.
  it("rend un déclencheur MÊME quand aucun jeton n'est légal dans ce contexte (article_image × url) — grisé, jamais absent", () => {
    const html = render(React.createElement(TokenPicker, { context: "article_image", kind: "url", onPick: () => {} }));
    expect(html).not.toBe("");
    expect(html).toContain('data-action="token-picker"');
    expect(html).toContain('data-kind="url"');
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

  // PORTÉE EXACTE de ce describe (revue Tâche 5) : `PopoverContent` (@/components/ui/popover,
  // @base-ui/react) ne rend son contenu QUE lorsque le popover est OUVERT — vérifié directement,
  // `renderToStaticMarkup` sur un `<TokenPicker>` fermé ne produit que le `<button>` déclencheur,
  // JAMAIS le `<ul>` des lignes (portale + conditionné, comme components/studio/asset-picker.tsx,
  // documenté par tests/studio-interactions.test.ts en tête de fichier). C'est pourquoi AUCUN test de
  // ce fichier n'affirme le contenu d'une ligne (aria-disabled, raison, data-token) par une chaîne
  // HTML statique : ce serait un test qui NE POURRAIT PAS rougir, quoi que fasse le composant, tant
  // le popover reste fermé — un faux témoin. La preuve par contenu RÉEL (le popover OUVERT, un VRAI
  // clic DOM sur une ligne disponible vs. une ligne grisée) vit dans
  // tests/studio-interactions.test.ts (« Seam — TokenPicker »), qui monte déjà le VRAI DOM (jsdom) et
  // gère déjà le piège `useIsoLayoutEffect`/Popover documenté là-bas — dupliquer ce harnais ICI
  // risquerait, sans lui, le même poison inter-fichiers que ce fichier-là évite explicitement
  // (studio-property-panel.test.ts, exécuté dans le même processus `bun test` par la commande « Run
  // focused » du brief, importe PropertyPanel — donc Button — via `renderToStaticMarkup` SANS jamais
  // installer de DOM).
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
