import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ElementsPanel, insertShapeTile } from "@/components/studio/panels/elements-panel";
import { shapeTilesFor } from "@/lib/studio/shape-gallery";
import { editorReducer, initEditorState, type EditorAction } from "@/lib/studio/editor-state";
import type { Scene } from "@/lib/studio/scene";
import type { TemplateContext } from "@/lib/studio/tokens";

// tests/studio-elements-panel.test.ts — Tâche 4 (U1, spec §3), ajouté en réponse à la revue
// (Important 3) : ElementsPanel n'avait, au départ, aucune couverture au niveau composant —
// tests/studio-marque-panel.test.ts documente déjà, pour un panneau frère (Tâche 2, revue
// Important 1), qu'« aucun composant hébergé à cibler » ne veut pas dire « rien de vérifiable ».
// Deux parties non couvertes par tests/studio-shape-gallery.test.ts (qui ne teste QUE les fonctions
// pures de shape-gallery.ts, jamais le composant) :
//   1. la section conditionnelle « Utilisés récemment » (n'apparaît QUE si non vide) ;
//   2. le fait qu'un clic dispatch ET enregistre la tuile récente ENSEMBLE — voir
//      components/studio/panels/elements-panel.tsx#insertShapeTile pour l'explication de la
//      technique (ce dépôt n'a ni React Testing Library ni jsdom pour `bun test`, donc pas de
//      simulation de clic DOM — même limite déjà documentée par tests/diffusion-settings-ui.test.ts
//      et contournée par tests/studio-layer-panel.test.ts#nextIndexForMove : composer la fonction
//      pure que le bouton appelle avec le VRAI réducteur).
const NOOP_DISPATCH = (() => {}) as unknown as React.Dispatch<EditorAction>;
const NOOP_ON_INSERTED = () => {};

function render(
  context: TemplateContext,
  recentShapes: readonly string[] = [],
  canvas = { width: 1200, height: 630 },
): string {
  return renderToStaticMarkup(
    React.createElement(ElementsPanel, {
      context, canvas, recentShapes, dispatch: NOOP_DISPATCH, onShapeInserted: NOOP_ON_INSERTED,
    }),
  );
}

// Extrait la balise <button ...> OUVRANTE portant ce data-tile, rien de plus — même précaution que
// tests/studio-texte-panel.test.ts#buttonTagFor : la classe Tailwind statique du bouton contient
// elle-même la sous-chaîne "disabled:" (disabled:opacity-50 etc.), présente que la tuile soit
// disponible ou non — une recherche de sous-chaîne "disabled" nue serait un faux positif garanti.
function buttonTagFor(html: string, tileId: string): string {
  const re = new RegExp(`<button[^>]*data-tile="${tileId}"[^>]*>`);
  const m = html.match(re);
  if (!m) throw new Error(`aucun bouton data-tile="${tileId}" dans le HTML fourni`);
  return m[0];
}

describe("ElementsPanel — « Utilisés récemment » n'apparaît QUE si non vide (spec §3)", () => {
  it("recentShapes vide : pas de section « Utilisés récemment »", () => {
    const html = render("social_post", []);
    expect(html).not.toContain("elements-recent");
    expect(html).not.toContain("Utilisés récemment");
  });

  it("recentShapes non vide : la section apparaît, avec la bonne tuile dedans", () => {
    const html = render("social_post", ["qr"]);
    expect(html).toContain("Utilisés récemment");
    const recentSection = html.slice(html.indexOf('data-testid="elements-recent"'));
    expect(recentSection).toContain('data-tile="qr"');
  });
});

describe("ElementsPanel — « Formes » liste TOUJOURS le catalogue complet (spec §3)", () => {
  it("affiche une tuile pour chaque entrée de shapeTilesFor, quel que soit le contexte", () => {
    for (const ctx of ["article_image", "social_post", "quote_card"] as const) {
      const html = render(ctx);
      for (const row of shapeTilesFor(ctx)) {
        expect(html).toContain(`data-tile="${row.id}"`);
        expect(html).toContain(row.label);
      }
    }
  });
});

