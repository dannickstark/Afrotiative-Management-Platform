import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TextePanel } from "@/components/studio/panels/texte-panel";
import { dynamicTextRowsFor, insertDynamicTextLayer } from "@/lib/studio/dynamic-text";
import { TEXT_PRESET_IDS, TEXT_PRESETS, buildPresetTextLayer } from "@/lib/studio/text-presets";
import { CONTEXT_TOKENS, type TemplateContext } from "@/lib/studio/tokens";
import { editorReducer, initEditorState, addLayer, type EditorAction } from "@/lib/studio/editor-state";
import type { Scene, TextLayer } from "@/lib/studio/scene";

// tests/studio-texte-panel.test.ts — Tâche 3 (U1, spec §3/§4). Pas dans la liste de fichiers du
// brief (qui ne demande que tests/studio-dynamic-text.test.ts, pour les fonctions PURES), mais
// tests/studio-marque-panel.test.ts documente déjà, pour un panneau frère de cette même série
// (Tâche 2, revue Important 1), qu'« aucun composant hébergé à cibler » ne veut pas dire « rien
// de vérifiable » : ce panneau contient sa propre logique de rendu (griser une ligne, afficher un
// préréglage à sa taille réelle) qu'aucun autre test ne couvre. Convention IDENTIQUE :
// renderToStaticMarkup, assertions contre des helpers IMPORTÉS (dynamicTextRowsFor, TEXT_PRESETS)
// plutôt que des chaînes redérivées ici — un panneau qui recalculerait sa propre règle de
// disponibilité au lieu de lire dynamicTextRowsFor romprait ces tests même s'il « avait l'air »
// correct visuellement.
const NOOP_DISPATCH = (() => {}) as unknown as React.Dispatch<EditorAction>;

function render(context: TemplateContext, canvas = { width: 1200, height: 630 }): string {
  return renderToStaticMarkup(React.createElement(TextePanel, { context, canvas, dispatch: NOOP_DISPATCH }));
}

describe("TextePanel — action primaire", () => {
  it('affiche le bouton « Ajouter une zone de texte »', () => {
    const html = render("article_image");
    expect(html).toContain("Ajouter une zone de texte");
    expect(html).toContain('data-action="add-text"');
  });

  // Correctif revue finale — Important 2 : l'action primaire vit désormais dans le slot
  // `primaryAction` de panel-host.tsx (avant : rendue dans le corps du panneau, le slot restant
  // mort) — vérifié STRUCTURELLEMENT, pas seulement « le texte apparaît quelque part ».
  it("« Ajouter une zone de texte » est bien dans le slot `primaryAction` de PanelHost, pas dans le corps du panneau", () => {
    const html = render("article_image");
    const actionIdx = html.indexOf('data-testid="panel-primary-action"');
    const bodyIdx = html.indexOf('data-testid="texte-panel"');
    expect(actionIdx).toBeGreaterThan(-1);
    expect(actionIdx).toBeLessThan(bodyIdx);
  });
});

