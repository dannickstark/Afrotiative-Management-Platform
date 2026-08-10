import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TextePanel } from "@/components/studio/panels/texte-panel";
import { dynamicTextRowsFor } from "@/lib/studio/dynamic-text";
import { TEXT_PRESETS } from "@/lib/studio/text-presets";
import { CONTEXT_TOKENS, type TemplateContext } from "@/lib/studio/tokens";
import type { EditorAction } from "@/lib/studio/editor-state";

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
});

// Extrait la balise <button ...> OUVRANTE portant ce data-token, rien de plus — ni son contenu, ni
// les boutons voisins. Nécessaire : la classe Tailwind statique du bouton contient elle-même la
// sous-chaîne "disabled:" (variante disabled:opacity-50 etc.), présente que la ligne soit
// disponible ou non. Un test qui chercherait juste "disabled" dans une fenêtre de caractères autour
// du data-token la trouverait TOUJOURS à cause de cette classe — un faux positif vérifié
// empiriquement en mutant temporairement `disabled={!row.available}` en `disabled={false}` : sans
// cette extraction précise, les deux tests ci-dessous continuaient de passer malgré la mutation.
function buttonTagFor(html: string, tokenId: string): string {
  const re = new RegExp(`<button[^>]*data-token="${tokenId.replace(/\./g, "\\.")}"[^>]*>`);
  const m = html.match(re);
  if (!m) throw new Error(`aucun bouton data-token="${tokenId}" dans le HTML rendu`);
  return m[0];
}

describe("TextePanel — Texte dynamique hérite la disponibilité de dynamicTextRowsFor, ne la recalcule pas", () => {
  it("une ligne DISPONIBLE dans ce contexte n'a pas l'attribut HTML disabled", () => {
    const rows = dynamicTextRowsFor("article_image");
    const available = rows.find((r) => r.available)!;
    const tag = buttonTagFor(render("article_image"), available.tokenId);
    expect(tag).not.toMatch(/\sdisabled(=|\s|>)/);
  });

  it("une ligne INDISPONIBLE dans ce contexte porte l'attribut HTML disabled et sa raison française en title", () => {
    // quote_card exclut article.byline (CONTEXT_TOKENS) — dérivé, pas recopié en dur.
    const ctx: TemplateContext = "quote_card";
    expect(CONTEXT_TOKENS[ctx].includes("article.byline")).toBe(false);
    const row = dynamicTextRowsFor(ctx).find((r) => r.tokenId === "article.byline")!;
    expect(row.available).toBe(false);

    const tag = buttonTagFor(render(ctx), "article.byline");
    expect(tag).toMatch(/\sdisabled=""/);
    expect(tag).toContain(`title="${row.reason}"`);
  });
});
