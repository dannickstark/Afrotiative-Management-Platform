"use client";

import type { Dispatch } from "react";
import {
  Copy, Trash2, Lock, Unlock, ChevronsUp, ChevronsDown, Group as GroupIcon, Ungroup as UngroupIcon,
  Type as TypeIcon, ALargeSmall, Palette, Bold as BoldIcon, PaintBucket, Square, Replace, Maximize2,
  QrCode, type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Frame, Layer } from "@/lib/studio/scene";
import {
  type EditorAction, addLayers, deleteLayer, toggleLocked, setLayerProps, setLayerProp, reorderLayer,
  setGroup,
} from "@/lib/studio/editor-state";
import { cloneLayersWithNewIds, PASTE_OFFSET } from "@/lib/studio/clipboard";
import { nextGroupId } from "@/lib/studio/groups";
import { toolbarActionsFor, type ToolbarAction, type ToolbarActionKind } from "@/lib/studio/toolbar-actions";

// components/studio/floating-toolbar.tsx — Chantier B, Tâche 6 : la barre contextuelle flottante,
// ancrée AU-DESSUS de la sélection (spec §4). Rendue par canvas.tsx comme un FRÈRE des calques, à
// L'INTÉRIEUR du conteneur mis à l'échelle (`transform: scale(k)`) — jamais un conteneur à côté de
// l'artboard (la leçon de la grille de U1, reprise telle quelle par le contour « liaisons » de U4
// Tâche 6, canvas.tsx:425-496, que ce composant COPIE pour son ancrage).
//
// ── L'ANCRAGE ÉCRAN-CONSTANT, ET POURQUOI IL DIFFÈRE (dans sa MÉCANIQUE, pas son INTENTION) DE
// L'ÉTIQUETTE DE LIAISON ────────────────────────────────────────────────────────────────────────
// L'étiquette de liaison (canvas.tsx) compense CHAQUE propriété individuellement (`fontSize: 10/scale`,
// `padding: 2/scale px`, …) parce qu'elle ne rend que du CSS écrit à la main. Cette barre-ci RÉUTILISE
// `<Button>` (spec brief : « reuse existing components/ui primitives ») — un composant dont TOUTE la
// taille (hauteur, padding, rayon, taille d'icône) vient de classes Tailwind FIXES : diviser chacune de
// ces classes par `scale` à la main est hors de portée (Tailwind n'accepte pas de valeur dynamique par
// prop) sans dupliquer sa feuille de style. La solution ÉQUIVALENTE — UNE SEULE `transform:
// scale(1/scale)` posée sur le sous-arbre entier de la barre — annule exactement le `scale(k)` de
// l'ancêtre pour CE sous-arbre (`k × 1/scale = 1` quand `scale === k`, toujours vrai ici : les deux
// viennent du même prop), donnant à `<Button>` sa taille CSS NOMINALE à l'écran, quel que soit le zoom
// — le même résultat que les divisions manuelles, par un mécanisme différent mais strictement
// équivalent pour un sous-arbre entier plutôt que propriété par propriété.
//
// CE COUNTER-SCALE INTERDIT UN `translateY(-100%)` EN POURCENTAGE (piège vérifié par calcul, pas
// supposé) : un pourcentage dans `transform: translate()` se résout contre la boîte de mise en page de
// l'ÉLÉMENT LUI-MÊME, laquelle est TOUJOURS sa taille *avant* transform (`transform` ne change jamais
// la mise en page, seulement la peinture — CSS Transforms §Terminology) — combiner `translateY(-100%)`
// ET `scale(1/scale)` DANS LE MÊME `transform` sur le MÊME élément donnerait donc un décalage qui NE
// SUIT PAS le zoom (le pourcentage ignore le facteur d'échelle qui l'accompagne dans la même liste),
// et la barre dériverait de son ancrage à mesure que `scale` change. La bonne primitive CSS pour
// « coller le bord bas de la boîte à un point fixe, quelle que soit sa taille visuelle » est `bottom:
// 0` (positionnement de mise en page, PAS un pourcentage de transform) : la mise en page place le bord
// bas EXACTEMENT à l'ancre (elle n'a pas besoin de connaître la taille — c'est tout le sens de
// `bottom`), et `scale(1/scale)` avec `transformOrigin: "0% 100%"` (coin bas-gauche) scale ENSUITE la
// boîte AUTOUR de ce même coin déjà posé pile à l'ancre — le coin bas-gauche reste donc FIXE, immobile,
// quel que soit `scale`, et la barre grandit/rétrécit visuellement à l'écran SANS jamais se décoller de
// son point d'ancrage. `marginBottom: GAP / scale` ajoute l'espacement écran-constant de la même façon
// que le `-4/scale` de l'étiquette de liaison (un pixel local qui, multiplié par `scale` au rendu,
// redonne `GAP` pixels écran).
const GAP = 8;

