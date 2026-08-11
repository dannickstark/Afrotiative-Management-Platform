import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ElementsPanel, iconFor, insertShapeTile } from "@/components/studio/panels/elements-panel";
import { buildShapeLayer, shapeTilesFor, type ShapeTileRow } from "@/lib/studio/shape-gallery";
import { editorReducer, initEditorState, type EditorAction } from "@/lib/studio/editor-state";
import { SHAPE_KINDS, type Scene } from "@/lib/studio/scene";
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
    expect(state.selectedIds).toEqual([added.id]);

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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// U3 Tâche 3 — HUIT TUILES DE FORME, HUIT ICÔNES.
//
// L'icône de tuile était choisie par le TYPE de tuile (`shape` | `qr`) : avec une seule forme au
// schéma, ça se voyait à peine ; avec huit, la section « Formes » aurait aligné huit carrés
// identiques, distinguables seulement en lisant leurs libellés. Ce n'est pas une décoration : la
// galerie est le seul moyen d'insérer une forme, et une grille d'icônes identiques annule tout
// l'intérêt d'une grille.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("ElementsPanel — chaque forme a son icône (U3 Tâche 3)", () => {
  // Le HTML d'UNE tuile, de sa balise ouvrante à la fermeture du bouton — l'icône est un ENFANT du
  // bouton, donc `buttonTagFor` (la balise ouvrante seule) ne peut pas la voir.
  function tileHtml(html: string, tileId: string): string {
    const start = html.indexOf(`data-tile="${tileId}"`);
    if (start === -1) throw new Error(`aucune tuile data-tile="${tileId}"`);
    const open = html.lastIndexOf("<button", start);
    const end = html.indexOf("</button>", start);
    return html.slice(open, end);
  }
  // lucide-react pose `class="lucide lucide-<nom> …"` sur son <svg> (vérifié en rendant l'icône) :
  // c'est ce nom-là qui identifie l'icône réellement rendue, pas le composant importé.
  function iconOf(html: string, tileId: string): string {
    const m = /class="lucide lucide-([a-z0-9-]+)/.exec(tileHtml(html, tileId));
    if (!m) throw new Error(`aucune icône lucide dans la tuile « ${tileId} »`);
    return m[1];
  }

  it("les huit formes du schéma portent huit icônes DISTINCTES", () => {
    const html = render("social_post");
    const icons = SHAPE_KINDS.map((kind) => iconOf(html, kind));
    // Le compte des DISTINCTES, pas leur nom : le choix d'une icône est un goût, « deux formes ne
    // peuvent pas partager la même » est une règle — exactement le raisonnement de la garde
    // d'unicité des libellés (tests/studio-shapes.test.ts).
    expect(new Set(icons).size).toBe(SHAPE_KINDS.length);
    expect(icons).toHaveLength(8);
  });

  it("la tuile QR garde la sienne, distincte de toutes les formes", () => {
    const html = render("social_post");
    const shapes = new Set(SHAPE_KINDS.map((kind) => iconOf(html, kind)));
    expect(shapes.has(iconOf(html, "qr"))).toBe(false);
  });

  it("une tuile de FORME sans champ `shape` LÈVE — jamais une icône de repli silencieuse", () => {
    // Revue de la Tâche 3 (Low) : `iconFor` se rabattait en silence sur `QrCode`. SYMÉTRIE VOULUE avec
    // `descriptorFor` (lib/studio/shapes.ts), qui lève plutôt que de rendre un rectangle, et avec
    // `buildShapeLayer` (shape-gallery.ts), qui lève sur EXACTEMENT la même tuile — vérifié ici côte à
    // côte pour que les deux gardes ne puissent pas diverger. Inatteignable par le catalogue (la garde
    // de complétude de tests/studio-shape-gallery.test.ts lie SHAPE_TILES au schéma), et c'est
    // justement pour ça qu'un repli s'y installerait sans que personne le voie.
    const invalide = { id: "losange", label: "Losange", kind: "shape", available: true } as ShapeTileRow;
    expect(() => iconFor(invalide)).toThrow(/losange/);
    expect(() => buildShapeLayer(invalide, { width: 800, height: 600 }, "social_post")).toThrow(/losange/);
    // TÉMOINS, sans quoi un `iconFor` qui lèverait TOUJOURS passerait la ligne du dessus : la MÊME
    // tuile munie d'un `shape` rend une icône, et cette icône n'est PAS celle du QR — c'est-à-dire pas
    // le repli que ce correctif vient de retirer. Et la tuile QR, qui n'est pas une forme du schéma,
    // garde la sienne sans lever.
    const qr = { id: "qr", label: "QR code", kind: "qr", available: true } as ShapeTileRow;
    // (une icône lucide est un objet `forwardRef`, pas une fonction — d'où `toBeTruthy` ici.)
    const étoile = iconFor({ ...invalide, shape: "star" } as ShapeTileRow);
    expect(étoile).toBeTruthy();
    expect(étoile).not.toBe(iconFor(qr));
    expect(() => iconFor(qr)).not.toThrow();
  });

  it("l'icône suit la tuile dans « Utilisés récemment » aussi", () => {
    // La section des récents rend les MÊMES tuiles : une icône codée en dur dans une seule des deux
    // sections divergerait sans que rien ne le remarque.
    const html = render("social_post", ["star", "line"]);
    const recents = html.slice(html.indexOf('data-testid="elements-recent"'), html.indexOf('data-testid="elements-shapes"'));
    expect(/class="lucide lucide-([a-z0-9-]+)/.exec(recents)).not.toBeNull();
    expect(new Set([iconOf(recents, "star"), iconOf(recents, "line")]).size).toBe(2);
  });
});
