// lib/studio/keymap.ts — Chantier B, Tâche 1 : le KEYMAP CENTRAL de l'éditeur, en PURE.
//
// Un module FEUILLE (aucun import de valeur — voir align.ts pour le même motif) : `resolveShortcut`
// ne prend que des primitifs (un littéral reproduisant les seuls champs de KeyboardEvent dont on a
// besoin, comme `isModeToggleShortcut` de studio-mode.ts avant lui) et renvoie un `EditorCommand |
// null`, jamais un effet. Toute la DÉCISION « quelle touche fait quoi » vit ici ; le câblage réel
// (hooks/use-editor-keymap.ts) ne fait que traduire l'événement DOM réel en littéral avant de lui
// poser la question, puis traduire la commande obtenue en action du réducteur.
//
// EXTENSIBLE (le plan le demande) : `EditorCommand` est une union DISCRIMINÉE par `kind`, sur le
// modèle d'`EditorAction` (editor-state.ts) — les tâches suivantes du chantier B y ajouteront
// copier/coller/dupliquer/zoom/grouper sans toucher aux cas déjà câblés.
//
// ── LA GARDE DE FOCUS EST PORTEUSE (spec du brief) ─────────────────────────────────────────────────
// `ctx.isEditingText` coupe TOUT raccourci géré ici — pas seulement Suppr/flèches/⌘A, mais aussi
// ⌘Z/⌘⇧Z. Choix délibéré, documenté plutôt que laissé à deviner : un champ de saisie (le contenu d'un
// calque texte, un champ numérique du panneau de propriétés) a SA PROPRE pile d'annulation native du
// navigateur — la lui voler pour annuler un geste de l'éditeur pendant que l'utilisateur tape serait
// la même surprise que « taper R bascule le mode » que studio-mode.ts avait déjà tranchée pour un
// AUTRE raccourci. La garde est donc UNIFORME : aucune exception chord par chord, pour qu'un futur
// ajout à cette union n'ait pas à se souvenir laquelle des deux familles s'applique.
//
// ── LA GARDE DE POPUP, AJOUTÉE EN REVUE (Escape était mort dans le VRAI EditorShell) ────────────────
// `ctx.isPopupOpen` existe pour une raison précise et mesurée : `hooks/use-editor-keymap.ts` écoute
// désormais `window` en phase de CAPTURE (pas de bouillonnement) — voir son en-tête pour le POURQUOI
// (un `<Select>` base-ui du panneau de propriétés interceptait « Échap » en phase de bouillonnement
// AVANT que l'écouteur `window` ne le voie, laissant « Échap efface la sélection » mort dans le VRAI
// EditorShell malgré une suite verte). En capture, c'est maintenant NOUS qui voyons l'événement EN
// PREMIER, avant le popup lui-même — donc sans cette garde, Échap DÉSÉLECTIONNERAIT le calque au lieu
// de fermer un menu/liste déroulante ouvert (le popup ne verrait même plus l'événement si on
// `preventDefault`/`stopPropagation`), et une flèche HAUT/BAS destinée à naviguer les options d'un
// `<Select>` ouvert (« Forme », « Alignement », tout `SelectField` du panneau de propriétés)
// DÉPLACERAIT le calque sélectionné à la place — un second défaut, plus sournois, que le capture-phase
// aurait introduit sans qu'aucune revue ne le demande explicitement. D'où la garde UNIFORME (comme
// `isEditingText` ci-dessus, même raisonnement) plutôt que limitée à Échap seul : tant qu'un popup base-
// ui est ouvert, c'est LUI qui possède le clavier, pas le canevas. `isPopupOpen()` plus bas fait la
// détection — voir SON commentaire pour le signal DOM exact (`aria-haspopup` + `aria-expanded="true"`
// sur le DÉCLENCHEUR, PAS `data-open`, dont un premier jet s'est révélé un faux-positif permanent dès
// qu'un calque est sélectionné — voir task-1-report.md).
export type EditorCommand =
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "selectAll" }
  | { kind: "deselect" }
  | { kind: "delete" }
  | { kind: "nudge"; dx: number; dy: number }
  // Chantier B, Tâche 2 — le presse-papiers en session (copier/coller/dupliquer). Trois commandes
  // pures : ce module ne sait RIEN du contenu réel des calques ni du presse-papiers lui-même
  // (lib/studio/clipboard.ts) — c'est le hook (hooks/use-editor-keymap.ts) qui lit la sélection
  // courante et le presse-papiers, exactement comme il résout déjà l'id unique et le verrou pour
  // `delete`/`nudge` (voir son en-tête, « CE QUE CE HOOK DÉCIDE QUE resolveShortcut NE PEUT PAS
  // DÉCIDER »). `copy`/`duplicate` exigent une sélection non vide (même garde que `delete`, via
  // `ctx.hasSelection`) — coller, lui, n'a pas besoin d'une sélection : on peut coller dans une scène
  // sans rien sélectionner au préalable.
  | { kind: "copy" }
  | { kind: "paste" }
  | { kind: "duplicate" }
  // Chantier B, Tâche 3 — le VRAI zoom (⇧0/⇧1/⇧2). Trois commandes, comme les trois préréglages de
  // lib/studio/zoom.ts#zoomPresetScale ("100"/"fit"/"selection") — ce module ne sait toujours RIEN de
  // `fitScale`, de la sélection réelle ni du viewport : c'est hooks/use-editor-keymap.ts qui résout
  // ces trois commandes en un facteur réel via zoom.ts, exactement comme il résout déjà `selectedIds`
  // en calques réels pour `copy`/`duplicate` ci-dessus. `zoomSelection` porte la MÊME garde que
  // `copy`/`duplicate` (`ctx.hasSelection`, plus bas) — zoomer sur une sélection vide n'a rien à
  // cadrer ; `zoom100`/`zoomFit` n'en ont pas besoin, comme `paste`.
  | { kind: "zoom100" }
  | { kind: "zoomFit" }
  | { kind: "zoomSelection" };

