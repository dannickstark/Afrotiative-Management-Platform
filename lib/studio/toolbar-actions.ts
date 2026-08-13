// lib/studio/toolbar-actions.ts — Chantier B, Tâche 6 : le CHOIX pur des actions de la barre
// contextuelle flottante, pour une sélection donnée. Une feuille au même sens que groups.ts/align.ts
// avant elle (voir leurs en-têtes) : aucun DOM, aucun React, aucune action de réducteur — seulement
// une fonction sélection -> DESCRIPTEURS. Le composant (components/studio/floating-toolbar.tsx) est
// seul responsable de deux choses que ce module ne fait PAS : l'icône (kind -> icône lucide) et le
// dispatch (kind -> action de réducteur). Séparer les deux est ce qui rend cette fonction testable
// sans DOM (spec brief, Étape 1) — exactement la même discipline que shape-gallery.ts sépare la
// LISTE des formes (SHAPE_KINDS, scene.ts) de leur RENDU en tuile.
import type { Layer } from "./scene";

/**
 * Les seize verbes que la barre contextuelle peut proposer (spec §4) — communs à toute sélection non
 * vide (sept premiers), ou propres à UN type de calque (les neuf suivants, jamais mélangés : voir
 * `toolbarActionsFor`).
 */
export type ToolbarActionKind =
  | "duplicate"
  | "delete"
  | "lock"
  | "bringForward"
  | "sendBackward"
  | "group"
  | "ungroup"
  | "font"
  | "fontSize"
  | "color"
  | "bold"
  | "fill"
  | "border"
  | "replace"
  | "fit"
  | "qrSlot";

/** Un descripteur — PAS du JSX, PAS une fonction : `id` distingue deux actions du même `kind` si un
 *  jour ce module en proposait plusieurs (aucun cas aujourd'hui, `id === kind` toujours), `label` est
 *  le texte affiché (parfois DÉPENDANT de l'état de la sélection, voir `lockLabel` plus bas — « Verrouiller »
 *  contre « Déverrouiller » n'est pas une chaîne statique). */
export interface ToolbarAction {
  id: string;
  kind: ToolbarActionKind;
  label: string;
}

function toolbarAction(kind: ToolbarActionKind, label: string): ToolbarAction {
  return { id: kind, kind, label };
}

// Verrouiller/déverrouiller un LOT mélangé (certains verrouillés, d'autres non) bascule vers
// « tout verrouiller » — le même choix que la case à cocher « indéterminée » des interfaces de
// référence : un clic sur un état mixte converge d'abord vers UN état plein, jamais vers un mélange
// encore différent. `Déverrouiller` n'apparaît donc que si la sélection ENTIÈRE est déjà verrouillée.
function lockLabel(selection: readonly Layer[]): string {
  return selection.length > 0 && selection.every((l) => l.locked) ? "Déverrouiller" : "Verrouiller";
}

// LE SOCLE commun à TOUTE sélection non vide, quel que soit le type de calque (spec §4). Aucune garde
// de faisabilité ici (un calque déjà au sommet de la pile, un calque verrouillé qu'on voudrait
// dupliquer…) : ce sont des questions de RENDU (bouton grisé) ou de DISPATCH (le réducteur refuse
// déjà silencieusement un geste sans effet, editor-state.ts), jamais de la liste renvoyée ici — même
// séparation que `groupBounds` (groups.ts) laisse à son appelant la question « ce groupe a-t-il un
// sens » plutôt que de refuser de calculer une boîte.
function commonActions(selection: readonly Layer[]): ToolbarAction[] {
  return [
    toolbarAction("duplicate", "Dupliquer"),
    toolbarAction("delete", "Supprimer"),
    toolbarAction("lock", lockLabel(selection)),
    toolbarAction("bringForward", "Avancer"),
    toolbarAction("sendBackward", "Reculer"),
  ];
}

// Les actions PROPRES à UN calque, par son type (spec §4 verbatim) :
//   texte -> police/taille/couleur/gras ; forme -> remplissage/bordure ; image -> remplacer/ajustement ;
//   QR -> emplacement. Chaque branche est délibérément COURTE et n'ouvre RIEN elle-même (pas de
// sélecteur de couleur ici, pas de bibliothèque d'assets) : la barre RACCOURCIT vers le panneau de
// propriétés, elle ne le REMPLACE pas (spec §4, contrainte revue) — voir floating-toolbar.tsx pour ce
// que chaque `kind` déclenche réellement au clic.
function perTypeActions(layer: Layer): ToolbarAction[] {
  switch (layer.type) {
    case "text":
      return [
        toolbarAction("font", "Police"),
        toolbarAction("fontSize", "Taille"),
        toolbarAction("color", "Couleur"),
        toolbarAction("bold", "Gras"),
      ];
    case "shape":
      return [
        toolbarAction("fill", "Remplissage"),
        toolbarAction("border", "Bordure"),
      ];
    case "image":
      return [
        toolbarAction("replace", "Remplacer"),
        toolbarAction("fit", "Ajustement"),
      ];
    case "qr":
      return [toolbarAction("qrSlot", "Emplacement QR")];
  }
}

// `null` quand grouper/dégrouper n'a pas de sens pour CETTE sélection : moins de deux calques —
// grouper un calque seul ne veut rien dire, et editor-state.ts#setGroup refuse déjà ce cas côté
// réducteur (spec §6, « needs ≥2 to be meaningful »), donc ce module n'offre même pas le bouton.
// Sinon : DÉGROUPER si TOUS les calques sélectionnés partagent déjà le MÊME `groupId` non nul —
// exactement la sélection qu'un clic sur un membre produit (canvas.tsx#expandSelectionToGroups) ;
// GROUPER dans tous les autres cas (sélection multiple ad hoc au Maj-clic, ou plusieurs groupes
// mélangés par un ⌘A par exemple) — jamais les deux à la fois.
function groupOrUngroup(selection: readonly Layer[]): ToolbarAction | null {
  if (selection.length < 2) return null;
  const first = selection[0].groupId;
  const isExistingGroup = !!first && selection.every((l) => l.groupId === first);
  return isExistingGroup ? toolbarAction("ungroup", "Dégrouper") : toolbarAction("group", "Grouper");
}

/**
 * L'ensemble des actions de la barre contextuelle pour `selection` (spec §4) :
 *
 *  - VIDE -> `[]` — aucune barre à ancrer sur rien (§0 : sans sélection, le canevas reste inchangé).
 *  - UN SEUL calque -> ses actions PROPRES AU TYPE (perTypeActions) PUIS le socle commun — jamais
 *    grouper/dégrouper (`groupOrUngroup` renvoie `null` pour une sélection d'un seul calque).
 *  - PLUSIEURS calques -> UNIQUEMENT le socle commun (+ grouper/dégrouper) : AUCUNE action par type,
 *    même quand tous les calques sélectionnés partagent le même type — des actions par type
 *    resteraient plausibles pour « trois textes sélectionnés », mais deviennent AMBIGUËS dès qu'un
 *    seul calque diffère (« Gras » sur un calque forme ?), et cette fonction ne peut pas distinguer
 *    les deux cas sans se fier à un détail d'implémentation fragile — elle applique donc la même
 *    règle, simple et prévisible, aux deux : jamais d'action par type au pluriel.
 */
export function toolbarActionsFor(selection: readonly Layer[]): ToolbarAction[] {
  if (selection.length === 0) return [];

  const common = commonActions(selection);
  const grouping = groupOrUngroup(selection);
  if (grouping) common.push(grouping);

  if (selection.length === 1) return [...perTypeActions(selection[0]), ...common];
  return common;
}
