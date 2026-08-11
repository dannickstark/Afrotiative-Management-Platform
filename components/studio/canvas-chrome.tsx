"use client";

import type { ReactNode } from "react";
import { Ruler, Grid3x3, ShieldHalf } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FORMAT_PRESETS, type FormatKey } from "@/lib/studio/formats";
import type { EditorPrefs } from "@/lib/studio/editor-prefs";

// components/studio/canvas-chrome.tsx — Tâche 7 (U1, spec §7) : le CHROME autour de l'artboard —
// pastilles flottantes (format + zoom), règles et grille, et le TOGGLE des zones sûres. La ligne de
// partage avec U2 (spec §7, à relire avant de toucher ce fichier) :
//
//   U1 (ICI) : les pastilles, le rendu des règles/grille (décoratif, désactivé par défaut, état
//   mémorisé par utilisateur via lib/studio/editor-prefs.ts — déjà persistées, Tâche 1), et le
//   TOGGLE des zones sûres avec sa persistance (même mécanisme).
//   U2 (PAS ICI) : le magnétisme, les guides intelligents, les BANDES de zones sûres elles-mêmes
//   (le rectangle visuel marquant la zone protégée), et les modificateurs de geste. Ce fichier expose
//   `prefs.safeAreas` et `onToggleSafeAreas` pour que U2 n'ait qu'à lire ce booléen et dessiner sa
//   bande — aucune bande n'est dessinée ICI, volontairement (spec §7 : « safe-area bands » listées
//   sous U2, pas sous U1).
//
// « L'artboard visuellement distinct de son entourage » (spec §7) est la responsabilité de
// components/studio/canvas.tsx lui-même (son propre conteneur `data-testid="studio-canvas"` porte
// désormais un box-shadow, quel que soit le fond de la scène — voir son commentaire) : ce fichier ne
// duplique donc PAS de fond/ombre sur son propre conteneur, pour ne pas empiler deux traitements
// visuels l'un dans l'autre.
export interface CanvasChromeProps {
  format: FormatKey;
  /** Échelle RÉELLEMENT appliquée au canevas (le `scale` local de editor-shell.tsx, PAS
   * EditorPrefs.zoom — voir le rapport de la Tâche 7 pour la distinction : ce dernier reste un champ
   * mémorisé sans consommateur avant cette tâche). Sert à la fois à afficher le pourcentage de la
   * pastille de zoom et à dimensionner très exactement la zone que règles/grille recouvrent, pour
   * qu'elles restent alignées sur le VRAI rendu de Canvas (même calcul `preset.width * zoom` /
   * `preset.height * zoom` que le conteneur extérieur de canvas.tsx). */
  zoom: number;
  prefs: Pick<EditorPrefs, "rulers" | "grid" | "safeAreas">;
  onToggleRulers?: () => void;
  onToggleGrid?: () => void;
  onToggleSafeAreas?: () => void;
  /** Le VRAI <Canvas> (components/studio/canvas.tsx) en composition normale — ce composant ne sait
   * rien de la scène ni des calques, il ne fait qu'encadrer ce qu'on lui passe. */
  children?: ReactNode;
}

// Dérivé de l'orientation du format, PAS une paire codée en dur (leçon du brief, Tâche 7 : « easy to
// satisfy with a hardcoded pair… derive it from something real »). Un format PORTRAIT (plus haut que
// large — story, portrait Instagram) se consulte plein écran sur mobile, où le chrome de
// l'application (icônes de réaction, barre de réponse Stories, etc.) recouvre le haut et le bas de
// l'image : les zones sûres protègent CONTRE ce recouvrement. Un format carré (ig_square, wa_square)
// ou paysage (les formats « lien », l'image à la une, X) s'affiche à l'intérieur d'un cadre qui ne
// mord jamais sur ses propres bords — aucun chrome d'appli à éviter, donc pas de zones sûres par
// défaut. Testé pour les HUIT formats (tests/studio-canvas.test.ts), pas seulement les quatre cités
// par la spec, pour qu'un futur format ajouté à FORMAT_PRESETS sans y être ajouté explicitement là-bas
// hérite quand même du bon comportement plutôt que de silencieusement défaillir.
export function safeAreaDefaultFor(format: FormatKey): boolean {
  const { width, height } = FORMAT_PRESETS[format];
  return height > width;
}