describe("TextePanel — Styles rendus à leur taille RÉELLE (spec §3), pas une valeur inventée par le panneau", () => {
  it("chaque préréglage apparaît avec l'exacte taille/graisse de TEXT_PRESETS", () => {
    const html = render("article_image");
    for (const preset of Object.values(TEXT_PRESETS)) {
      expect(html).toContain(preset.label);
      expect(html).toContain(`font-size:${preset.size}px`);
      expect(html).toContain(`font-weight:${preset.weight}`);
    }
  });

  // Correctif revue finale — Important 4 : ces lignes étaient de simples `<li>` inertes, au même
  // bord/rayon/padding que les lignes VRAIMENT cliquables de « Texte dynamique » juste en dessous.
  it("chaque ligne « Styles » est un VRAI bouton cliquable, pas un <li> inerte", () => {
    const html = render("article_image");
    for (const id of TEXT_PRESET_IDS) {
      expect(html).toMatch(new RegExp(`<button[^>]*data-preset="${id}"[^>]*>`));
    }
  });

  it("un clic sur un style insère un calque texte SANS jeton (non lié), via le VRAI réducteur", () => {
    const scene: Scene = { schemaVersion: 1, canvas: { width: 1200, height: 630, background: "#000000" }, layers: [] };
    let state = initEditorState(scene);
    const dispatch = (a: EditorAction) => { state = editorReducer(state, a); };

    const layer = buildPresetTextLayer("titre", { width: 1200, height: 630 });
    dispatch(addLayer("text", layer));

    expect(state.scene.layers).toHaveLength(1);
    const inserted = state.scene.layers[0] as TextLayer;
    expect(inserted.type).toBe("text");
    expect(inserted.content).not.toMatch(/\{\{/); // non lié : aucun jeton dans le contenu
    expect(state.selectedIds).toEqual([inserted.id]);
  });
});

// Extrait la balise <button ...> OUVRANTE portant ce data-token, rien de plus — ni son contenu, ni
// les boutons voisins. Nécessaire : la classe Tailwind statique du bouton contient elle-même la
// sous-chaîne "disabled:" — une recherche de sous-chaîne "disabled" nue serait un faux positif.
function buttonTagFor(html: string, tokenId: string): string {
  const re = new RegExp(`<button[^>]*data-token="${tokenId.replace(/\./g, "\\.")}"[^>]*>`);
  const m = html.match(re);
  if (!m) throw new Error(`aucun bouton data-token="${tokenId}" dans le HTML rendu`);
  return m[0];
}

describe("TextePanel — Texte dynamique hérite la disponibilité de dynamicTextRowsFor, ne la recalcule pas", () => {
  it("une ligne DISPONIBLE dans ce contexte n'a pas aria-disabled=\"true\"", () => {
    const rows = dynamicTextRowsFor("article_image");
    const available = rows.find((r) => r.available)!;
    const tag = buttonTagFor(render("article_image"), available.tokenId);
    expect(tag).not.toContain('aria-disabled="true"');
  });

  // Correctif revue finale — Important 5, amendement de spec §4 : la raison d'une ligne
  // indisponible n'est plus portée UNIQUEMENT par `title` (inatteignable au clavier, annoncée de
  // façon peu fiable). Le bouton reste FOCUSABLE (jamais l'attribut HTML `disabled`, qui le
  // retirerait de l'ordre de tabulation) — `aria-disabled="true"` + `aria-describedby` pointant vers
  // une ligne VISIBLE portant la raison en toutes lettres dans le DOM.
  it("une ligne INDISPONIBLE dans ce contexte reste FOCUSABLE (jamais `disabled`), porte aria-disabled=\"true\" et sa raison est VISIBLE dans la ligne, reliée par aria-describedby", () => {
    // quote_card exclut article.byline (CONTEXT_TOKENS) — dérivé, pas recopié en dur ; et
    // article.byline fait partie des cinq jetons du tableau §4, donc une ligne grisée existe bien.
    const ctx: TemplateContext = "quote_card";
    expect(CONTEXT_TOKENS[ctx].includes("article.byline")).toBe(false);
    const row = dynamicTextRowsFor(ctx).find((r) => r.tokenId === "article.byline")!;
    expect(row.available).toBe(false);

    const html = render(ctx);
    const tag = buttonTagFor(html, "article.byline");
    expect(tag).not.toMatch(/\sdisabled(=|\s|>)/); // jamais le vrai attribut disabled
    expect(tag).toContain('aria-disabled="true"');
    const describedByMatch = /aria-describedby="([^"]+)"/.exec(tag);
    expect(describedByMatch).not.toBeNull();
    const reasonId = describedByMatch![1];
    // La raison est un NŒUD RÉEL du DOM, portant CET id, avec le texte français en clair — pas
    // seulement un attribut `title` inatteignable au clavier.
    expect(html).toContain(`id="${reasonId}"`);
    expect(html).toContain(row.reason!);
  });

  it("un clic sur une ligne indisponible n'insère RIEN — composé avec le VRAI réducteur (spec §9)", () => {
    const ctx: TemplateContext = "quote_card";
    const row = dynamicTextRowsFor(ctx).find((r) => !r.available)!;
    const scene: Scene = { schemaVersion: 1, canvas: { width: 1200, height: 630, background: "#000000" }, layers: [] };
    let state = initEditorState(scene);
    // Reproduit EXACTEMENT ce que le onClick du bouton fait (voir texte-panel.tsx) : n'insère que
    // via insertDynamicTextLayer, qui renvoie null pour une ligne indisponible.
    const layer = insertDynamicTextLayer(row, { width: 1200, height: 630 });
    const dispatch = (a: EditorAction) => { state = editorReducer(state, a); };
    if (layer) dispatch(addLayer("text", layer));
    expect(state.scene.layers).toHaveLength(0);
  });
});
