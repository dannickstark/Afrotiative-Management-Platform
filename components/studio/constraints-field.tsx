"use client";

import type { Dispatch, MouseEvent } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  H_CONSTRAINTS, V_CONSTRAINTS, constraintsOf,
  type HConstraint, type VConstraint, type LayerConstraints, type Layer,
} from "@/lib/studio/scene";
import { setLayerProps, type EditorAction } from "@/lib/studio/editor-state";
import { FieldRow, type Patch } from "./property-fields";

// components/studio/constraints-field.tsx — Chantier D, Tâche 4 : le widget de contraintes de
// l'inspecteur — un carré cliquable (bords + centre) plus deux menus H/V — dans l'esprit de
// l'outil « Constraints » de Figma. Deux couches, comme partout ailleurs dans le studio (align.ts vs
// AlignRow, relayout.ts vs ce composant lui-même en amont) : `nextConstraintOnEdgeClick` est la
// machine à états PURE, testable sans DOM (tests/studio-constraints-field.test.ts) ; `ConstraintsField`
// est la couche d'affichage qui l'appelle et écrit le résultat via `patch`/`dispatch`.
//
// ─────────────────────────────────────────────────────────────────────────────
// LA MACHINE À ÉTATS — sémantique choisie (voir le rapport de tâche pour le raisonnement complet) :
//
//   - cliquer un bord SEUL (aucun bord de cet axe posé, ou l'AUTRE bord posé) POSE ce bord ;
//   - cliquer le bord OPPOSÉ d'un bord déjà seul posé PROMEUT la paire en étirement
//     (`leftRight`/`topBottom`) — les deux bords tiennent le calque ;
//   - re-cliquer un bord SEUL déjà posé le fait BASCULER EN ARRIÈRE vers `"center"` — jamais une
//     6ᵉ valeur « aucun » : les cinq valeurs de HConstraint/VConstraint (gauche, droite, étirement,
//     centre, échelle) restent les SEULES jamais produites, exactement le jeu que `H_CONSTRAINTS`/
//     `V_CONSTRAINTS` (lib/studio/scene.ts) énumèrent pour les menus. `"center"` est le choix de
//     bascule-arrière parce que c'est déjà l'état « rien n'est pincé sur cet axe » que le widget
//     affiche autrement (aucun bord actif) — inventer une sixième valeur aurait dupliqué ce sens ;
//   - cliquer un bord alors que l'étirement est déjà posé RETIRE ce bord de la paire, laissant
//     l'AUTRE bord seul posé (symétrique du cas « bord seul + bord opposé » ci-dessus) ;
//   - le CENTRE pose directement `"center"`, quel que soit l'état de départ (y compris depuis
//     `"scale"`, qui n'est atteignable que par le menu déroulant — aucune zone du carré ne le pose).
export type HEdge = "left" | "right" | "center";
export type VEdge = "top" | "bottom" | "center";

function nextH(current: HConstraint, edge: HEdge): HConstraint {
  if (edge === "center") return "center";
  if (edge === "left") {
    if (current === "left") return "center";
    if (current === "right") return "leftRight";
    if (current === "leftRight") return "right";
    return "left"; // depuis "center" ou "scale" : un clic pose un bord frais
  }
  // edge === "right"
  if (current === "right") return "center";
  if (current === "left") return "leftRight";
  if (current === "leftRight") return "left";
  return "right";
}

function nextV(current: VConstraint, edge: VEdge): VConstraint {
  if (edge === "center") return "center";
  if (edge === "top") {
    if (current === "top") return "center";
    if (current === "bottom") return "topBottom";
    if (current === "topBottom") return "bottom";
    return "top";
  }
  // edge === "bottom"
  if (current === "bottom") return "center";
  if (current === "top") return "topBottom";
  if (current === "topBottom") return "top";
  return "bottom";
}