// pointer-events : voir canvas.tsx (poignées, contour de liaison) — le CONTENEUR de toute surcouche
// posée sur le canevas est `pointer-events: none` (jamais un obstacle au clic/glisser sous elle), et
// SEULS les éléments interactifs (ici : chaque bouton) repassent `pointer-events: auto`. La leçon U4
// nommée par le brief T6 : sans cette discipline, une barre invisible-mais-présente bloquerait le
// canevas sous elle.

const KIND_TO_ICON: Record<Exclude<ToolbarActionKind, "lock">, LucideIcon> = {
  duplicate: Copy,
  delete: Trash2,
  bringForward: ChevronsUp,
  sendBackward: ChevronsDown,
  group: GroupIcon,
  ungroup: UngroupIcon,
  font: TypeIcon,
  fontSize: ALargeSmall,
  color: Palette,
  bold: BoldIcon,
  fill: PaintBucket,
  border: Square,
  replace: Replace,
  fit: Maximize2,
  qrSlot: QrCode,
};

// Les sections REPLIABLES du panneau de propriétés (property-panel.tsx#TypeSection, `sectionId`) que
// chaque action « ouvre un contrôle riche » (police/couleur/remplissage/bordure/source/emplacement QR)
// RACCOURCIT vers — spec §4 : « la barre COMPLÈTE l'inspecteur, elle ne le REMPLACE pas ». v1 (brief
// T6, réserve explicite : « acceptable … to focus/scroll the inspector to that field ») : un simple
// défilement DOM vers la section, SANS rouvrir le panneau ni dupliquer son contrôle ici — aucune
// nouvelle prop, aucun fichier touché en dehors de ceux listés par la tâche (canvas.tsx,
// toolbar-actions.ts, ce fichier). Si la section est repliée, ce défilement l'amène simplement à
// l'écran fermée (l'utilisateur la déplie d'un clic) plutôt que de rien faire du tout.
const KIND_TO_SECTION: Partial<Record<ToolbarActionKind, string>> = {
  font: "police",
  fontSize: "police",
  color: "apparence",
  fill: "remplissage",
  border: "bordure",
  replace: "source",
  qrSlot: "qrcode",
};

export interface FloatingToolbarProps {
  /** Les calques RÉELLEMENT sélectionnés (résolus contre `scene.layers`, jamais des ids bruts) — la
   * même entrée que `toolbarActionsFor` consomme, plus les données dont le dispatch a besoin
   * (calque[0].font/fit pour bold/fit, tous les ids pour dupliquer/verrouiller/grouper). */
  selection: readonly Layer[];
  /** `scene.layers` ENTIER — nécessaire UNIQUEMENT à bringForward/sendBackward pour calculer l'index
   * voisin de chaque calque déplacé (reorderLayer prend un `toIndex`, pas une direction). */
  layers: readonly Layer[];
  /** La boîte englobante de `selection` (groups.ts#groupBounds), en coordonnées GABARIT — le même
   * calcul que le glisser de groupe (T5) et l'alignement (U2 T4) utilisent déjà, jamais une seconde
   * géométrie. */
  bounds: Frame;
  /** LE facteur d'échelle réellement appliqué à l'écran — identique au `scale` de `<Canvas>` (voir
   * son en-tête : « scale — PAS fitScale »). C'est CE nombre, et aucun autre, qui doit annuler le
   * `transform: scale(k)` de l'ancêtre pour que `k × 1/scale === 1`. */
  scale: number;
  dispatch: Dispatch<EditorAction>;
}

