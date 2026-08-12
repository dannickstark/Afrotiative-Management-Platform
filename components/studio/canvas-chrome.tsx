"use client";

import type { CSSProperties, ReactNode } from "react";
import { Ruler, Grid3x3, ShieldHalf, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FORMAT_PRESETS, type FormatKey } from "@/lib/studio/formats";
import { safeAreaBandsFor, type SafeAreaBand } from "@/lib/studio/safe-areas";
import type { EditorPrefs } from "@/lib/studio/editor-prefs";

// components/studio/canvas-chrome.tsx — Tâche 7 (U1, spec §7) : le CHROME autour de l'artboard —
// pastilles flottantes (format + zoom), règles et grille, et le TOGGLE des zones sûres. La ligne de
// partage avec U2 (spec §7, à relire avant de toucher ce fichier) :
//
//   U1 (ICI) : les pastilles, le rendu des règles/grille (décoratif, désactivé par défaut, état
//   mémorisé par utilisateur via lib/studio/editor-prefs.ts — déjà persistées, Tâche 1), et le
//   TOGGLE des zones sûres avec sa persistance (même mécanisme).
//   U2 (PAS ICI) : le magnétisme, les guides intelligents et les modificateurs de geste.
//
// MISE À JOUR — Tâche 6 (U2) : les BANDES de zones sûres, elles, sont désormais DESSINÉES ICI (elles
// étaient annoncées « pas ici » tant que U2 ne les avait pas livrées). Leur table de chiffres, en
// revanche, vit dans lib/studio/safe-areas.ts — un fait plateforme sourcé entrée par entrée, à lire
// AVANT d'y toucher. Ce fichier n'en connaît que la forme (arête + fraction + étiquette) et les
// convertit en pixels écran ; il ne décide d'aucun chiffre.
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
  prefs: Pick<EditorPrefs, "rulers" | "grid" | "safeAreas" | "showBindings">;
  onToggleRulers?: () => void;
  onToggleGrid?: () => void;
  onToggleSafeAreas?: () => void;
  /** Tâche 6 (U4, spec §5) : « voir les liaisons » — MÊME idiome que les trois bascules ci-dessus.
   * Le TOGGLE lui-même est de U1/CanvasChrome ; le CONTOUR + l'ÉTIQUETTE qu'il commande sont dessinés
   * par components/studio/canvas.tsx (le vrai `<Canvas>`, passé en `children` — voir son commentaire),
   * jamais ici : ce fichier ne connaît toujours aucun calque, seulement l'état du bouton. */
  onToggleBindings?: () => void;
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

// ── Bandes de zones sûres (Tâche 6, U2) ──────────────────────────────────────
// L'ambre : DÉLIBÉRÉMENT différent du bleu de sélection (#2563eb, poignées/contours de canvas.tsx) et
// du rose des guides d'accrochage (#e11d48, Tâche 5). Une zone sûre n'est ni une sélection ni une
// relation temporaire : c'est une contrainte permanente du format, et la confondre visuellement avec
// l'une des deux autres surcouches serait le seul vrai risque de lisibilité de cette tâche.
const SAFE_TINT = "rgba(245,158,11,0.14)";
const SAFE_LINE = "1px dashed rgba(245,158,11,0.85)";

// Les bandes vivent dans l'artboard de CE fichier (pixels ÉCRAN, conteneur JAMAIS mis à l'échelle),
// pas dans le conteneur `transform: scale(k)` de canvas.tsx : `boxWidth`/`boxHeight` intègrent déjà le
// zoom, donc AUCUNE compensation `/ scale` n'est nécessaire ici (contrairement aux poignées et aux
// guides, qui vivent, eux, DANS le conteneur mis à l'échelle — voir canvas.tsx).
//
// Les bandes se CHEVAUCHENT dans les coins (une bande de côté couvre toute la hauteur, y compris sous
// les bandes haut/bas) : voulu. Chaque bande vaut alors exactement `fraction × dimension`, une
// géométrie que le lecteur peut vérifier arête par arête contre la source citée dans safe-areas.ts,
// là où des bandes mutuellement rognées mélangeraient les quatre chiffres.
function safeBandStyle(band: SafeAreaBand, boxWidth: number, boxHeight: number): CSSProperties {
  const base: CSSProperties = { position: "absolute", background: SAFE_TINT, overflow: "hidden" };
  if (band.edge === "top") {
    return { ...base, top: 0, left: 0, width: boxWidth, height: boxHeight * band.fraction, borderBottom: SAFE_LINE };
  }
  if (band.edge === "bottom") {
    return { ...base, bottom: 0, left: 0, width: boxWidth, height: boxHeight * band.fraction, borderTop: SAFE_LINE };
  }
  if (band.edge === "left") {
    return { ...base, left: 0, top: 0, height: boxHeight, width: boxWidth * band.fraction, borderRight: SAFE_LINE };
  }
  return { ...base, right: 0, top: 0, height: boxHeight, width: boxWidth * band.fraction, borderLeft: SAFE_LINE };
}