/**
 * LA fonction PURE que le carré appelle à chaque clic — testée sans DOM
 * (tests/studio-constraints-field.test.ts). Ne touche QUE le champ de l'axe cliqué ; l'autre champ de
 * `current` traverse inchangé (une paire {h,v}, jamais un seul axe à la fois côté stockage — voir
 * `LayerConstraints`, lib/studio/scene.ts).
 */
export function nextConstraintOnEdgeClick(current: LayerConstraints, axis: "h", edge: HEdge): LayerConstraints;
export function nextConstraintOnEdgeClick(current: LayerConstraints, axis: "v", edge: VEdge): LayerConstraints;
export function nextConstraintOnEdgeClick(
  current: LayerConstraints, axis: "h" | "v", edge: HEdge | VEdge,
): LayerConstraints {
  if (axis === "h") return { ...current, h: nextH(current.h, edge as HEdge) };
  return { ...current, v: nextV(current.v, edge as VEdge) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Les libellés français des deux menus — exportés pour que le test DOM affirme le TEXTE accessible
// réel du déclencheur contre CETTE fonction plutôt que contre une chaîne recopiée à la main qui
// pourrait dériver du composant sans qu'aucun test ne le remarque (même idiome que
// `maxLinesOverflowNote`, geometry-strip.tsx).
export const H_CONSTRAINT_LABELS: Record<HConstraint, string> = {
  left: "Gauche", right: "Droite", leftRight: "Gauche et droite", center: "Centre", scale: "Échelle",
};
export const V_CONSTRAINT_LABELS: Record<VConstraint, string> = {
  top: "Haut", bottom: "Bas", topBottom: "Haut et bas", center: "Centre", scale: "Échelle",
};

export interface ConstraintsFieldProps {
  layer: Layer;
  patch: Patch;
  // Maj-clic applique le réglage à TOUTE la sélection multiple, pas seulement au calque courant
  // (spec Tâche 4) — mais `patch` (property-fields.tsx#Patch) ne sait éditer QUE le calque courant,
  // comme documenté sur GeometryStripProps pour AlignRow. Ces deux props, DÉJÀ dans la main de
  // GeometryStrip (elle les reçoit de PropertyPanel), sont donc passées ICI EN PLUS de `patch` —
  // optionnelles : un appelant qui ne les fournit pas (aucun aujourd'hui — GeometryStrip est le seul
  // monteur, et lui les fournit toujours) perd seulement le raccourci Maj-clic, jamais le widget
  // lui-même, qui continue d'écrire via `patch` pour le calque courant.
  selectedIds?: readonly string[];
  dispatch?: Dispatch<EditorAction>;
}

/**
 * Le widget d'ancrage — un carré de cinq zones cliquables (quatre bords + un centre) plus deux menus
 * H/V, reflétant et écrivant `constraintsOf(layer)`. Mixte HTML/CSS plutôt qu'un vrai `<svg>` : les
 * cinq zones sont des `<button>` positionnés en absolu dans un conteneur relatif — un vrai bouton HTML
 * porte `aria-pressed` nativement et reste focalisable au clavier sans reconstruire la sémantique
 * qu'un `<rect>` SVG cliqué n'aurait pas.
 */
export function ConstraintsField({ layer, patch, selectedIds, dispatch }: ConstraintsFieldProps) {
  const current = constraintsOf(layer);

  // UN geste = UNE entrée d'historique (même règle que `setFrames`, AlignRow) : Maj-clic sur une
  // sélection de PLUSIEURS calques dispatche `setLayerProps` (un lot), sinon `patch` (le calque
  // courant) — jamais les deux, et jamais N appels à `patch` qui empileraient N entrées.
  function commit(next: LayerConstraints, shiftKey: boolean) {
    if (shiftKey && dispatch && selectedIds && selectedIds.length > 1) {
      dispatch(setLayerProps(selectedIds, { constraints: next }));
    } else {
      patch({ constraints: next });
    }
  }

  function onH(edge: HEdge) {
    return (e: MouseEvent<HTMLButtonElement>) => commit(nextConstraintOnEdgeClick(current, "h", edge), e.shiftKey);
  }
  function onV(edge: VEdge) {
    return (e: MouseEvent<HTMLButtonElement>) => commit(nextConstraintOnEdgeClick(current, "v", edge), e.shiftKey);
  }
  // Le centre pose les DEUX axes sur "center" d'un même geste (comportement du point central de
  // Figma) — deux appels chaînés à la même fonction pure plutôt qu'une branche séparée qui
  // dupliquerait la règle « edge === "center" -> "center" » déjà dans `nextH`/`nextV`.
  function onCenter(e: MouseEvent<HTMLButtonElement>) {
    const afterH = nextConstraintOnEdgeClick(current, "h", "center");
    const next = nextConstraintOnEdgeClick(afterH, "v", "center");
    commit(next, e.shiftKey);
  }

  const leftActive = current.h === "left" || current.h === "leftRight";
  const rightActive = current.h === "right" || current.h === "leftRight";
  const topActive = current.v === "top" || current.v === "topBottom";
  const bottomActive = current.v === "bottom" || current.v === "topBottom";
  const centerActive = current.h === "center" && current.v === "center";

  const pinClass = (active: boolean) =>
    cn("absolute rounded-sm border transition-colors", active ? "border-primary bg-primary" : "border-border bg-background");

  return (
    <FieldRow label="Ancrage">
      <div className="flex items-start gap-3">
        <div
          className="relative h-16 w-16 shrink-0 rounded border border-dashed border-border"
          role="group"
          aria-label="Ancrage du calque"
          data-testid="constraints-square"
        >
          <button
            type="button" data-edge="left" aria-label="Ancrer au bord gauche" aria-pressed={leftActive}
            className={cn(pinClass(leftActive), "left-0 top-1/2 h-6 w-2 -translate-y-1/2")}
            onClick={onH("left")}
          />
          <button
            type="button" data-edge="right" aria-label="Ancrer au bord droit" aria-pressed={rightActive}
            className={cn(pinClass(rightActive), "right-0 top-1/2 h-6 w-2 -translate-y-1/2")}
            onClick={onH("right")}
          />
          <button
            type="button" data-edge="top" aria-label="Ancrer au bord haut" aria-pressed={topActive}
            className={cn(pinClass(topActive), "left-1/2 top-0 h-2 w-6 -translate-x-1/2")}
            onClick={onV("top")}
          />
          <button
            type="button" data-edge="bottom" aria-label="Ancrer au bord bas" aria-pressed={bottomActive}
            className={cn(pinClass(bottomActive), "left-1/2 bottom-0 h-2 w-6 -translate-x-1/2")}
            onClick={onV("bottom")}
          />
          <button
            type="button" data-edge="center" aria-label="Centrer" aria-pressed={centerActive}
            className={cn(pinClass(centerActive), "left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full")}
            onClick={onCenter}
          />
        </div>
        <div className="grid flex-1 grid-cols-1 gap-2">
          <Select
            value={current.h}
            onValueChange={(v) => { if (v) patch({ constraints: { ...current, h: v as HConstraint } }); }}
          >
            <SelectTrigger className="w-full" data-field="constraints.h">
              <SelectValue placeholder="Choisir…">
                {(v: string | null) => H_CONSTRAINT_LABELS[(v ?? current.h) as HConstraint]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {H_CONSTRAINTS.map((c) => (
                <SelectItem key={c} value={c} data-constraint-h={c}>{H_CONSTRAINT_LABELS[c]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={current.v}
            onValueChange={(v) => { if (v) patch({ constraints: { ...current, v: v as VConstraint } }); }}
          >
            <SelectTrigger className="w-full" data-field="constraints.v">
              <SelectValue placeholder="Choisir…">
                {(v: string | null) => V_CONSTRAINT_LABELS[(v ?? current.v) as VConstraint]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {V_CONSTRAINTS.map((c) => (
                <SelectItem key={c} value={c} data-constraint-v={c}>{V_CONSTRAINT_LABELS[c]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </FieldRow>
  );
}
