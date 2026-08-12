// tests/studio-constraints-field.test.ts — Chantier D, Tâche 4 : la logique PURE clic->état du
// widget de contraintes de l'inspecteur (components/studio/constraints-field.tsx). Ce fichier ne
// monte AUCUN DOM — c'est tests/studio-geometry-strip.test.ts qui vérifie le VRAI clic sur le carré
// et les deux menus H/V sous le harnais jsdom (U0). Ici, on affirme seulement l'ÉTAT que produit
// `nextConstraintOnEdgeClick`, un maillon de la chaîne testable indépendamment du rendu — même
// séparation pure/DOM que lib/studio/align.ts (le calcul) vs AlignRow (le composant qui l'appelle).
//
// Sémantique choisie (documentée en détail dans le rapport de tâche) : un bord cliqué se pose ; le
// bord OPPOSÉ cliqué ensuite promeut la paire en étirement (`leftRight`/`topBottom`) ; re-cliquer un
// bord SEUL déjà posé le fait basculer en arrière vers `"center"` — pas une 6ᵉ valeur « aucun », les
// cinq valeurs de HConstraint/VConstraint restent les seules jamais produites. Le centre pose
// directement `"center"`, quel que soit l'état de départ.
import { describe, expect, it } from "bun:test";
import type { LayerConstraints } from "@/lib/studio/scene";
import { nextConstraintOnEdgeClick } from "@/components/studio/constraints-field";

const NEUTRAL: LayerConstraints = { h: "center", v: "center" };

describe("nextConstraintOnEdgeClick — axe horizontal", () => {
  it("cliquer le bord gauche pose h:\"left\"", () => {
    expect(nextConstraintOnEdgeClick(NEUTRAL, "h", "left")).toEqual({ h: "left", v: "center" });
  });

  it("gauche PUIS droite pose l'étirement h:\"leftRight\"", () => {
    const afterLeft = nextConstraintOnEdgeClick(NEUTRAL, "h", "left");
    const afterRight = nextConstraintOnEdgeClick(afterLeft, "h", "right");
    expect(afterRight).toEqual({ h: "leftRight", v: "center" });
  });

  it("re-cliquer un bord SEUL déjà posé bascule en arrière vers \"center\"", () => {
    const afterLeft = nextConstraintOnEdgeClick(NEUTRAL, "h", "left");
    expect(afterLeft).toEqual({ h: "left", v: "center" }); // prémisse : le premier clic a bien posé "left"
    const afterLeftAgain = nextConstraintOnEdgeClick(afterLeft, "h", "left");
    expect(afterLeftAgain).toEqual({ h: "center", v: "center" });
  });

  it("le centre pose h:\"center\" depuis n'importe quel départ", () => {
    const stretched: LayerConstraints = { h: "leftRight", v: "top" };
    expect(nextConstraintOnEdgeClick(stretched, "h", "center")).toEqual({ h: "center", v: "top" });
  });

  it("ne touche JAMAIS l'axe vertical", () => {
    const start: LayerConstraints = { h: "center", v: "topBottom" };
    expect(nextConstraintOnEdgeClick(start, "h", "right").v).toBe("topBottom");
  });
});

describe("nextConstraintOnEdgeClick — axe vertical (même machine à états, miroir)", () => {
  it("cliquer le bord haut pose v:\"top\"", () => {
    expect(nextConstraintOnEdgeClick(NEUTRAL, "v", "top")).toEqual({ h: "center", v: "top" });
  });

  it("haut PUIS bas pose l'étirement v:\"topBottom\"", () => {
    const afterTop = nextConstraintOnEdgeClick(NEUTRAL, "v", "top");
    const afterBottom = nextConstraintOnEdgeClick(afterTop, "v", "bottom");
    expect(afterBottom).toEqual({ h: "center", v: "topBottom" });
  });

  it("re-cliquer un bord SEUL déjà posé bascule en arrière vers \"center\"", () => {
    const afterTop = nextConstraintOnEdgeClick(NEUTRAL, "v", "top");
    const afterTopAgain = nextConstraintOnEdgeClick(afterTop, "v", "top");
    expect(afterTopAgain).toEqual({ h: "center", v: "center" });
  });

  it("le centre pose v:\"center\" depuis n'importe quel départ", () => {
    const stretched: LayerConstraints = { h: "left", v: "topBottom" };
    expect(nextConstraintOnEdgeClick(stretched, "v", "center")).toEqual({ h: "left", v: "center" });
  });
});

// Anti-vacuité (spec Tâche 4) : deux clics DISTINCTS depuis le même départ doivent produire deux
// états DISTINCTS — une implémentation qui renverrait `current` inchangé (la mutation du rapport) ou
// qui écraserait systématiquement la même valeur passerait autrement une lecture superficielle.
describe("nextConstraintOnEdgeClick — anti-vacuité", () => {
  it("gauche et droite depuis le même départ neutre donnent deux états distincts", () => {
    const left = nextConstraintOnEdgeClick(NEUTRAL, "h", "left");
    const right = nextConstraintOnEdgeClick(NEUTRAL, "h", "right");
    expect(left).not.toEqual(right);
    expect(left).toEqual({ h: "left", v: "center" });
    expect(right).toEqual({ h: "right", v: "center" });
  });

  it("haut et bas depuis le même départ neutre donnent deux états distincts", () => {
    const top = nextConstraintOnEdgeClick(NEUTRAL, "v", "top");
    const bottom = nextConstraintOnEdgeClick(NEUTRAL, "v", "bottom");
    expect(top).not.toEqual(bottom);
  });

  it("re-cliquer le même bord change l'état par rapport au clic précédent (bascule réelle)", () => {
    const once = nextConstraintOnEdgeClick(NEUTRAL, "h", "left");
    const twice = nextConstraintOnEdgeClick(once, "h", "left");
    expect(twice).not.toEqual(once);
  });
});
