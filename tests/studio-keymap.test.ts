import { describe, expect, it } from "bun:test";
import { resolveShortcut, isEditingText, isPopupOpen, type EditorCommand } from "@/lib/studio/keymap";

// tests/studio-keymap.test.ts — Chantier B, Tâche 1 : `resolveShortcut` en PUR (aucun DOM, aucun
// harnais) — juste des littéraux, sur le modèle de tests/studio-mode.test.ts pour
// `isModeToggleShortcut`. Le câblage RÉEL (fenêtre, focus DOM réel) est couvert séparément par
// tests/studio-interactions.test.ts (voir sa section « EditorShell — keymap central »).
//
// `isPopupOpen` (revue post-livraison, voir task-1-report.md) : ajoutée après qu'un test EN CONDITIONS
// RÉELLES (VRAI EditorShell, VRAI PropertyPanel) a montré qu'Échap n'atteignait jamais l'écouteur
// `window` du keymap — un `<Select>` base-ui du panneau de propriétés l'interceptait en premier dès
// qu'un calque est sélectionné. Le correctif (hooks/use-editor-keymap.ts en phase de CAPTURE)
// introduit un risque symétrique : sans cette garde, c'est NOTRE écouteur qui intercepterait Échap ET
// les flèches AVANT un popup ouvert, cassant la navigation clavier d'un `<Select>` ouvert.

const SEL: { hasSelection: boolean; isEditingText: boolean; isPopupOpen: boolean } =
  { hasSelection: true, isEditingText: false, isPopupOpen: false };
const NO_SEL = { ...SEL, hasSelection: false };
const EDITING = { ...SEL, isEditingText: true };
const POPUP_OPEN = { ...SEL, isPopupOpen: true };

describe("resolveShortcut — chaque chord vers sa commande", () => {
  it("⌘Z -> undo", () => {
    expect(resolveShortcut({ key: "z", metaKey: true }, SEL)).toEqual({ kind: "undo" });
  });

  it("Ctrl+Z (hors macOS) -> undo aussi", () => {
    expect(resolveShortcut({ key: "z", ctrlKey: true }, SEL)).toEqual({ kind: "undo" });
  });

  it("⌘⇧Z -> redo", () => {
    expect(resolveShortcut({ key: "z", metaKey: true, shiftKey: true }, SEL)).toEqual({ kind: "redo" });
  });

  it("⌘A -> selectAll", () => {
    expect(resolveShortcut({ key: "a", metaKey: true }, SEL)).toEqual({ kind: "selectAll" });
  });

  it("Échap -> deselect (même sans sélection : effacer une sélection déjà vide est un no-op inoffensif)", () => {
    expect(resolveShortcut({ key: "Escape" }, SEL)).toEqual({ kind: "deselect" });
    expect(resolveShortcut({ key: "Escape" }, NO_SEL)).toEqual({ kind: "deselect" });
  });

  it("Suppr/Retour arrière -> delete, UNIQUEMENT avec une sélection", () => {
    expect(resolveShortcut({ key: "Delete" }, SEL)).toEqual({ kind: "delete" });
    expect(resolveShortcut({ key: "Backspace" }, SEL)).toEqual({ kind: "delete" });
    expect(resolveShortcut({ key: "Delete" }, NO_SEL)).toBeNull();
  });

  it("les quatre flèches -> nudge, avec le delta attendu (même magnitude que hooks/use-layer-drag.ts#nudgeDelta)", () => {
    expect(resolveShortcut({ key: "ArrowLeft" }, SEL)).toEqual({ kind: "nudge", dx: -1, dy: 0 });
    expect(resolveShortcut({ key: "ArrowRight" }, SEL)).toEqual({ kind: "nudge", dx: 1, dy: 0 });
    expect(resolveShortcut({ key: "ArrowUp" }, SEL)).toEqual({ kind: "nudge", dx: 0, dy: -1 });
    expect(resolveShortcut({ key: "ArrowDown" }, SEL)).toEqual({ kind: "nudge", dx: 0, dy: 1 });
  });

  it("Maj+flèche -> nudge au pas élargi (10)", () => {
    expect(resolveShortcut({ key: "ArrowDown", shiftKey: true }, SEL)).toEqual({ kind: "nudge", dx: 0, dy: 10 });
  });

  it("une flèche SANS sélection ne produit aucune commande", () => {
    expect(resolveShortcut({ key: "ArrowLeft" }, NO_SEL)).toBeNull();
  });

  it("une touche sans raccourci défini -> null", () => {
    expect(resolveShortcut({ key: "x" }, SEL)).toBeNull();
    expect(resolveShortcut({ key: "Enter" }, SEL)).toBeNull();
  });
});

