import { describe, it, expect } from "bun:test";
import { editorLayoutMode, type EditorLayoutMode } from "@/lib/studio/layout-mode";

// tests/studio-layout-mode.test.ts — Chantier A Tâche 4 (spec §2/§9). `editorLayoutMode` est une
// fonction de CHOIX (une largeur en pixels -> l'un de quatre paliers) : le balayer aux bornes EXACTES
// est la seule façon de prouver qu'aucune frontière n'a glissé d'un pixel — un test qui ne vérifierait
// qu'un point « bien à l'intérieur » de chaque palier (ex. 1920, 900, 400) resterait vert même si une
// borne se décalait de plusieurs dizaines de pixels.
describe("editorLayoutMode — quatre paliers, bornes EXACTES (Chantier A Tâche 4)", () => {
  it("1280 -> full (borne basse du palier le plus large)", () => {
    expect(editorLayoutMode(1280)).toBe("full");
  });

  it("1279 -> inspector-drawer (UN pixel sous la borne full)", () => {
    expect(editorLayoutMode(1279)).toBe("inspector-drawer");
  });

  it("1024 -> inspector-drawer (borne basse du palier inspector-drawer)", () => {
    expect(editorLayoutMode(1024)).toBe("inspector-drawer");
  });

  it("1023 -> all-drawers (UN pixel sous la borne inspector-drawer)", () => {
    expect(editorLayoutMode(1023)).toBe("all-drawers");
  });

  it("768 -> all-drawers (borne basse du palier all-drawers)", () => {
    expect(editorLayoutMode(768)).toBe("all-drawers");
  });

  it("767 -> too-small (UN pixel sous la borne all-drawers)", () => {
    expect(editorLayoutMode(767)).toBe("too-small");
  });

  // Anti-vacuité (brief : « all four modes reachable ») : un mutant qui renverrait toujours le même
  // palier — ou qui en oublierait un dans un `switch`/une cascade de `if` mal ordonnée — ferait
  // rougir CETTE assertion précise même si, par accident, les six bornes ci-dessus tombaient toutes
  // sur le même palier fautif.
  it("les quatre paliers sont TOUS atteignables — aucun n'est mort", () => {
    const reached = new Set<EditorLayoutMode>([
      editorLayoutMode(1920),
      editorLayoutMode(1280),
      editorLayoutMode(1100),
      editorLayoutMode(1024),
      editorLayoutMode(900),
      editorLayoutMode(768),
      editorLayoutMode(500),
      editorLayoutMode(0),
    ]);
    expect(reached).toEqual(new Set<EditorLayoutMode>(["full", "inspector-drawer", "all-drawers", "too-small"]));
  });

  // Valeurs limites supplémentaires (largeur nulle, très grande) — un mutant qui inverserait le sens
  // d'une comparaison (`<=` pour `>=`, par exemple) survivrait aux six tests de bornes ci-dessus mais
  // pas à celui-ci.
  it("valeurs extrêmes : 0 -> too-small, une très grande largeur -> full", () => {
    expect(editorLayoutMode(0)).toBe("too-small");
    expect(editorLayoutMode(10_000)).toBe("full");
  });
});