// Exportée (correctif revue finale, spec §7) : editor-shell.tsx#computeCanvasScale doit réserver
// EXACTEMENT ce même nombre de pixels par bande pour que l'artboard mis à l'échelle continue de
// coïncider pixel pour pixel avec la boîte que ce fichier calcule (`preset.width * zoom` /
// `preset.height * zoom`) — une constante recopiée à la main aurait pu diverger silencieusement.
export const RULER_SIZE = 20; // px écran de large/haut pour les bandes de règles
const RULER_STEP = 100; // px NATIFS (gabarit) entre deux graduations

function rulerTicks(lengthNative: number): number[] {
  const ticks: number[] = [];
  for (let v = 0; v <= lengthNative; v += RULER_STEP) ticks.push(v);
  return ticks;
}

export function CanvasChrome({
  format,
  zoom,
  prefs,
  onToggleRulers,
  onToggleGrid,
  onToggleSafeAreas,
  children,
}: CanvasChromeProps) {
  const preset = FORMAT_PRESETS[format];
  const zoomPct = Math.round(zoom * 100);
  const boxWidth = preset.width * zoom;
  const boxHeight = preset.height * zoom;

  return (
    <div className="relative flex h-full w-full items-center justify-center" data-testid="canvas-chrome">
      {/* Pastille flottante (spec §2 : « Floating chips top-left (format name and pixel size, zoom
          percentage) » — TOP-LEFT, à ne pas confondre avec ModeSwitch, seul élément top-CENTRE). */}
      <div className="pointer-events-none absolute left-2 top-2 z-20 flex">
        <div
          className="pointer-events-auto flex items-center gap-2 rounded-full border bg-background/95 px-3 py-1 text-xs shadow-sm backdrop-blur"
          data-testid="format-chip"
        >
          <span className="font-medium">{preset.label}</span>
          <span className="text-muted-foreground">
            {preset.width}×{preset.height}
          </span>
          <span aria-hidden className="h-3 w-px bg-border" />
          <span data-testid="zoom-chip" className="text-muted-foreground">{zoomPct}%</span>
        </div>
      </div>

      {/* Bascules de chrome (spec §7) : règles, grille, zones sûres — les trois sont purement U1
          (rendu + persistance) ; les BANDES de zones sûres restent de U2 (voir le commentaire
          d'en-tête). */}
      <div className="pointer-events-none absolute right-2 top-2 z-20 flex items-center gap-1">
        <Button
          type="button"
          variant={prefs.rulers ? "secondary" : "ghost"}
          size="icon-sm"
          data-action="toggle-rulers"
          aria-label="Afficher les règles"
          aria-pressed={prefs.rulers}
          title="Règles"
          className="pointer-events-auto"
          onClick={onToggleRulers}
        >
          <Ruler />
        </Button>
        <Button
          type="button"
          variant={prefs.grid ? "secondary" : "ghost"}
          size="icon-sm"
          data-action="toggle-grid"
          aria-label="Afficher la grille"
          aria-pressed={prefs.grid}
          title="Grille"
          className="pointer-events-auto"
          onClick={onToggleGrid}
        >
          <Grid3x3 />
        </Button>
        <Button
          type="button"
          variant={prefs.safeAreas ? "secondary" : "ghost"}
          size="icon-sm"
          data-action="toggle-safe-areas"
          aria-label="Afficher les zones sûres"
          aria-pressed={prefs.safeAreas}
          title="Zones sûres"
          className="pointer-events-auto"
          onClick={onToggleSafeAreas}
        >
          <ShieldHalf />
        </Button>
      </div>

      {/* Cadre règles + artboard : quand les règles sont actives, un padding leur réserve une bande
          en haut et à gauche — l'artboard lui-même (ci-dessous) ne bouge donc jamais de taille,
          seule sa POSITION dans ce cadre se décale de RULER_SIZE. */}
      <div
        className="relative"
        style={{ padding: prefs.rulers ? RULER_SIZE : 0 }}
      >
        {prefs.rulers && (
          <div data-testid="rulers" className="pointer-events-none absolute inset-0" aria-hidden>
            <div className="absolute left-0 top-0 h-5 w-5 border-b border-r bg-muted/40" />
            <div
              data-testid="ruler-top"
              className="absolute top-0 h-5 overflow-hidden border-b bg-muted/30 text-[9px] text-muted-foreground"
              style={{ left: RULER_SIZE, width: boxWidth }}
            >
              {rulerTicks(preset.width).map((v) => (
                <span key={v} className="absolute top-0 border-l pl-0.5" style={{ left: v * zoom }}>
                  {v}
                </span>
              ))}
            </div>
            <div
              data-testid="ruler-left"
              className="absolute left-0 w-5 overflow-hidden border-r bg-muted/30 text-[9px] text-muted-foreground"
              style={{ top: RULER_SIZE, height: boxHeight }}
            >
              {rulerTicks(preset.height).map((v) => (
                <span key={v} className="absolute left-0 border-t pl-0.5" style={{ top: v * zoom }}>
                  {v}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* PAS de `overflow-hidden` ICI (revue Tâche 7, Critique) : ce conteneur est pixel-IDENTIQUE
            à celui de <Canvas> lui-même (canvas.tsx : `scene.canvas.width * scale`, ici
            `preset.width * zoom` — même valeur en composition réelle, editor-shell.tsx passant
            `zoom={scale}`), enrobé sans marge. Un overflow:hidden POSÉ ICI rognerait donc le
            box-shadow que canvas.tsx pose sur son PROPRE conteneur (« l'artboard visuellement
            distinct de son entourage », spec §7) : le box-shadow d'un élément peint HORS de sa
            boîte n'est jamais rogné par le overflow:hidden de CE MÊME élément (canvas.tsx:107
            reste nécessaire — il rogne les CALQUES qui déborderaient, pas sa propre ombre), mais
            un ANCÊTRE avec overflow:hidden ET une boîte de taille égale ou inférieure le rogne
            bel et bien : exactement ce que ce conteneur faisait avant ce correctif. Il ne protège
            par ailleurs RIEN d'autre ici : le motif de grille (backgroundImage/backgroundSize,
            juste dessous) ne peint jamais hors de son PROPRE `inset-0`, et tout ce que <Canvas>
            pourrait laisser déborder (poignées de sélection, etc.) est déjà rogné par son propre
            conteneur racine. Verrouillé par tests/studio-canvas.test.ts (« composition RÉELLE »),
            qui rend <CanvasChrome> enrobant un VRAI <Canvas> plutôt qu'un espace réservé — les
            deux tests isolés plus haut dans ce fichier ne l'auraient jamais détecté. */}
        <div
          data-testid="artboard"
          className="relative"
          style={{ width: boxWidth, height: boxHeight }}
        >
          {/* CRITIQUE (revue finale) : la grille doit peindre APRÈS {children} (le vrai <Canvas>),
              jamais avant. Les deux sont `z-index: auto` dans ce conteneur `relative` : l'ordre de
              peinture suit donc l'ordre du DOM, et <Canvas> pose un rectangle plein-cadre pour
              `scene.canvas.background` (jamais transparent pour un gabarit "normal" — les nouveaux
              gabarits partent de `#0B0B0B`, lib/studio/template-core.ts) qui couvrait la grille
              entièrement quand elle était posée EN PREMIER — le bouton "Grille" bascule
              `aria-pressed` sans le moindre effet visuel. `pointer-events-none` la maintient hors du
              chemin des clics/du glisser sur le canevas même en dernière position dans l'arbre.
              Verrouillé par tests/studio-canvas.test.ts (describe "composition RÉELLE"), qui enrobe
              un VRAI <Canvas> plutôt qu'un espace réservé — voir son commentaire pour l'historique
              (même substitution que le bogue de box-shadow déjà corrigé dans ce fichier). */}
          {children}
          {prefs.grid && (
            <div
              data-testid="grid"
              className="pointer-events-none absolute inset-0"
              style={{
                backgroundImage:
                  "linear-gradient(to right, rgba(120,120,120,0.25) 1px, transparent 1px)," +
                  "linear-gradient(to bottom, rgba(120,120,120,0.25) 1px, transparent 1px)",
                backgroundSize: `${RULER_STEP * zoom}px ${RULER_STEP * zoom}px`,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
