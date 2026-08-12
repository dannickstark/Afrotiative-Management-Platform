"use client";

import type { Dispatch } from "react";
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical,
  AlignHorizontalDistributeCenter, AlignStartHorizontal, AlignStartVertical,
  AlignVerticalDistributeCenter, type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Layer, Scene } from "@/lib/studio/scene";
import {
  ALIGN_MODES, DISTRIBUTE_AXES, alignParticipants, planAlign, planDistribute,
  type AlignMode, type DistributeAxis,
} from "@/lib/studio/align";
import { setFrames, type EditorAction } from "@/lib/studio/editor-state";
import { FORMAT_PRESETS, type FormatKey } from "@/lib/studio/formats";
// U3 Tâche 3 : la rotation d'une forme est une propriété de sa DESCRIPTION (arbitrage A) — ce
// composant la demande, il ne la déduit ni d'une liste de noms ni du type de calque.
import { layerRotation, layerSupportsRotation, shapeLabel } from "@/lib/studio/shapes";
import { NumberField, type Patch } from "./property-fields";
// Chantier D, Tâche 4 : le widget d'ancrage par côté — voir le commentaire juste avant `GeometryStrip`
// ci-dessous, sur la place que U1 avait laissée pour lui.
import { ConstraintsField } from "./constraints-field";

// components/studio/geometry-strip.tsx — Tâche 6 (U1, spec §6) : les six champs de cadre (X, Y,
// largeur, hauteur, rotation, opacité) extraits de l'ancienne section « Cadre » de property-panel.tsx
// (qui la fermait en dernier, APRÈS Texte/Police/Apparence/Ombre/Contour pour un calque texte — le
// défaut que cette tâche corrige) pour former une bande ÉPINGLÉE, rendue par PropertyPanel HORS de
// son conteneur défilant (voir property-panel.tsx#PropertyPanel, le div `data-testid="property-
// sections"` porte seul `overflow-auto` ; celui-ci n'en porte aucun). Un designer qui vient nudger
// une position n'a donc plus besoin de défiler devant treize autres contrôles pour l'atteindre.
//
// Ne réutilise QUE `NumberField` et le callback `patch` — aucune primitive de champ n'est recréée
// ici (consigne de la Tâche 6 : une réorganisation, pas une réécriture des contrôles). Correctif
// revue finale (Minor) : les deux vivent désormais dans property-fields.tsx, une feuille commune
// que property-panel.tsx importe ÉGALEMENT — ce fichier n'importe donc plus rien de property-panel.tsx
// et le cycle d'imports qui existait auparavant entre les deux (property-panel.tsx -> ce fichier ->
// property-panel.tsx, inoffensif seulement parce que `NumberField` était une déclaration de fonction
// hissée) a disparu structurellement, pas seulement par chance d'ordre d'évaluation.
export interface GeometryStripProps {
  layer: Layer;
  patch: Patch;
  // Tâche 4 (U2, spec §4) : la rangée aligner/répartir raisonne sur la SCÈNE (le plan de travail comme
  // référence, les cadres des autres calques sélectionnés) et dispatche elle-même son lot — elle ne
  // peut donc pas passer par `patch`, qui ne sait éditer QUE le calque courant.
  scene: Scene;
  selectedIds: readonly string[];
  dispatch: Dispatch<EditorAction>;
  // Chantier D, Tâche 3 — la note « texte contraint qui déborde maxLines » ci-dessous a besoin de
  // savoir (a) si ÇA DÉBORDE et (b) DANS QUEL FORMAT, mais ne peut pas le calculer ELLE-MÊME :
  // `constrainedTextOverflows` (lib/studio/relayout-warn.ts) fait un VRAI rendu satori pour mesurer
  // le nombre de lignes, ce qui tire `lib/studio/fonts.ts` (`node:fs/promises`) — importer QUOI QUE
  // CE SOIT depuis ce module dans CE composant "use client" ferait planter Turbopack en le tirant
  // dans le bundle navigateur (même piège déjà documenté dans components/studio/asset-picker.tsx :
  // « the chunking context (unknown) does not support external modules »). L'appelant (ou, pour
  // l'instant, le test) calcule donc `constrainedTextOverflows` de son côté et fournit le résultat —
  // absent ou faux, aucune note ; jamais de mensonge par défaut optimiste.
  textOverflowsMaxLines?: boolean;
  /** Le format pour lequel `textOverflowsMaxLines` a été mesuré — sert UNIQUEMENT à nommer ce format
   * dans la note ; ne pilote PAS sa condition d'affichage (déjà tranchée par `textOverflowsMaxLines`,
   * qui encode déjà « pour ce format-là »). */
  previewFormat?: FormatKey;
}

