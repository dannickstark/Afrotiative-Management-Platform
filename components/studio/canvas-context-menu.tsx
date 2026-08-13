"use client";

// components/studio/canvas-context-menu.tsx — Chantier B, Tâche 7 : le menu contextuel du clic
// droit — copier/coller/dupliquer, ordre d'empilement, verrouiller/masquer, grouper/dégrouper,
// supprimer sur un calque ; coller/sélectionner-tout sur le canevas vide (spec §5).
//
// ── POURQUOI CE FICHIER, PAS canvas.tsx, PORTE LE COMPOSANT base-ui (LE MANDAT DE CONCEPTION DE LA
// TÂCHE) ──────────────────────────────────────────────────────────────────────────────────────────
// Voir l'INCIDENT documenté en tête de components/ui/context-menu.tsx et de
// tests/studio-no-popover-in-canvas.test.ts : un import STATIQUE de la famille Portal/Positioner
// base-ui (Popover, Select, Menu — tous construits sur le même `useIsoLayoutEffect`) dans l'arbre
// d'import de `canvas.tsx` gèle ce hook en no-op pour le reste du process `bun test` (sans
// `--isolate`), et fait SILENCIEUSEMENT tomber trois tests comportementaux d'un AUTRE fichier. Ce
// composant-ci importe `@/components/ui/context-menu` (donc `@base-ui/react/menu`) — il est donc
// rendu par `components/studio/editor-shell.tsx` (déjà dans l'arbre base-ui-lourd via
// dropdown-menu.tsx pour le menu de zoom), JAMAIS par `canvas.tsx` lui-même. `canvas.tsx` ne
// connaît que la forme `CanvasContextMenuPayload` — définie LOCALEMENT là-bas (jamais importée
// d'ici, voir son en-tête) — et une prop-callback `onContextMenu`.
//
// ── SÉPARATION PUR/COMPOSANT (même discipline que floating-toolbar.tsx + toolbar-actions.ts) ───────
// `lib/studio/context-menu-actions.ts` calcule QUELLES entrées afficher (aucun DOM) ; CE fichier
// décide seul de l'ICÔNE (aucune ici — le menu contextuel est du texte, pas d'icônes, contrairement
// à la barre flottante compacte) et du DISPATCH (kind -> action de réducteur).
import { Fragment, type Dispatch } from "react";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import type { EditorAction } from "@/lib/studio/editor-state";
import {
  addLayers, deleteLayer, reorderLayer, toggleLocked, toggleVisible, setGroup, selectMany,
} from "@/lib/studio/editor-state";
import { cloneLayersWithNewIds, copyToClipboard, readClipboard, PASTE_OFFSET } from "@/lib/studio/clipboard";
import { nextGroupId, expandSelectionToGroups } from "@/lib/studio/groups";
import { layerContextMenuActions, canvasContextMenuActions, type ContextMenuAction } from "@/lib/studio/context-menu-actions";
import type { Layer, Scene } from "@/lib/studio/scene";

export interface CanvasContextMenuProps {
  /** Piloté par editor-shell.tsx — `false` ne démonte PAS le composant en cours de fermeture (base-ui
   * gère sa propre transition), mais empêche toute REconstruction du contenu tant qu'aucun nouveau
   * clic droit n'a eu lieu (voir `anchor`/`targetLayerId`, qui restent la DERNIÈRE valeur connue). */
  open: boolean;
  /** Le point ÉCRAN (`e.clientX`/`e.clientY`) où ancrer le menu — voir canvas.tsx#CanvasContextMenuPayload.
   * `null` seulement avant le tout premier clic droit de la session (aucun menu n'a jamais eu de
   * quoi s'ancrer) : ce composant rend alors `null`, jamais un menu ancré à (0,0). */
  anchor: { x: number; y: number } | null;
  /** L'id du calque ciblé — `null` pour le clic droit sur le canevas VIDE (spec §5) OU pour un clic
   * droit qui est retombé sur le canevas via la règle de repli U3 (calque verrouillé, voir
   * canvas.tsx). Jamais l'id d'un calque verrouillé (la même règle empêche ce cas d'exister). */
  targetLayerId: string | null;
  scene: Scene;
  /** La sélection COURANTE, déjà résolue par canvas.tsx AVANT l'ouverture du menu (le clic droit
   * sélectionne la cible EN PREMIER — spec — donc au moment où ce composant s'ouvre, `selectedIds`
   * porte déjà le groupe entier si `targetLayerId` en désigne un). */
  selectedIds: string[];
  dispatch: Dispatch<EditorAction>;
  onOpenChange: (open: boolean) => void;
}

/** Un ancre VIRTUEL (`@base-ui/react/menu`, voir components/ui/context-menu.tsx) — un point sans
 * dimension, jamais un `Element` du DOM réel. `ClientRectObject` (floating-ui) n'exige QUE ces huit
 * champs numériques, jamais une vraie instance de `DOMRect` : cette forme littérale reste valide
 * dans n'importe quel environnement (SSR, jsdom sans stub `DOMRect` global), contrairement à
 * `new DOMRect(...)`. */