// Chantier B, Tâche 2 — le presse-papiers en session : ⌘C/⌘V/⌘D.
describe("resolveShortcut — ⌘C/⌘V/⌘D, le presse-papiers en session (chantier B, tâche 2)", () => {
  it("⌘C -> copy, UNIQUEMENT avec une sélection (même garde que Suppr)", () => {
    expect(resolveShortcut({ key: "c", metaKey: true }, SEL)).toEqual({ kind: "copy" });
    expect(resolveShortcut({ key: "c", metaKey: true }, NO_SEL)).toBeNull();
  });

  it("Ctrl+C (hors macOS) -> copy aussi", () => {
    expect(resolveShortcut({ key: "c", ctrlKey: true }, SEL)).toEqual({ kind: "copy" });
  });

  it("⌘V -> paste, MÊME sans sélection (coller ne dépend pas de la sélection courante)", () => {
    expect(resolveShortcut({ key: "v", metaKey: true }, SEL)).toEqual({ kind: "paste" });
    expect(resolveShortcut({ key: "v", metaKey: true }, NO_SEL)).toEqual({ kind: "paste" });
  });

  it("⌘D -> duplicate, UNIQUEMENT avec une sélection", () => {
    expect(resolveShortcut({ key: "d", metaKey: true }, SEL)).toEqual({ kind: "duplicate" });
    expect(resolveShortcut({ key: "d", metaKey: true }, NO_SEL)).toBeNull();
  });

  it("anti-vacuité : ⌘C, ⌘V et ⌘D produisent trois commandes DISTINCTES, jamais confondues", () => {
    const copyCmd = resolveShortcut({ key: "c", metaKey: true }, SEL);
    const pasteCmd = resolveShortcut({ key: "v", metaKey: true }, SEL);
    const dupCmd = resolveShortcut({ key: "d", metaKey: true }, SEL);
    expect(copyCmd).toEqual({ kind: "copy" });
    expect(pasteCmd).toEqual({ kind: "paste" });
    expect(dupCmd).toEqual({ kind: "duplicate" });
    expect(copyCmd).not.toEqual(pasteCmd);
    expect(pasteCmd).not.toEqual(dupCmd);
  });
});

describe("resolveShortcut — LA GARDE DE FOCUS s'applique aussi à ⌘C/⌘V/⌘D (pas d'exception chord par chord)", () => {
  it("⌘C/⌘V/⌘D pendant l'édition d'un champ texte -> null (le navigateur doit garder la main)", () => {
    expect(resolveShortcut({ key: "c", metaKey: true }, EDITING)).toBeNull();
    expect(resolveShortcut({ key: "v", metaKey: true }, EDITING)).toBeNull();
    expect(resolveShortcut({ key: "d", metaKey: true }, EDITING)).toBeNull();
  });

  it("anti-vacuité : ⌘V guardé -> null, ⌘V NON guardé -> paste (la même entrée, deux contextes)", () => {
    const event = { key: "v", metaKey: true };
    expect(resolveShortcut(event, EDITING)).toBeNull();
    expect(resolveShortcut(event, SEL)).toEqual({ kind: "paste" });
  });
});

describe("resolveShortcut — LA GARDE DE POPUP s'applique aussi à ⌘C/⌘V/⌘D", () => {
  it("⌘C/⌘V/⌘D pendant qu'un popup est ouvert -> null", () => {
    expect(resolveShortcut({ key: "c", metaKey: true }, POPUP_OPEN)).toBeNull();
    expect(resolveShortcut({ key: "v", metaKey: true }, POPUP_OPEN)).toBeNull();
    expect(resolveShortcut({ key: "d", metaKey: true }, POPUP_OPEN)).toBeNull();
  });
});

describe("resolveShortcut — LA GARDE DE FOCUS (ctx.isEditingText) coupe TOUT raccourci géré ici", () => {
  const CHORDS: Array<{ nom: string; event: Parameters<typeof resolveShortcut>[0] }> = [
    { nom: "⌘Z", event: { key: "z", metaKey: true } },
    { nom: "⌘⇧Z", event: { key: "z", metaKey: true, shiftKey: true } },
    { nom: "⌘A", event: { key: "a", metaKey: true } },
    { nom: "Échap", event: { key: "Escape" } },
    { nom: "Suppr", event: { key: "Delete" } },
    { nom: "flèche", event: { key: "ArrowLeft" } },
  ];

  for (const { nom, event } of CHORDS) {
    it(`${nom} pendant l'édition d'un champ texte -> null`, () => {
      expect(resolveShortcut(event, EDITING)).toBeNull();
    });
  }

  // Anti-vacuité (brief) : le MÊME chord, guardé, renvoie null ; NON guardé, il renvoie une commande
  // bien réelle — un test qui ne vérifierait que le premier passerait aussi si `resolveShortcut`
  // renvoyait toujours `null`.
  it("anti-vacuité : ⌘Z guardé -> null, ⌘Z NON guardé -> undo (la même entrée, deux contextes)", () => {
    const event = { key: "z", metaKey: true };
    expect(resolveShortcut(event, EDITING)).toBeNull();
    expect(resolveShortcut(event, SEL)).toEqual({ kind: "undo" });
  });
});