describe("ElementsPanel — la tuile QR hérite sa disponibilité de shapeTilesFor, ne la recalcule pas", () => {
  it("dans social_post (article.url légal) : la tuile QR n'a pas l'attribut HTML disabled", () => {
    const tag = buttonTagFor(render("social_post"), "qr");
    expect(tag).not.toMatch(/\sdisabled(=|\s|>)/);
  });

  it("dans quote_card (article.url illégal) : la tuile QR porte disabled et sa raison française en title", () => {
    const row = shapeTilesFor("quote_card").find((r) => r.id === "qr")!;
    expect(row.available).toBe(false);

    const tag = buttonTagFor(render("quote_card"), "qr");
    expect(tag).toMatch(/\sdisabled=""/);
    expect(tag).toContain(`title="${row.reason}"`);
  });

  it("la tuile rectangle n'est JAMAIS disabled, quel que soit le contexte", () => {
    for (const ctx of ["article_image", "social_post", "quote_card", "newsletter_header", "recap_card"] as const) {
      const tag = buttonTagFor(render(ctx), "rect");
      expect(tag).not.toMatch(/\sdisabled(=|\s|>)/);
    }
  });
});

// Revue Tâche 4, Important 3 : « rien ne prouve qu'un clic déclenche dispatch ET onShapeInserted
// ENSEMBLE ». insertShapeTile EST la fonction que le onClick du bouton appelle (enrobage trivial,
// voir le composant) — la composer ici avec le VRAI réducteur (editorReducer), comme
// tests/studio-layer-panel.test.ts le fait pour nextIndexForMove, prouve les deux à la fois : la
// scène gagne réellement le calque ET la tuile est réellement signalée comme récemment utilisée,
// à partir du MÊME appel — pas de deux appels isolés qui pourraient diverger d'un futur refactor.
describe("insertShapeTile — ce qu'un clic déclenche, composé avec le VRAI réducteur", () => {
  function makeScene(): Scene {
    return {
      schemaVersion: 1,
      canvas: { width: 1200, height: 630, background: "#000000" },
      layers: [],
    };
  }

  it("dispatch insère et sélectionne le calque, ET onShapeInserted est prévenu — dans le MÊME appel", () => {
    let state = initEditorState(makeScene());
    const dispatch = (action: EditorAction) => { state = editorReducer(state, action); };
    const recorded: string[] = [];
    const onShapeInserted = (id: string) => recorded.push(id);

    const row = shapeTilesFor("social_post").find((r) => r.id === "rect")!;
    insertShapeTile(row, { width: 1200, height: 630 }, "social_post", dispatch, onShapeInserted);

    // Le VRAI réducteur a réellement ajouté et sélectionné le calque — pas un mock qui "aurait
    // pu" être appelé correctement.
    expect(state.scene.layers).toHaveLength(1);
    const added = state.scene.layers[0];
    expect(added.type).toBe("shape");
    expect(state.selectedId).toBe(added.id);

    // ET, du MÊME appel, la tuile a été signalée comme récemment utilisée.
    expect(recorded).toEqual(["rect"]);
  });

  it("la tuile QR insérée dans social_post se lie réellement à article.url via le vrai réducteur", () => {
    let state = initEditorState(makeScene());
    const dispatch = (action: EditorAction) => { state = editorReducer(state, action); };
    const recorded: string[] = [];

    const row = shapeTilesFor("social_post").find((r) => r.id === "qr")!;
    insertShapeTile(row, { width: 1200, height: 630 }, "social_post", dispatch, (id) => recorded.push(id));

    expect(state.scene.layers).toHaveLength(1);
    const added = state.scene.layers[0];
    expect(added.type).toBe("qr");
    if (added.type === "qr") expect(added.slot).toBe("article.url");
    expect(recorded).toEqual(["qr"]);
  });
});