function virtualAnchorAt(point: { x: number; y: number }) {
  return {
    getBoundingClientRect: () => ({
      x: point.x, y: point.y, width: 0, height: 0,
      top: point.y, left: point.x, right: point.x, bottom: point.y,
    }),
  };
}

export function CanvasContextMenu({
  open, anchor, targetLayerId, scene, selectedIds, dispatch, onOpenChange,
}: CanvasContextMenuProps) {
  if (!anchor) return null;

  const targetLayer = targetLayerId ? scene.layers.find((l) => l.id === targetLayerId) ?? null : null;
  const selection = scene.layers.filter((l) => selectedIds.includes(l.id));
  const actions = targetLayer
    ? layerContextMenuActions(targetLayer, selection)
    : canvasContextMenuActions();

  function handleAction(action: ContextMenuAction) {
    switch (action.kind) {
      // Copier/Coller/Dupliquer — LE MÊME chemin presse-papiers que ⌘C/⌘V/⌘D
      // (hooks/use-editor-keymap.ts) : `selection` ici est la sélection RÉSOLUE contre la scène,
      // exactement ce que `selectedLayers(current)` calcule là-bas — jamais un second clonage qui
      // pourrait diverger de celui du clavier (un groupe dupliqué reste un groupe FRAIS et séparé,
      // `cloneLayersWithNewIds` remappe `groupId` — voir son en-tête, lib/studio/clipboard.ts).
      case "copy": {
        if (selection.length === 0) return;
        copyToClipboard(selection);
        return;
      }
      case "paste": {
        const clipped = readClipboard();
        if (clipped.length === 0) return; // presse-papiers vide -> no-op, AUCUN dispatch (même garde
        // que hooks/use-editor-keymap.ts#case "paste").
        dispatch(addLayers(cloneLayersWithNewIds(clipped, PASTE_OFFSET)));
        return;
      }
      case "duplicate": {
        if (selection.length === 0) return;
        dispatch(addLayers(cloneLayersWithNewIds(selection, PASTE_OFFSET)));
        return;
      }
      // Supprimer/Avancer/Reculer/Verrouiller/Masquer — LA CIBLE seule (voir l'en-tête de
      // lib/studio/context-menu-actions.ts pour pourquoi : ce sont des attributs D'UN calque, la
      // MÊME granularité que layer-panel.tsx applique déjà à chacune de ces quatre actions).
      case "delete": {
        if (!targetLayer) return;
        dispatch(deleteLayer(targetLayer.id));
        return;
      }
      case "bringForward":
      case "sendBackward": {
        if (!targetLayer) return;
        const index = scene.layers.findIndex((l) => l.id === targetLayer.id);
        if (index === -1) return;
        const dir = action.kind === "bringForward" ? 1 : -1;
        dispatch(reorderLayer(targetLayer.id, index + dir));
        return;
      }
      case "lock": {
        if (!targetLayer) return;
        dispatch(toggleLocked(targetLayer.id));
        return;
      }
      case "hide": {
        if (!targetLayer) return;
        dispatch(toggleVisible(targetLayer.id));
        return;
      }
      // Grouper/Dégrouper — `setGroup` (Chantier B, Tâche 5), sur la SÉLECTION entière : le réducteur
      // refuse déjà un groupe de moins de deux calques résolus (editor-state.ts#"setGroup"), et
      // `layerContextMenuActions` n'offre de toute façon ce bouton qu'à partir de deux calques (même
      // garde que toolbar-actions.ts#groupOrUngroup).
      case "group": {
        dispatch(setGroup(selection.map((l) => l.id), nextGroupId()));
        return;
      }
      case "ungroup": {
        const ids = expandSelectionToGroups(selectedIds, scene);
        if (ids.length === 0) return;
        dispatch(setGroup(ids, null));
        return;
      }
      // Sélectionner tout — le menu du canevas VIDE (spec §5), même verbe que ⌘A
      // (hooks/use-editor-keymap.ts#case "selectAll").
      case "selectAll": {
        dispatch(selectMany(scene.layers.map((l) => l.id)));
        return;
      }
    }
  }

  return (
    <ContextMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <ContextMenuContent
        data-testid="canvas-context-menu"
        anchor={virtualAnchorAt(anchor)}
        side="bottom"
        align="start"
        sideOffset={0}
      >
        {actions.map((action, i) => (
          <Fragment key={action.id}>
            {/* Séparateur avant Grouper/Dégrouper ET avant Supprimer (spec, hiérarchie « fréquent
                d'abord, destructif en dernier » — voir l'en-tête de layerContextMenuActions) : ni
                l'un ni l'autre devant la toute première entrée. */}
            {i > 0 && (action.kind === "group" || action.kind === "ungroup" || action.kind === "delete") && (
              <ContextMenuSeparator />
            )}
            <ContextMenuItem
              data-testid={`context-menu-${action.kind}`}
              data-action={action.kind}
              variant={action.kind === "delete" ? "destructive" : "default"}
              onClick={() => handleAction(action)}
            >
              {action.label}
            </ContextMenuItem>
          </Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