describe("resolveShortcut — LA GARDE DE POPUP (ctx.isPopupOpen) coupe TOUT raccourci géré ici", () => {
  const CHORDS: Array<{ nom: string; event: Parameters<typeof resolveShortcut>[0] }> = [
    { nom: "⌘Z", event: { key: "z", metaKey: true } },
    { nom: "⌘⇧Z", event: { key: "z", metaKey: true, shiftKey: true } },
    { nom: "⌘A", event: { key: "a", metaKey: true } },
    { nom: "Échap", event: { key: "Escape" } },
    { nom: "Suppr", event: { key: "Delete" } },
    { nom: "flèche", event: { key: "ArrowLeft" } },
  ];

  for (const { nom, event } of CHORDS) {
    it(`${nom} pendant qu'un popup (Select/Popover) est ouvert -> null`, () => {
      expect(resolveShortcut(event, POPUP_OPEN)).toBeNull();
    });
  }

  // Anti-vacuité, même recette que la garde de focus ci-dessus.
  it("anti-vacuité : Échap guardé par un popup ouvert -> null, Échap NON guardé -> deselect", () => {
    const event = { key: "Escape" };
    expect(resolveShortcut(event, POPUP_OPEN)).toBeNull();
    expect(resolveShortcut(event, SEL)).toEqual({ kind: "deselect" });
  });

  it("anti-vacuité : une flèche guardée par un popup ouvert -> null (protège la navigation du popup), NON guardée -> nudge", () => {
    const event = { key: "ArrowDown" };
    expect(resolveShortcut(event, POPUP_OPEN)).toBeNull();
    expect(resolveShortcut(event, SEL)).toEqual({ kind: "nudge", dx: 0, dy: 1 });
  });
});

describe("resolveShortcut — anti-vacuité : deux chords distincts -> deux commandes distinctes", () => {
  it("⌘Z et ⌘A ne se confondent pas", () => {
    const undoCmd = resolveShortcut({ key: "z", metaKey: true }, SEL);
    const selectAllCmd = resolveShortcut({ key: "a", metaKey: true }, SEL);
    expect(undoCmd).not.toEqual(selectAllCmd);
    expect(undoCmd).toEqual({ kind: "undo" });
    expect(selectAllCmd).toEqual({ kind: "selectAll" });
  });
});

describe("isEditingText — input/textarea/select/contentEditable", () => {
  it("null -> false (aucune cible, ex. document lui-même a perdu le focus)", () => {
    expect(isEditingText(null)).toBe(false);
  });

  it.each(["INPUT", "TEXTAREA", "SELECT"])("un élément <%s> -> true", (tag) => {
    expect(isEditingText({ tagName: tag } as unknown as EventTarget)).toBe(true);
    expect(isEditingText({ tagName: tag.toLowerCase() } as unknown as EventTarget)).toBe(true); // casse indifférente
  });

  it("isContentEditable=true -> true, même sur une balise quelconque (ex. DIV)", () => {
    expect(isEditingText({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(true);
  });

  it("un DIV ordinaire (ex. le canevas lui-même) -> false", () => {
    expect(isEditingText({ tagName: "DIV" } as unknown as EventTarget)).toBe(false);
    expect(isEditingText({ tagName: "DIV", isContentEditable: false } as unknown as EventTarget)).toBe(false);
  });

  it("un BUTTON -> false (un déclencheur focusable n'est pas un champ de saisie)", () => {
    expect(isEditingText({ tagName: "BUTTON" } as unknown as EventTarget)).toBe(false);
  });
});

describe("isPopupOpen — signal DOM `data-open`/`role=\"listbox\"`/`role=\"menu\"`", () => {
  it("aucun élément ouvert -> false", () => {
    expect(isPopupOpen({ querySelector: () => null })).toBe(false);
  });

  it("un élément correspond (Select/Popover ouvert, porté dans document.body) -> true", () => {
    expect(isPopupOpen({ querySelector: () => ({}) })).toBe(true);
  });

  it("root null (jamais en pratique — document existe toujours) -> false, sans lever", () => {
    expect(isPopupOpen(null)).toBe(false);
  });
});

// Garde-fou de complétude du littéral `EditorCommand` — si une future tâche ajoute un membre à
// l'union sans mettre à jour ce test, TypeScript le signale ici plutôt qu'en silence à l'usage.
describe("EditorCommand — les neuf variantes actuelles restent assignables", () => {
  it("littéraux de contrôle", () => {
    const all: EditorCommand[] = [
      { kind: "undo" },
      { kind: "redo" },
      { kind: "selectAll" },
      { kind: "deselect" },
      { kind: "delete" },
      { kind: "nudge", dx: 1, dy: 0 },
      { kind: "copy" },
      { kind: "paste" },
      { kind: "duplicate" },
    ];
    expect(all).toHaveLength(9);
  });
});