export interface ShortcutEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

export interface ShortcutContext {
  /** Une sélection non vide — SUFFIT pour Suppr/flèches (le hook, lui, doit encore résoudre l'id
   * unique et son verrou avant de dispatcher : voir hooks/use-editor-keymap.ts). Sans sélection,
   * Suppr/flèches n'ont rien à faire — `resolveShortcut` renvoie `null` plutôt qu'une commande que le
   * hook devrait de toute façon ignorer, pour que « ce raccourci fait quelque chose » reste une
   * question tranchée ICI, pas dispersée entre ce module et son appelant. */
  hasSelection: boolean;
  isEditingText: boolean;
  /** Un popup base-ui (Select, Popover, Menu) est actuellement ouvert quelque part dans le document —
   * voir « LA GARDE DE POPUP » ci-dessus et `isPopupOpen()` plus bas pour le signal DOM exact. */
  isPopupOpen: boolean;
}

// Mêmes valeurs que `NUDGE_STEP`/`NUDGE_STEP_SHIFT` de hooks/use-layer-drag.ts#nudgeDelta —
// délibérément DUPLIQUÉES plutôt qu'importées : ce module reste une FEUILLE sans import de valeur
// (voir l'en-tête), et hooks/use-layer-drag.ts est un fichier "use client" qui tire React à son tour —
// l'importer ICI inverserait la direction de dépendance (lib/studio ne dépend jamais de hooks/).
// tests/studio-keymap.test.ts épingle l'accord des deux jeux de constantes.
const NUDGE_STEP = 1;
const NUDGE_STEP_SHIFT = 10;

function nudgeFor(key: string, shift: boolean): { dx: number; dy: number } | null {
  const step = shift ? NUDGE_STEP_SHIFT : NUDGE_STEP;
  switch (key) {
    case "ArrowLeft": return { dx: -step, dy: 0 };
    case "ArrowRight": return { dx: step, dy: 0 };
    case "ArrowUp": return { dx: 0, dy: -step };
    case "ArrowDown": return { dx: 0, dy: step };
    default: return null;
  }
}

// Le routeur central. Ordre des branches SANS conséquence sur le résultat (les chords sont
// mutuellement exclusifs — jamais deux `case` vrais pour le même événement), mais gardé lisible dans
// l'ordre où le brief les énumère.
export function resolveShortcut(e: ShortcutEvent, ctx: ShortcutContext): EditorCommand | null {
  // Les deux gardes — voir l'en-tête de module pour chacune. UNIFORMES toutes les deux : aucun chord
  // n'y échappe, y compris ⌘Z/⌘⇧Z (déjà justifié) et Échap (justifié par la garde de popup).
  if (ctx.isEditingText || ctx.isPopupOpen) return null;

  const mod = e.metaKey === true || e.ctrlKey === true;
  const key = e.key;

  if (mod && key.toLowerCase() === "z") {
    return e.shiftKey ? { kind: "redo" } : { kind: "undo" };
  }
  if (mod && key.toLowerCase() === "a") {
    return { kind: "selectAll" };
  }
  // Chantier B, Tâche 2 — voir le commentaire de `"copy"`/`"paste"`/`"duplicate"` sur `EditorCommand`
  // ci-dessus. `copy`/`duplicate` suivent EXACTEMENT le motif déjà posé par `delete` (`ctx.hasSelection`
  // avant de renvoyer une commande, plutôt que la renvoyer inconditionnellement et laisser le hook
  // décider) : sans sélection, il n'y a rien à copier ni à dupliquer, donc `resolveShortcut` renvoie
  // `null` — pas une commande que le hook devrait de toute façon ignorer. `paste`, lui, n'a PAS cette
  // garde : coller ne dépend pas de la sélection courante, seulement du contenu du presse-papiers, que
  // ce module ne connaît pas (c'est au hook de vérifier qu'il n'est pas vide avant de dispatcher).
  if (mod && key.toLowerCase() === "c") {
    return ctx.hasSelection ? { kind: "copy" } : null;
  }
  if (mod && key.toLowerCase() === "v") {
    return { kind: "paste" };
  }
  if (mod && key.toLowerCase() === "d") {
    return ctx.hasSelection ? { kind: "duplicate" } : null;
  }
  // Chantier B, Tâche 3 — ⇧0/⇧1/⇧2 : MAJ SEULE, jamais ⌘/Ctrl (ce sont des chords DIFFÉRENTS —
  // ⌘⇧0 ne fait rien ici, comme aucun navigateur ne réserve ⇧0/⇧1/⇧2 nus sur un clavier standard,
  // vérifié au même titre que ⌘/ dans editor-shell.tsx). `zoomSelection` (⇧2) suit EXACTEMENT le
  // motif de `copy`/`duplicate` : sans sélection, rien à cadrer, `resolveShortcut` renvoie `null`
  // plutôt qu'une commande que le hook devrait de toute façon ignorer.
  if (!mod && e.shiftKey && key === "0") {
    return { kind: "zoom100" };
  }
  if (!mod && e.shiftKey && key === "1") {
    return { kind: "zoomFit" };
  }
  if (!mod && e.shiftKey && key === "2") {
    return ctx.hasSelection ? { kind: "zoomSelection" } : null;
  }
  if (!mod && key === "Escape") {
    return { kind: "deselect" };
  }
  if (!mod && (key === "Delete" || key === "Backspace")) {
    return ctx.hasSelection ? { kind: "delete" } : null;
  }
  if (!mod) {
    const nudge = nudgeFor(key, e.shiftKey === true);
    if (nudge) return ctx.hasSelection ? { kind: "nudge", ...nudge } : null;
  }
  return null;
}