export function FloatingToolbar({ selection, layers, bounds, scale, dispatch }: FloatingToolbarProps) {
  const actions = toolbarActionsFor(selection);
  if (actions.length === 0) return null;

  function handleAction(action: ToolbarAction) {
    switch (action.kind) {
      // Dupliquer = EXACTEMENT le geste ⌘D (hooks/use-editor-keymap.ts, case "duplicate") : le MÊME
      // clonage + le MÊME décalage, pour qu'un groupe dupliqué depuis la barre reste un groupe FRAIS
      // et séparé (cloneLayersWithNewIds REMAPPE `groupId`, voir son en-tête) — jamais une seconde
      // implémentation du clonage qui pourrait diverger de celle du clavier.
      case "duplicate": {
        if (selection.length === 0) return;
        dispatch(addLayers(cloneLayersWithNewIds(selection, PASTE_OFFSET)));
        return;
      }
      // AUCUNE action de LOT « supprimer plusieurs calques » n'existe dans le réducteur —
      // `deleteLayer` est SINGULIER (editor-state.ts), et le clavier (Suppr) ne gère lui-même QUE la
      // sélection simple (canvas.tsx, `soleSelectedId`) : rien à réutiliser pour le cas multiple.
      // Décision ASSUMÉE (brief T6 : « do NOT invent one silently ») plutôt que d'ajouter une action
      // de réducteur hors du périmètre de cette tâche : un clic « Supprimer » sur une sélection de N
      // calques dispatche N `deleteLayer`, donc N entrées d'historique (N « annuler » pour tout
      // défaire) — un compromis, pas un oubli, documenté ici et dans le rapport de tâche.
      case "delete": {
        for (const layer of selection) dispatch(deleteLayer(layer.id));
        return;
      }
      // Verrouiller/déverrouiller : une sélection SIMPLE réutilise `toggleLocked` (le geste du
      // panneau de calques, layer-panel.tsx) — une seule entrée d'historique, comme partout ailleurs
      // dans l'éditeur. Une sélection MULTIPLE réutilise `setLayerProps` (Chantier D, Tâche 4 — LE
      // correctif de LOT déjà existant, jamais une boucle de `toggleLocked`) : TOUT le lot converge
      // vers UN SEUL état (verrouillé si un membre au moins ne l'était pas — voir
      // toolbar-actions.ts#lockLabel, la MÊME règle que le libellé affiché), en UNE SEULE entrée.
      case "lock": {
        if (selection.length === 1) { dispatch(toggleLocked(selection[0].id)); return; }
        const allLocked = selection.length > 0 && selection.every((l) => l.locked);
        dispatch(setLayerProps(selection.map((l) => l.id), { locked: !allLocked }));
        return;
      }
      // Avancer/reculer : `reorderLayer(id, toIndex)` (brief T6, verbatim) — SINGULIER lui aussi,
      // comme `deleteLayer` ci-dessus (même compromis assumé, mêmes N entrées pour un lot). Pour une
      // sélection multiple, l'ORDRE de dispatch compte : traiter du calque le plus proche de la
      // DESTINATION vers le plus loin évite que deux calques sélectionnés et ADJACENTS ne
      // s'échangent en boucle au lieu d'avancer ensemble (chacun visant l'index qu'il avait AVANT
      // que ses voisins sélectionnés ne bougent).
      case "bringForward":
      case "sendBackward": {
        const dir = action.kind === "bringForward" ? 1 : -1;
        const ordered = [...selection].sort((a, b) => {
          const ia = layers.findIndex((l) => l.id === a.id);
          const ib = layers.findIndex((l) => l.id === b.id);
          return dir > 0 ? ib - ia : ia - ib;
        });
        for (const layer of ordered) {
          const index = layers.findIndex((l) => l.id === layer.id);
          if (index === -1) continue;
          dispatch(reorderLayer(layer.id, index + dir));
        }
        return;
      }
      // Grouper/dégrouper : `setGroup` (Chantier B, Tâche 5) — le réducteur lui-même refuse déjà un
      // groupe de moins de deux calques résolus (editor-state.ts#"setGroup"), donc aucune garde à
      // dupliquer ici ; `toolbar-actions.ts#groupOrUngroup` n'offre de toute façon ce bouton qu'à
      // partir de deux calques.
      case "group": {
        dispatch(setGroup(selection.map((l) => l.id), nextGroupId()));
        return;
      }
      case "ungroup": {
        dispatch(setGroup(selection.map((l) => l.id), null));
        return;
      }
      // « Gras » : le SEUL raccourci par type qui écrit directement dans la scène — basculer
      // `font.weight` entre 400 et 700 est une décision BINAIRE et sans ambiguïté (contrairement à
      // « quelle police », « quelle taille exacte » ou « quelle couleur »), donc ne demande PAS
      // d'ouvrir l'inspecteur pour avoir un sens. `setLayerProp`, comme le panneau de propriétés.
      case "bold": {
        const layer = selection[0];
        if (!layer || layer.type !== "text") return;
        const nextWeight = layer.font.weight >= 700 ? 400 : 700;
        dispatch(setLayerProp(layer.id, { font: { ...layer.font, weight: nextWeight } }));
        return;
      }
      // « Ajustement » : même raisonnement que « Gras » — cover/contain est un choix BINAIRE, pas un
      // réglage fin (contrairement à « remplacer l'image », qui ouvre un sélecteur d'asset entier).
      case "fit": {
        const layer = selection[0];
        if (!layer || layer.type !== "image") return;
        dispatch(setLayerProp(layer.id, { fit: layer.fit === "cover" ? "contain" : "cover" }));
        return;
      }
      // Police / Taille / Couleur / Remplissage / Bordure / Remplacer / Emplacement QR : chacun
      // ouvrirait un contrôle NON TRIVIAL (sélecteur de police, de couleur, bibliothèque d'assets…)
      // que le panneau de propriétés porte déjà en entier — spec §4 : la barre ne le REMPLACE pas.
      // v1 (voir le commentaire de KIND_TO_SECTION en tête de fichier) : défile jusqu'à la section
      // correspondante si elle est déjà montée dans le DOM ; sans effet sinon (aucune erreur, aucune
      // mutation de scène).
      case "font": case "fontSize": case "color": case "fill": case "border": case "replace": case "qrSlot": {
        const sectionId = KIND_TO_SECTION[action.kind];
        if (!sectionId) return;
        document.querySelector(`[data-section="${sectionId}"]`)?.scrollIntoView?.({ block: "nearest" });
        return;
      }
    }
  }

  return (
    <div
      data-testid="floating-toolbar"
      // Chantier E Tâche 4 : `studio-motion-pop` (globals.css) posée ICI, sur l'ANCRE 0×0 — jamais
      // sur le sous-arbre intérieur, qui porte déjà son propre `transform: scale(1/scale)` ESSENTIEL
      // (le counter-scale documenté en tête de fichier). Poser l'animation sur ce même élément
      // animerait la propriété CSS `transform` par-dessus ce style en ligne PENDANT toute la durée du
      // pop (les keyframes l'emportent sur l'inline), corrompant le counter-scale le temps de
      // l'apparition. Cette ancre-ci ne porte AUCUN `transform` inline — animer `transform` dessus
      // (0.96 -> aucun) ne touche donc RIEN d'existant, et se termine SANS saut visuel (l'état final
      // des keyframes, « aucun transform », est EXACTEMENT l'état non-animé). Coupé sous
      // `prefers-reduced-motion: reduce` (globals.css) ; additif — AUCUNE géométrie ci-dessous ne
      // change (§0 du plan).
      className="studio-motion-pop"
      style={{ position: "absolute", left: bounds.x, top: bounds.y, width: 0, height: 0, pointerEvents: "none" }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          bottom: 0,
          marginBottom: GAP / scale,
          transform: `scale(${1 / scale})`,
          transformOrigin: "0% 100%",
          pointerEvents: "auto",
          display: "flex",
          alignItems: "center",
          gap: 2,
          background: "#18181b",
          padding: 4,
          borderRadius: 8,
          boxShadow: "0 4px 16px rgba(0,0,0,0.28)",
          whiteSpace: "nowrap",
        }}
      >
        {actions.map((action) => {
          const Icon = action.kind === "lock"
            ? (action.label === "Déverrouiller" ? Unlock : Lock)
            : KIND_TO_ICON[action.kind];
          return (
            <Button
              key={action.id}
              type="button"
              variant="ghost"
              size="icon-sm"
              data-action={action.kind}
              title={action.label}
              aria-label={action.label}
              className="text-white hover:bg-white/15 hover:text-white"
              onClick={() => handleAction(action)}
            >
              <Icon />
            </Button>
          );
        })}
      </div>
    </div>
  );
}
