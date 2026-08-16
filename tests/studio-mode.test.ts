import { describe, expect, it } from "bun:test";
import { toggleMode, preserveView, isModeToggleShortcut, type PreservedView } from "@/lib/studio/studio-mode";

// tests/studio-mode.test.ts — Tâche 5 (U1, spec §5) : les modes Montage ⇄ Rendu réel, PURS.

describe("toggleMode", () => {
  it("bascule dans les deux sens", () => {
    expect(toggleMode("montage")).toBe("rendu");
    expect(toggleMode("rendu")).toBe("montage");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// preserveView — défaut corrigé du brief : `expect(preserveView(preserveView(v))).toEqual(v)` passe
// TRIVIALEMENT pour `x => x` (le brief lui-même le signale) — cette version ne prouve donc rien de
// spécifique à l'implémentation, une fonction qui renverrait n'importe quoi d'AUTRE que `v` mais qui
// serait son propre inverse (ex. échanger deux champs) la satisferait aussi. Les tests ci-dessous
// comparent CHAMP PAR CHAMP contre des valeurs DISTINCTES les unes des autres (aucun champ ne
// partage sa valeur avec un autre), pour qu'un sabotage qui swap ou oublie un champ (ex. renvoyer
// `scrollX` à la place de `scrollY`, ou réinitialiser un champ à sa valeur par défaut) échoue
// visiblement — pas seulement un sabotage qui casserait la propriété d'aller-retour.
describe("preserveView", () => {
  const v: PreservedView = { selectedId: "ig_portrait", zoom: 0.75, scrollX: 120, scrollY: 40 };

  it("renvoie exactement les mêmes valeurs, champ par champ (pas seulement égal en bloc)", () => {
    const out = preserveView(v);
    expect(out.selectedId).toBe("ig_portrait");
    expect(out.zoom).toBe(0.75);
    expect(out.scrollX).toBe(120);
    expect(out.scrollY).toBe(40);
  });

  it("un sabotage qui oublierait un champ (ex. scrollY toujours à 0) échouerait ici", () => {
    // Témoin de sabotage : si l'implémentation ignorait un champ du littéral d'entrée et renvoyait
    // toujours une valeur par défaut à sa place, CE test — pas seulement le double aller-retour du
    // brief — le détecterait, puisque aucune valeur de `v` ci-dessus ne vaut 0/null/"fit".
    const out = preserveView(v);
    expect(out).toEqual(v);
  });

  it("gère selectedId=null et zoom=\"fit\" (le format natif, aucun format promu) sans les convertir", () => {
    const fit: PreservedView = { selectedId: null, zoom: "fit", scrollX: 0, scrollY: 0 };
    expect(preserveView(fit)).toEqual(fit);
  });

  it("l'aller-retour (Rendu -> Montage -> Rendu) est stable — utile en PLUS des tests champ par champ ci-dessus, pas à leur place", () => {
    expect(preserveView(preserveView(v))).toEqual(v);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isModeToggleShortcut — le prédicat du raccourci « R » (spec §5), extrait en fonction PURE (leçon
// de la Tâche 1 : son prédicat ⌘/ ne dépendait lui non plus d'aucune API DOM réelle et aurait pu
// être testé de la même façon). Littéraux d'objet uniquement — AUCUN jsdom/harnais DOM ici, comme
// demandé : cette suite n'en a pas.
describe("isModeToggleShortcut", () => {
  it("bascule sur un « r » nu, focus hors champ de saisie", () => {
    expect(isModeToggleShortcut({ key: "r", target: { tagName: "DIV" } })).toBe(true);
  });

  it("bascule aussi sur « R » (Maj) — la casse ne doit pas changer le sens du raccourci", () => {
    expect(isModeToggleShortcut({ key: "R", target: { tagName: "BODY" } })).toBe(true);
  });

  it("bascule quand target est null (ex. raccourci déclenché sans cible DOM connue)", () => {
    expect(isModeToggleShortcut({ key: "r", target: null })).toBe(true);
  });

  // Le cas qui compte (brief) : taper « r » dans le contenu d'un calque texte ne doit JAMAIS
  // basculer le mode. Le contenu d'un calque texte s'édite dans un <Textarea> (components/studio/
  // property-panel.tsx), qui rend un <textarea> natif (components/ui/textarea.tsx) — donc le cas
  // TEXTAREA est celui qui reproduit vraiment le bug que la Tâche 1 avait laissé passer pour ⌘/.
  it("NE bascule PAS quand le focus est dans un <textarea> (contenu d'un calque texte)", () => {
    expect(isModeToggleShortcut({ key: "r", target: { tagName: "TEXTAREA" } })).toBe(false);
  });

  it("NE bascule PAS quand le focus est dans un <input> (ex. un champ de propriété numérique)", () => {
    expect(isModeToggleShortcut({ key: "r", target: { tagName: "INPUT" } })).toBe(false);
  });

  it("NE bascule PAS quand le focus est dans un <select>", () => {
    expect(isModeToggleShortcut({ key: "r", target: { tagName: "SELECT" } })).toBe(false);
  });

  it("NE bascule PAS quand la cible est contentEditable (même si ce n'est ni un input ni un textarea)", () => {
    expect(isModeToggleShortcut({ key: "r", target: { tagName: "DIV", isContentEditable: true } })).toBe(false);
  });

  it("NE bascule PAS avec Cmd+R (ne doit jamais intercepter le rechargement de page du navigateur)", () => {
    expect(isModeToggleShortcut({ key: "r", metaKey: true, target: { tagName: "BODY" } })).toBe(false);
  });

  it("NE bascule PAS avec Ctrl+R ni Alt+R", () => {
    expect(isModeToggleShortcut({ key: "r", ctrlKey: true, target: { tagName: "BODY" } })).toBe(false);
    expect(isModeToggleShortcut({ key: "r", altKey: true, target: { tagName: "BODY" } })).toBe(false);
  });

  it("NE bascule PAS sur une autre lettre", () => {
    expect(isModeToggleShortcut({ key: "e", target: { tagName: "BODY" } })).toBe(false);
  });
});

import { focusedFormat, formatNavAction, zoomStep, ZOOM_STEPS } from "@/lib/studio/studio-mode";

// Refonte « Rendu réel » : `PreservedView.selectedId` CHANGE DE SENS. Avant, `null` voulait dire
// « le format natif est promu dans la grande case » ; désormais il veut dire « aucun format
// focalisé — on est sur la planche ». `focusedFormat` est le seul lecteur autorisé de ce champ côté
// Rendu réel : il garde le composant d'une valeur qui ne serait pas une vraie clé de format.
describe("focusedFormat", () => {
  const base = { zoom: "fit" as const, scrollX: 0, scrollY: 0 };

  it("`null` signifie la planche, pas un format", () => {
    expect(focusedFormat({ ...base, selectedId: null })).toBeNull();
  });

  it("une clé de format réelle est renvoyée telle quelle", () => {
    expect(focusedFormat({ ...base, selectedId: "story" })).toBe("story");
  });

  it("une valeur qui n'est PAS une clé de format retombe sur la planche plutôt que de faire planter un indexage", () => {
    expect(focusedFormat({ ...base, selectedId: "layer-42" })).toBeNull();
    expect(focusedFormat({ ...base, selectedId: "" })).toBeNull();
  });
});

describe("formatNavAction", () => {
  const div = { tagName: "DIV" };

  it("flèches et Échap pilotent la navigation entre formats", () => {
    expect(formatNavAction({ key: "ArrowLeft", target: div })).toBe("prev");
    expect(formatNavAction({ key: "ArrowRight", target: div })).toBe("next");
    expect(formatNavAction({ key: "Escape", target: div })).toBe("exit");
  });

  it("ignore toute autre touche", () => {
    expect(formatNavAction({ key: "a", target: div })).toBeNull();
    expect(formatNavAction({ key: "ArrowUp", target: div })).toBeNull();
  });

  it("ne détourne JAMAIS une combinaison portant un modificateur", () => {
    expect(formatNavAction({ key: "ArrowLeft", metaKey: true, target: div })).toBeNull();
    expect(formatNavAction({ key: "ArrowRight", ctrlKey: true, target: div })).toBeNull();
    expect(formatNavAction({ key: "ArrowLeft", altKey: true, target: div })).toBeNull();
  });

  it("est inerte quand le focus est dans un champ de saisie — même discipline qu'isModeToggleShortcut", () => {
    expect(formatNavAction({ key: "ArrowLeft", target: { tagName: "INPUT" } })).toBeNull();
    expect(formatNavAction({ key: "ArrowRight", target: { tagName: "TEXTAREA" } })).toBeNull();
    expect(formatNavAction({ key: "Escape", target: { tagName: "DIV", isContentEditable: true } })).toBeNull();
  });
});

describe("zoomStep", () => {
  it("l'échelle est bornée à 100 % — au-delà on inspecterait un agrandissement, pas une typographie", () => {
    expect(ZOOM_STEPS[ZOOM_STEPS.length - 1]).toBe(1);
    expect(zoomStep(1, 1)).toBe(1);
  });

  it("ne descend jamais sous le premier cran", () => {
    expect(zoomStep(ZOOM_STEPS[0]!, -1)).toBe(ZOOM_STEPS[0]);
  });

  it("monte et descend d'un cran à la fois", () => {
    expect(zoomStep(0.25, 1)).toBe(0.5);
    expect(zoomStep(0.5, -1)).toBe(0.25);
  });

  it("depuis « fit », zoomer entre par le milieu de l'échelle plutôt que par un bord arbitraire", () => {
    const entry = zoomStep("fit", 1);
    expect(ZOOM_STEPS).toContain(entry);
    expect(entry).toBeGreaterThan(ZOOM_STEPS[0]!);
    expect(entry).toBeLessThanOrEqual(1);
  });

  it("une valeur hors échelle est ramenée au cran adjacent le plus proche, jamais renvoyée telle quelle", () => {
    expect(ZOOM_STEPS).toContain(zoomStep(0.42, 1));
    expect(ZOOM_STEPS).toContain(zoomStep(0.42, -1));
  });
});