// Le prédicat de garde lui-même — `EventTarget | null` (le type du VRAI `KeyboardEvent.target` du
// navigateur), jamais un DOM complet : duck-typé sur les deux seuls champs qui comptent, comme
// `ModeShortcutTarget` (studio-mode.ts) avant lui. `isContentEditable` reflète, par la plateforme
// elle-même, aussi bien l'élément que ses ANCÊTRES contenteditable — inutile de remonter l'arbre à la
// main ici.
const EDITING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function isEditingText(target: EventTarget | null): boolean {
  if (!target) return false;
  const el = target as unknown as { tagName?: string; isContentEditable?: boolean };
  const tagName = el.tagName?.toUpperCase() ?? "";
  if (EDITING_TAGS.has(tagName)) return true;
  return el.isContentEditable === true;
}

// Le second prédicat de garde — voir « LA GARDE DE POPUP » en tête de module. `root` est duck-typé
// sur le SEUL membre utilisé (`querySelector`), jamais `Document` en dur : c'est ce qui rend cette
// fonction testable avec un littéral `{ querySelector: () => … }`, sans DOM, comme `isEditingText`
// ci-dessus l'est avec un littéral `{ tagName }`. Le hook, lui, appelle `isPopupOpen(document)` — un
// `Document` réel satisfait trivialement cette interface.
//
// LE SÉLECTEUR, ET POURQUOI CE N'EST PAS `[data-open]` (premier jet, FAUX-POSITIF trouvé en écrivant
// le test DOM du correctif) : `data-open` est la convention base-ui pour TOUT composant « ouvert », y
// compris `Collapsible` (les sections repliables du panneau de propriétés, OUVERTES PAR DÉFAUT —
// property-panel.tsx#TypeSection) et `Dialog`/`Sheet` (le tiroir inspecteur, qui s'auto-ouvre à la
// sélection sous 1280px). Un `[data-open]` nu rendait donc `isPopupOpen` VRAI dès qu'un calque est
// sélectionné, MÊME SANS AUCUN POPUP OUVERT — regardé et corrigé APRÈS avoir vu les tests « flèche »/
// « Suppr »/« ⌘Z » du VRAI EditorShell rougir à leur tour (le keymap se gardait lui-même en
// permanence). Vérifié directement dans node_modules/@base-ui/react (grep sur les trois primitives) :
// SEULS Select/Popover/Menu posent `aria-haspopup` sur leur DÉCLENCHEUR (respectivement `"listbox"`,
// `"dialog"`, `"menu"`) — `Collapsible.Trigger` ne pose que `aria-expanded`, JAMAIS `aria-haspopup`
// (c'est justement la distinction ARIA entre un disclosure widget et un vrai popup). Le sélecteur
// vise donc le DÉCLENCHEUR, pas le popup porté lui-même : `[aria-haspopup][aria-expanded="true"]` —
// vrai UNIQUEMENT pour un Select/Popover/Menu RÉELLEMENT ouvert, jamais pour une section repliable ni
// pour le tiroir inspecteur (qui n'a pas de déclencheur `aria-haspopup` quand il s'auto-ouvre par
// effet plutôt que par clic).
export interface PopupProbeRoot {
  querySelector(selectors: string): unknown;
}

const OPEN_POPUP_TRIGGER_SELECTOR = '[aria-haspopup][aria-expanded="true"]';

export function isPopupOpen(root: PopupProbeRoot | null): boolean {
  if (!root) return false;
  const match = root.querySelector(OPEN_POPUP_TRIGGER_SELECTOR);
  return match !== null && match !== undefined;
}