/**
 * Chantier D, Tâche 3 — LE texte exact de la note « texte contraint qui déborde maxLines », extrait
 * en fonction PURE (plutôt que composé en JSX multi-lignes) pour deux raisons : (1) le contenu JSX
 * réparti sur plusieurs lignes se voit collapsé par des règles d'espacement peu prévisibles, ce qui
 * aurait rendu une assertion d'ÉGALITÉ EXACTE contre `.textContent` fragile pour de mauvaises
 * raisons ; (2) tests/studio-geometry-strip.test.ts peut ainsi affirmer l'égalité de la vraie
 * propriété accessible contre CETTE fonction plutôt que contre une chaîne recopiée à la main qui
 * pourrait dériver du composant sans qu'aucun test ne le remarque.
 */
export function maxLinesOverflowNote(maxLines: number, previewFormat?: FormatKey): string {
  const formatPart = previewFormat ? ` dans « ${FORMAT_PRESETS[previewFormat].label} »` : "";
  const linePart = maxLines > 1 ? "lignes" : "ligne";
  return `Texte contraint en largeur : le retour à la ligne change${formatPart} et dépasse la limite de ${maxLines} ${linePart} posée sur ce calque — le surplus sera coupé au rendu (maxLines).`;
}

// La place que U1 avait laissée ici (spec §6 : « U2 ajoutera ici une rangée align/distribute une fois
// la sélection multiple disponible ») est désormais occupée par `AlignRow`, en TROISIÈME rangée. La
// place que U1 réservait ensuite (« U5 y ajoutera le widget d'ancrage par côté ») est occupée depuis
// le chantier D, Tâche 4, par `ConstraintsField` (constraints-field.tsx) — en QUATRIÈME rangée, sous
// `AlignRow` : aligner/répartir agit sur les cadres bruts (Tâche 4, U2) alors que l'ancrage gouverne
// leur comportement à travers un changement de FORMAT (chantier D) — deux notions liées mais
// distinctes, chacune sa rangée plutôt que fondues en une seule.
export function GeometryStrip({
  layer, patch, scene, selectedIds, dispatch, textOverflowsMaxLines, previewFormat,
}: GeometryStripProps) {
  // U3 Tâche 3 : la rotation est-elle PEINTE pour ce calque ? Faux uniquement pour une forme découpée
  // (arbitrage A) — un texte, une image, un QR, un rectangle, une ellipse ou une ligne tournent tous.
  const tourne = layerSupportsRotation(layer);
  return (
    <div className="space-y-2 border-b p-3" data-testid="geometry-strip">
      <div className="grid grid-cols-4 gap-2">
        <NumberField label="X" value={layer.frame.x} dataField="frame.x" onCommit={(v) => patch({ frame: { ...layer.frame, x: v } })} />
        <NumberField label="Y" value={layer.frame.y} dataField="frame.y" onCommit={(v) => patch({ frame: { ...layer.frame, y: v } })} />
        <NumberField
          label="Largeur" value={layer.frame.w} min={1} dataField="frame.w"
          onCommit={(v) => patch({ frame: { ...layer.frame, w: Math.max(1, v) } })}
        />
        <NumberField
          label="Hauteur" value={layer.frame.h} min={1} dataField="frame.h"
          onCommit={(v) => patch({ frame: { ...layer.frame, h: Math.max(1, v) } })}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {/* U3 Tâche 3 (arbitrage A) : une forme DÉCOUPÉE ne tourne pas — satori tourne le remplissage
            mais pas le masque (réserve 2 de la sonde, mesurée en pixels), et les deux chemins de rendu
            suppriment donc la `transform` (lib/studio/shapes.ts#layerRotation). Le contrôle est grisé
            plutôt que laissé actif-sans-effet, avec la note ci-dessous : « interdire en le disant vaut
            mieux qu'autoriser sans effet », le verdict qu'a déjà rendu la revue de U2 deux fois. La
            question est posée à la DESCRIPTION de la forme, jamais à une liste de noms en dur. */}
        <NumberField
          label="Rotation (°)" value={layer.rotation ?? 0} dataField="rotation" disabled={!tourne}
          onCommit={(v) => patch({ rotation: v || undefined })}
        />
        <NumberField
          label="Opacité (0–1)" value={layer.opacity ?? 1} step={0.05} min={0} max={1} dataField="opacity"
          onCommit={(v) => patch({ opacity: Math.min(1, Math.max(0, v)) })}
        />
      </div>
      {/* Tâche 5 (U2, spec §5) — la LIMITE D'ACCROCHAGE d'un calque pivoté, dite plutôt que laissée à
          découvrir (verdict de la revue de la Tâche 5 : « la fonctionnalité meurt en silence », et la
          Tâche 4 avait établi le précédent juste en dessous avec sa note de rotation). Mêmes règles de
          ton et de placement que cette note-là : un `<p>` discret, dans la bande de géométrie, et
          UNIQUEMENT quand le calque est RÉELLEMENT pivoté — un avertissement permanent ne serait plus lu.
          Placé ICI plutôt que dans `AlignRow` parce que c'est le calque MANIPULÉ qui est concerné : la
          bande n'est rendue que pour une sélection SIMPLE, c'est-à-dire exactement le cas où le calque
          porte ses poignées et peut donc être redimensionné.
          Les DEUX moitiés sont dites, sans arrondir l'angle : l'accrochage est désactivé pendant un
          redimensionnement (lib/studio/snap.ts, décision 3 — « accrocher le bord est » n'a plus de
          référent dès que le calque tourne), et pendant un DÉPLACEMENT il fonctionne mais les guides
          marquent le cadre non pivoté, pas le contour visible (mesuré : 6,82 px d'écart à 45° sur un
          calque 200×150). */}
      {/* U3 Tâche 3 — la note qui accompagne le contrôle grisé. Elle NOMME la forme (le libellé
          français de sa description, jamais sa clé technique) et dit la raison, pas seulement
          « indisponible » : c'est le format des deux précédents de U2 (`snap-rotation-note` juste en
          dessous, `safe-areas-none` dans canvas-chrome.tsx). Elle n'apparaît que pour les formes
          concernées — un avertissement permanent ne serait plus lu. */}
      {!tourne && layer.type === "shape" && (
        <p className="text-[11px] text-muted-foreground" data-testid="shape-rotation-none">
          La forme «&nbsp;{shapeLabel(layer.shape)}&nbsp;» est dessinée par un découpage
          (<code>clip-path</code>) : le moteur d&rsquo;export ne fait pas tourner un découpage, donc la
          rotation est désactivée ici plutôt qu&rsquo;appliquée à l&rsquo;écran sans se retrouver dans
          l&rsquo;image exportée. Un rectangle, une ellipse ou une ligne tournent, eux.
        </p>
      )}
      {/* `tourne &&` (U3 Tâche 3) : sur une forme découpée portant un `rotation` résiduel — scène
          écrite avant cette tâche, import, ou conversion depuis un rectangle pivoté — cette note
          serait fausse deux fois (le calque n'est pas pivoté à l'écran, et l'accrochage n'est pas
          désactivé). C'est la note ci-dessus qui s'affiche alors.
          LA SECONDE MOITIÉ EST DÉSORMAIS VRAIE, ET TESTÉE (revue de la Tâche 3, Important 1) : quand
          elle a été écrite, elle ne l'était pas — `begin()` (hooks/use-layer-drag.ts) lisait encore
          `layer.rotation` brut, et `snapResize` renonce dès que `rotationDeg !== 0`
          (lib/studio/snap.ts). Le geste lit maintenant `layerRotation(layer)`, la rotation PEINTE, et
          tests/studio-property-panel.test.ts (« la PRÉMISSE du masquage est vraie ») relie cette note
          au comportement réel du moteur de geste, dans les deux sens. */}
      {tourne && (layer.rotation ?? 0) !== 0 && (
        <p className="text-[11px] text-muted-foreground" data-testid="snap-rotation-note">
          Calque pivoté : l&rsquo;accrochage est désactivé pendant un redimensionnement ; pendant un
          déplacement, les guides marquent le cadre non pivoté (X, Y, largeur, hauteur), pas le
          contour visible à l&rsquo;écran.
        </p>
      )}
      {/* Chantier D, Tâche 3 — « un calque texte contraint en largeur change de largeur RÉELLE quand
          le format change → son retour à la ligne change AUSSI → s'il porte `maxLines`, ce nouveau
          retour à la ligne peut déborder et être coupé au rendu » (brief). MÊME ton, MÊME placement
          que les notes de rotation ci-dessus : un `<p>` discret, dans la bande de géométrie,
          UNIQUEMENT quand la condition est RÉELLEMENT vraie — `textOverflowsMaxLines` encode déjà
          « calque texte, contrainte en largeur (leftRight/scale), ET débordement mesuré au rendu
          pour `previewFormat` » (lib/studio/relayout-warn.ts#constrainedTextOverflows) ; ce composant
          ne fait QUE l'afficher, jamais ne le recalcule ni ne l'approxime — voir le commentaire de
          `textOverflowsMaxLines` sur GeometryStripProps pour la frontière "use client" qui l'impose.
          `layer.type === "text"` en garde supplémentaire : un appelant qui fournirait ce prop pour un
          calque non-texte (bogue amont) ne doit jamais faire apparaître une note qui parle de son
          `maxLines`, un champ que ce calque ne porte même pas. */}
      {layer.type === "text" && textOverflowsMaxLines && layer.maxLines !== undefined && (
        <p className="text-[11px] text-muted-foreground" data-testid="text-maxlines-overflow-note">
          {maxLinesOverflowNote(layer.maxLines, previewFormat)}
        </p>
      )}
      <AlignRow scene={scene} selectedIds={selectedIds} dispatch={dispatch} />
      <ConstraintsField layer={layer} patch={patch} selectedIds={selectedIds} dispatch={dispatch} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tâche 4 (U2, spec §4) — aligner et répartir.
//
// Toute la géométrie vit dans lib/studio/align.ts (module PUR, testé avec des littéraux) et tout
// l'historique dans l'action `setFrames` du réducteur (UN lot = UNE entrée d'annulation). Ce composant
// ne fait donc que trois choses : compter les PARTICIPANTS pour savoir quels boutons sont actionnables,
// nommer la référence dans l'infobulle, et dispatcher le lot. Aucun calcul de cadre ici — c'est
// délibéré : une deuxième implémentation de la boîte englobante côté interface serait une occasion de
// dériver du module testé.
//
// Rendu à DEUX endroits (property-panel.tsx) : en troisième rangée de la bande de géométrie pour une
// sélection simple, et seule au-dessus du message honnête pour une sélection multiple — le seul
// contrôle du panneau qui ait un sens à plus d'un calque.
export interface AlignRowProps {
  scene: Scene;
  selectedIds: readonly string[];
  dispatch: Dispatch<EditorAction>;
  className?: string;
}

// `Record<AlignMode, …>` indexé par la liste canonique ALIGN_MODES : ajouter un mode dans
// lib/studio/align.ts sans lui donner de bouton ici ne COMPILE PAS (même garde de complétude que
// SHAPE_KINDS pour le panneau Éléments), plutôt que de le laisser inaccessible en silence.
const ALIGN_BUTTONS: Record<AlignMode, { label: string; Icon: LucideIcon }> = {
  left: { label: "Aligner à gauche", Icon: AlignStartVertical },
  hcenter: { label: "Centrer horizontalement", Icon: AlignCenterVertical },
  right: { label: "Aligner à droite", Icon: AlignEndVertical },
  top: { label: "Aligner en haut", Icon: AlignStartHorizontal },
  vmiddle: { label: "Centrer verticalement", Icon: AlignCenterHorizontal },
  bottom: { label: "Aligner en bas", Icon: AlignEndHorizontal },
};

const DISTRIBUTE_BUTTONS: Record<DistributeAxis, { label: string; Icon: LucideIcon }> = {
  horizontal: { label: "Répartir horizontalement (écarts égaux)", Icon: AlignHorizontalDistributeCenter },
  vertical: { label: "Répartir verticalement (écarts égaux)", Icon: AlignVerticalDistributeCenter },
};

export function AlignRow({ scene, selectedIds, dispatch, className }: AlignRowProps) {
  // Les participants, calculés par le module (sélectionnés ∧ non verrouillés ∧ non masqués — voir la
  // décision 4 d'align.ts, corrigée par l'Important 2 de la revue finale) — jamais re-filtrés ici.
  const participants = alignParticipants(scene.layers, selectedIds);
  const canAlign = participants.length >= 1;
  // Répartir demande trois PARTICIPANTS, pas trois sélectionnés : avec deux cadres il n'existe aucun
  // écart intérieur à égaliser, et un troisième calque verrouillé ne compte pas.
  const canDistribute = participants.length >= 3;
  // La référence de l'alignement, dite à l'utilisateur plutôt que devinée : un seul participant se cale
  // sur le plan de travail (sinon la rangée serait inerte — s'aligner sur sa propre boîte est un no-op),
  // plusieurs se calent sur la boîte englobante de la sélection.
  const reference = participants.length === 1 ? "par rapport au plan de travail" : "par rapport à la sélection";
  // « say so in the UI's tooltip if it matters » (plan) : la note n'apparaît que si un participant est
  // RÉELLEMENT pivoté — un avertissement permanent ne serait plus lu par personne.
  //
  // `layerRotation()`, PAS `layer.rotation` (revue finale U3, Important 1 — CINQUIÈME instance du §0,
  // et elle vivait soixante lignes sous la correction de sa sœur `snap-rotation-note`) : sur une forme
  // DÉCOUPÉE la rotation stockée n'est peinte NULLE PART (lib/studio/shapes.ts#layerRotation, les deux
  // chemins de rendu la suppriment), donc le cadre non pivoté EST la boîte visible à l'écran et cette
  // note dirait le contraire. Pire, le champ « Rotation (°) » est alors GRISÉ avec la valeur résiduelle
  // affichée : l'utilisateur ne pourrait même pas effacer la rotation pour faire taire l'avertissement
  // — un cul-de-sac doublé d'une explication fausse. La question est posée à la rotation PEINTE, comme
  // partout ailleurs depuis la Tâche 3.
  const hasRotated = participants.some((l) => layerRotation(l) !== 0);

  return (
    <div className={cn("space-y-1", className)} data-testid="align-row">
      <div className="flex items-center gap-0.5" role="group" aria-label="Aligner et répartir">
        {ALIGN_MODES.map((mode) => {
          const { label, Icon } = ALIGN_BUTTONS[mode];
          return (
            <Button
              key={mode}
              type="button"
              variant="ghost"
              size="icon-sm"
              data-action={`align-${mode}`}
              aria-label={label}
              title={`${label} — ${reference}`}
              disabled={!canAlign}
              onClick={() => dispatch(setFrames(planAlign(scene.layers, selectedIds, mode, scene.canvas)))}
            >
              <Icon />
            </Button>
          );
        })}
        {/* Séparateur : aligner et répartir sont deux gestes différents, pas six variantes du même. */}
        <span aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-border" />
        {DISTRIBUTE_AXES.map((axis) => {
          const { label, Icon } = DISTRIBUTE_BUTTONS[axis];
          return (
            <Button
              key={axis}
              type="button"
              variant="ghost"
              size="icon-sm"
              data-action={`distribute-${axis}`}
              aria-label={label}
              title={canDistribute ? label : `${label} — trois calques déverrouillés minimum`}
              disabled={!canDistribute}
              onClick={() => dispatch(setFrames(planDistribute(scene.layers, selectedIds, axis)))}
            >
              <Icon />
            </Button>
          );
        })}
      </div>
      {/* Texte volontairement SANS « ci-dessus » : cette rangée est aussi rendue pour une sélection
          multiple, où les champs X/Y/largeur/hauteur ne sont PAS affichés (property-panel.tsx) —
          renvoyer à des champs absents serait faux la moitié du temps. */}
      {hasRotated && (
        <p className="text-[11px] text-muted-foreground" data-testid="align-rotation-note">
          Rotation ignorée : l&rsquo;alignement utilise les cadres non pivotés (X, Y, largeur,
          hauteur), pas la boîte visible à l&rsquo;écran.
        </p>
      )}
    </div>
  );
}
