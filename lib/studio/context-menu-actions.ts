// lib/studio/context-menu-actions.ts — Chantier B, Tâche 7 : le CHOIX pur des entrées du menu
// contextuel (clic droit), pour une cible et une sélection données. Une feuille au même sens que
// toolbar-actions.ts (Tâche 6, voir son en-tête) : aucun DOM, aucun React, aucune action de
// réducteur — seulement une fonction cible/sélection -> DESCRIPTEURS. Le composant
// (components/studio/canvas-context-menu.tsx) reste seul responsable de deux choses que ce module ne
// fait PAS : l'icône éventuelle et le dispatch (kind -> action de réducteur) — exactement la même
// séparation que floating-toolbar.tsx applique déjà à toolbarActionsFor.
//
// ── POURQUOI CERTAINES ACTIONS PORTENT SUR LA CIBLE SEULE, D'AUTRES SUR LA SÉLECTION ENTIÈRE ───────
// Le brief (task-7-brief.md, "Interfaces & current-code facts") nomme les actions de réducteur
// VERBATIM : « Supprimer -> deleteLayer(id) ; Avancer/Reculer -> reorderLayer(id, toIndex) ;
// Verrouiller/Masquer -> toggleLocked(id)/toggleVisible(id) » — les QUATRE au SINGULIER, comme
// layer-panel.tsx les appelle déjà pour CHAQUE ligne (`dispatch(toggleVisible(layer.id))`,
// `dispatch(toggleLocked(layer.id))`, `dispatch(reorderLayer(layer.id, ...))`,
// `dispatch(deleteLayer(layer.id))` — voir ce fichier) : ce sont des attributs D'UN calque précis,
// pas d'un lot. `targetLayer` (le calque RÉELLEMENT survolé par le clic droit — jamais verrouillé,
// voir la règle de repli U3 dans canvas.tsx) reste donc la cible de ces quatre verbes, MÊME si le
// clic droit a par ailleurs étendu la sélection au groupe entier (canvas.tsx#handleLayerContextMenu).
//
// Copier/Coller/Dupliquer/Grouper/Dégrouper, à l'inverse, sont VERBATIM « the SAME clipboard path as
// ⌘C/⌘V/⌘D » et « setGroup(ids, …) »/« setGroup(members, …) » — au PLURIEL, la même sélection
// résolue que hooks/use-editor-keymap.ts utilise déjà pour ces mêmes raccourcis. Le clic droit ayant
// déjà sélectionné le groupe entier AVANT que ce module ne soit consulté (spec, « right-click selects
// the target first »), `selection` porte ici la MÊME liste que le clavier verrait.
import type { Layer } from "./scene";

export type ContextMenuActionKind =
  | "copy"
  | "paste"
  | "duplicate"
  | "delete"
  | "bringForward"
  | "sendBackward"
  | "lock"
  | "hide"
  | "group"
  | "ungroup"
  | "selectAll";

/** Un descripteur — PAS du JSX, PAS une fonction, même discipline que ToolbarAction
 * (toolbar-actions.ts) : `id === kind` toujours (aucun `kind` n'apparaît deux fois dans un même
 * menu), `label` est le texte affiché, parfois DÉPENDANT de l'état de la cible (`lock`/`hide`,
 * comme `lockLabel` le fait déjà pour la barre flottante). */
export interface ContextMenuAction {
  id: string;
  kind: ContextMenuActionKind;
  label: string;
}

function contextMenuAction(kind: ContextMenuActionKind, label: string): ContextMenuAction {
  return { id: kind, kind, label };
}

// `null` quand grouper/dégrouper n'a pas de sens pour CETTE sélection — EXACTEMENT la même règle que
// toolbar-actions.ts#groupOrUngroup (moins de deux calques -> ni l'un ni l'autre ; tous les calques
// partagent déjà le même `groupId` non nul -> dégrouper ; sinon grouper). Un second littéral de cette
// règle plutôt qu'un import direct de `groupOrUngroup` (non exportée par toolbar-actions.ts, qui ne
// renvoie que la liste COMPLÈTE des actions de LA BARRE, laquelle inclut des verbes — police,
// remplissage… — hors de portée du menu contextuel) : voir task-7-report.md pour la discussion de ce
// choix plutôt que d'élargir la surface exportée d'un module d'une tâche précédente pour un seul
// prédicat.
function groupOrUngroup(selection: readonly Layer[]): ContextMenuAction | null {
  if (selection.length < 2) return null;
  const first = selection[0].groupId;
  const isExistingGroup = !!first && selection.every((l) => l.groupId === first);
  return isExistingGroup
    ? contextMenuAction("ungroup", "Dégrouper")
    : contextMenuAction("group", "Grouper");
}

/**
 * Les entrées du menu contextuel pour un CALQUE (spec §5) — `targetLayer` est le calque
 * RÉELLEMENT ciblé par le clic droit (jamais verrouillé — voir la règle de repli U3), `selection`
 * la sélection RÉSOLUE (déjà étendue au groupe entier si `targetLayer` en a un, canvas.tsx). Ordre :
 * presse-papiers (copier/coller/dupliquer), ordre d'empilement (avancer/reculer), attributs
 * (verrouiller/masquer), groupement (si la sélection compte ≥2 calques), puis supprimer en dernier
 * — même hiérarchie « fréquent d'abord, destructif en dernier » que la barre flottante (T6) applique
 * déjà à `commonActions`.
 */
export function layerContextMenuActions(
  targetLayer: Layer,
  selection: readonly Layer[],
): ContextMenuAction[] {
  const items: ContextMenuAction[] = [
    contextMenuAction("copy", "Copier"),
    contextMenuAction("paste", "Coller"),
    contextMenuAction("duplicate", "Dupliquer"),
    contextMenuAction("bringForward", "Avancer"),
    contextMenuAction("sendBackward", "Reculer"),
    contextMenuAction("lock", targetLayer.locked ? "Déverrouiller" : "Verrouiller"),
    contextMenuAction("hide", targetLayer.visible ? "Masquer" : "Afficher"),
  ];
  const grouping = groupOrUngroup(selection);
  if (grouping) items.push(grouping);
  items.push(contextMenuAction("delete", "Supprimer"));
  return items;
}

/**
 * Les entrées du menu contextuel pour le CANEVAS VIDE (spec §5 verbatim : « paste + select-all
 * only ») — aucune cible, aucune sélection à consulter : toujours les deux mêmes verbes, dans le
 * même ordre que le menu calque (presse-papiers d'abord).
 */
export function canvasContextMenuActions(): ContextMenuAction[] {
  return [contextMenuAction("paste", "Coller"), contextMenuAction("selectAll", "Sélectionner tout")];
}