// L'étiquette est en pixels ÉCRAN constants (9px), collée à l'arête INTÉRIEURE de sa bande. Les bandes
// de côté ne font que 6 % de la largeur (≈65px à l'échelle 1, ≈20px pour `story` ajusté à la fenêtre) :
// leur étiquette est donc écrite VERTICALEMENT (`vertical-rl`), seule façon qu'un mot y tienne sans
// inventer un seuil arbitraire de « bande assez large pour un texte horizontal ».
function safeLabelStyle(edge: SafeAreaBand["edge"]): CSSProperties {
  const base: CSSProperties = {
    position: "absolute",
    fontSize: 9,
    lineHeight: 1,
    fontWeight: 500,
    whiteSpace: "nowrap",
    color: "rgba(245,158,11,0.95)",
    textShadow: "0 1px 2px rgba(0,0,0,0.55)",
  };
  if (edge === "top") return { ...base, left: 4, bottom: 3 };
  if (edge === "bottom") return { ...base, left: 4, top: 3 };
  if (edge === "left") return { ...base, left: 3, top: 4, writingMode: "vertical-rl" };
  return { ...base, right: 3, top: 4, writingMode: "vertical-rl" };
}

export function CanvasChrome({
  format,
  zoom,
  prefs,
  onToggleRulers,
  onToggleGrid,
  onToggleSafeAreas,
  onToggleBindings,
  children,
}: CanvasChromeProps) {
  const preset = FORMAT_PRESETS[format];
  const zoomPct = Math.round(zoom * 100);
  const boxWidth = preset.width * zoom;
  const boxHeight = preset.height * zoom;
  // Tâche 6 (U2) : les bandes ÉTABLIES pour ce format, indépendamment de la préférence — c'est ce que
  // l'infobulle et la note doivent refléter (le format, pas l'état du bouton).
  const formatBands = safeAreaBandsFor(format);
  // Vide quand la préférence est éteinte, ET vide pour un format dont aucune zone sûre n'a pu être
  // établie (lib/studio/safe-areas.ts) — dans les deux cas, RIEN n'est rendu plus bas, jamais un
  // conteneur vide ni une bande de hauteur nulle.
  const safeBands = prefs.safeAreas ? formatBands : [];
  // Revue de la Tâche 6, point 2 : la réserve « ce sont les bornes PUBLICITAIRES » ne vivait que dans le
  // commentaire de lib/studio/safe-areas.ts, alors que l'utilisateur voit 49 % de la hauteur (55 % de la
  // surface) recouverts. Elle est mise À PORTÉE ici, et elle dépend du FORMAT, jamais de l'état du
  // bouton : la réserve doit être lisible AVANT d'activer les zones sûres, pas seulement après. Rien
  // n'est inventé — l'infobulle ne fait que dire ce que la source citée dit, et l'écart d'ordre de
  // grandeur avec l'organique n'est PAS chiffré ici faute de source de première partie pour l'organique.
  const safeAreasTitle =
    formatBands.length === 0
      ? "Zones sûres — aucune donnée publiée pour ce format"
      : "Zones sûres — bornes publicitaires Meta : le bas (35 %) réserve le bouton d’appel à l’action, absent d’une story organique ; c’est donc une marge volontairement conservatrice";

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
          title={safeAreasTitle}
          className="pointer-events-auto"
          onClick={onToggleSafeAreas}
        >
          <ShieldHalf />
        </Button>
        <Button
          type="button"
          variant={prefs.showBindings ? "secondary" : "ghost"}
          size="icon-sm"
          data-action="toggle-bindings"
          aria-label="Afficher les liaisons"
          aria-pressed={prefs.showBindings}
          title="Voir les liaisons"
          className="pointer-events-auto"
          onClick={onToggleBindings}
        >
          <Link2 />
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

          {/* Bandes de zones sûres (Tâche 6, U2, spec §7). MÊME leçon que la grille juste au-dessus, et
              c'est LA raison d'être du test de composition de cette tâche : rendues AVANT {children},
              elles passeraient sous le rectangle plein-cadre opaque que <Canvas> peint pour
              `scene.canvas.background`, et le bouton « Zones sûres » basculerait `aria-pressed` sans le
              moindre effet visuel — exactement ce que la grille de U1 a livré « fonctionnel ». Elles sont
              donc DERNIÈRES dans l'arbre, sans z-index (l'ordre du DOM EST l'ordre de peinture entre
              éléments `z-index: auto` qui se chevauchent, et n'introduire aucun contexte d'empilement
              garde cette garantie vraie). Après la grille, aussi : une contrainte de format doit rester
              lisible par-dessus une aide au placement.

              `pointer-events-none` sur le CONTENEUR : les bandes recouvrent jusqu'à 55 % de l'artboard
              (`story`), donc sans cela elles voleraient clics et glissers du canevas. Aucun descendant ne
              réactive `pointer-events` — verrouillé par test, puisque c'est le genre de détail qu'une
              future étiquette « cliquable » réintroduirait sans y penser.

              `inset-0` DANS l'artboard `relative`, dont la boîte est pixel-identique à celle de <Canvas>
              (`preset.width * zoom` vs `scene.canvas.width * scale`, avec `zoom === scale` en composition
              réelle) : « au-dessus » recouvre donc bien la MÊME surface, condition sans laquelle l'ordre
              de peinture ne prouverait rien. */}
          {safeBands.length > 0 && (
            <div data-testid="safe-areas" className="pointer-events-none absolute inset-0" aria-hidden>
              {/* `key={band.edge}` : une arête est unique par format, et cette unicité est ÉPINGLÉE par
                  un test (tests/studio-canvas.test.ts, « les arêtes d'un format sont UNIQUES ») plutôt
                  que laissée au type — deux entrées sur la même arête verraient React n'en rendre
                  qu'une, sans le moindre avertissement en production. Revue de la Tâche 6, nit 2 :
                  ce fichier-là invite explicitement à ajouter des entrées, donc la contrainte devait
                  cesser d'être implicite. */}
              {safeBands.map((band) => (
                <div key={band.edge} data-safe-band={band.edge} style={safeBandStyle(band, boxWidth, boxHeight)}>
                  <span style={safeLabelStyle(band.edge)}>{band.label}</span>
                </div>
              ))}
            </div>
          )}

          {/* Revue de la Tâche 6, point 1 — LA CONFIANCE MAL PLACÉE. Sur un format PORTRAIT sans zone
              sûre établie (`ig_portrait`), `safeAreaDefaultFor` renvoie `true` par orientation : le
              bouton se rend donc ENFONCÉ au-dessus d'un artboard où rien n'est dessiné. Ce que
              l'utilisateur en déduit n'est pas « aucune donnée disponible » mais « les zones sûres sont
              actives, donc ma maquette les respecte » — strictement pire que de ne rien faire.
              UNE NOTE, PAS UN CONTRÔLE DÉSACTIVÉ, et la raison est structurelle : `prefs.safeAreas` est
              GLOBALE à l'utilisateur (lib/studio/editor-prefs.ts), pas par format. Griser le bouton sur
              un gabarit ferait passer un réglage global pour un réglage propre au format et laisserait
              le `true` déjà persisté orphelin — le bouton mentirait dans l'autre sens. Même précédent
              de ton et de placement que geometry-strip.tsx#snap-rotation-note (Tâches 4 et 5) : discret,
              et UNIQUEMENT dans le cas concerné. N'énonce que l'absence que safe-areas.ts documente
              déjà — aucun chiffre inventé. Dernier enfant de l'artboard, mêmes contraintes que les
              bandes (peint APRÈS le Canvas opaque, sans quoi il serait invisible ; `pointer-events-none`,
              sans quoi il volerait les clics de la surface qu'il recouvre). */}
          {prefs.safeAreas && formatBands.length === 0 && (
            <div
              data-testid="safe-areas-none"
              className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-2"
              aria-hidden
            >
              <span
                className="rounded bg-black/55 px-2 py-1 text-[10px] font-medium"
                style={{ color: "rgba(245,158,11,0.95)" }}
              >
                Zones sûres : aucune donnée publiée pour ce format.
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
