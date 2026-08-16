"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download } from "lucide-react";
import { usePreview } from "@/hooks/use-preview";
import { sceneForFormat } from "@/lib/studio/relayout";
import { FORMAT_PRESETS, FORMAT_KEYS, type FormatKey } from "@/lib/studio/formats";
import { previewFileName } from "./export";
import type { Scene } from "@/lib/studio/scene";

// components/studio/render/proof-sheet.tsx — la PLANCHE de contrôle : les huit formats côte à côte,
// chacun ouvrant l'inspection au clic. Remplace l'ancien duo « grande case + bande de sept
// vignettes de 112px », dont la bande gaspillait l'axe le plus large de l'écran pour des images
// trop petites pour juger quoi que ce soit.
//
// HAUTEUR DE TUILE UNIFORME, rendu en boîte-aux-lettres à son ratio réel à l'intérieur : l'objet de
// cette vue est de balayer huit choses d'un seul regard, et des hauteurs irrégulières cassent ce
// balayage. La forme relative de chaque format reste lisible puisque le rendu, lui, garde son ratio.
//
// Aucun point de rupture : `auto-fill` + `minmax(240px, 1fr)` donne 1 colonne à 380px, 2 vers 560,
// 3 vers 820, 4 à 5 au-delà de 1440 — la même règle du téléphone au 27 pouces.
const TILE_FRAME_HEIGHT = "h-40"; // 160px — la même pour les huit, cf. ci-dessus.

export type TileOutcome = { ready: boolean; overflow: boolean; lowRes: boolean };

export interface ProofSheetProps {
  templateId: string;
  scene: Scene;
  /** Format natif du gabarit (render_templates.format) — celui qui porte le marqueur « natif ». */
  nativeFormat: FormatKey;
  /** `null` = valeurs d'exemple. Pilote LES HUIT tuiles : c'est ce qui fait que la planche ne ment
   *  plus par rapport au sélecteur d'article (défaut n°7 de la spec). */
  articleId: string | null;
  disabled?: boolean;
  onFocus: (format: FormatKey) => void;
  /** Remonte le résultat de CHAQUE tuile au parent, qui en compose la pastille d'agrégation. */
  onTileOutcome: (format: FormatKey, outcome: TileOutcome) => void;
  // Amorce de test UNIQUEMENT — même convention que RenderModeProps.initialDegraded : la vraie
  // composition ne la fournit JAMAIS. `react-dom/server` n'exécute aucun effet, donc sans elle
  // aucun test statique ne pourrait atteindre un état post-réseau.
  initialOutcomes?: Partial<Record<FormatKey, TileOutcome>>;
}

function ProofTile({
  templateId, scene, nativeFormat, format, articleId, disabled, onFocus, onTileOutcome, initial,
}: {
  templateId: string; scene: Scene; nativeFormat: FormatKey; format: FormatKey;
  articleId: string | null; disabled?: boolean;
  onFocus: (f: FormatKey) => void;
  onTileOutcome: (f: FormatKey, o: TileOutcome) => void;
  initial?: TileOutcome;
}) {
  const preset = FORMAT_PRESETS[format];
  const containerRef = useRef<HTMLDivElement>(null);

  // Gating de visibilité — conservé de l'ancien FilmstripThumb, et plus nécessaire que jamais : en
  // grille, un grand écran rend les huit tuiles visibles d'emblée, donc les huit partent. Sur un
  // téléphone, une seule. `.disconnect()` à la première apparition : on veut découvrir l'existence
  // de la tuile une fois, pas re-déclencher à chaque passage dans le viewport.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "200px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Mémoïsé : `relayoutToFormat` est un vrai calcul, et sans cela il serait refait pour les huit
  // tuiles à chaque rendu du parent (une frappe ailleurs dans l'éditeur, par exemple).
  const variant = useMemo(
    () => sceneForFormat(scene, format, nativeFormat),
    [scene, format, nativeFormat],
  );

  const { state } = usePreview({
    templateId, scene: variant, format, articleId, enabled: visible && !disabled,
  });

  const outcome: TileOutcome = state.status === "ready"
    ? { ready: true, overflow: state.overflow, lowRes: state.lowRes }
    : (initial ?? { ready: false, overflow: false, lowRes: false });

  // Remonte au parent pour la pastille d'agrégation. Dans les dépendances : les trois champs, pas
  // l'objet — recréé à chaque rendu, il bouclerait indéfiniment.
  useEffect(() => {
    onTileOutcome(format, outcome);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format, outcome.ready, outcome.overflow, outcome.lowRes]);

  const dataUri = state.status === "ready" ? state.dataUri : null;

  return (
    // `relative` + DEUX BOUTONS FRÈRES : un <button> dans un <button> est du HTML invalide et le
    // navigateur déstructure l'arbre. Le bouton d'ouverture est en `absolute inset-0` sous le bouton
    // de téléchargement, qui reste atteignable au clavier et se révèle au survol COMME AU FOCUS.
    <div
      ref={containerRef}
      data-testid="proof-tile"
      data-format={format}
      className="group relative flex flex-col gap-1.5 rounded-xl p-2 ring-1 ring-foreground/10 transition-colors hover:ring-foreground/20 focus-within:ring-foreground/20"
    >
      <span className={`flex ${TILE_FRAME_HEIGHT} items-center justify-center overflow-hidden rounded-lg bg-muted/30`}>
        {dataUri !== null && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={dataUri} alt={`Aperçu — ${preset.label}`} className="max-h-full max-w-full object-contain" />
        )}
        {state.status === "loading" && (
          <span
            className="animate-pulse rounded bg-muted"
            style={{ aspectRatio: `${preset.width} / ${preset.height}`, height: "100%" }}
          />
        )}
        {state.status === "idle" && <span className="text-[10px] text-muted-foreground">En attente…</span>}
        {state.status === "error" && <span className="text-[10px] text-destructive">Échec du rendu</span>}
      </span>

      <span className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs font-medium">{preset.label}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{preset.width}×{preset.height}</span>
      </span>

      {format === nativeFormat && (
        <span
          data-testid="proof-tile-native"
          data-format={format}
          className="w-fit rounded-4xl bg-muted px-1.5 text-[10px] text-muted-foreground"
          title="Le format natif du gabarit — celui dans lequel il a été conçu."
        >
          natif
        </span>
      )}

      {outcome.overflow && (
        <span
          data-testid="proof-tile-overflow" data-format={format}
          className="truncate text-[10px] text-amber-600 dark:text-amber-500"
          title="Un texte contraint dépasse sa limite de lignes dans ce format — il risque de déborder du cadre. Mesuré avec la police de repli, approximatif si ce calque porte une police personnalisée."
        >
          Texte déborde
        </span>
      )}
      {outcome.lowRes && (
        <span
          data-testid="proof-tile-lowres" data-format={format}
          className="truncate text-[10px] text-amber-600 dark:text-amber-500"
          title="La photo source est plus petite que son cadre dans ce format : elle est agrandie, donc floue. Réduire le cadre ou fournir une image plus grande — aucun réglage du gabarit ne peut compenser."
        >
          Image agrandie
        </span>
      )}

      <button
        type="button"
        data-testid="proof-tile-open"
        data-format={format}
        className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={() => onFocus(format)}
      >
        <span className="sr-only">Inspecter {preset.label}</span>
      </button>

      {/* Toujours rendue — SIBLING du bouton d'ouverture, jamais son enfant. Un rendu conditionné à
          `dataUri !== null` la ferait disparaître du DOM tant que l'aperçu n'est pas prêt (état
          initial de toute tuile hors viewport, ou avant le premier passage réseau) : au clavier,
          Tab sauterait alors une tuile qu'il ne devrait que désactiver. Désactivée via
          `aria-disabled`/`pointer-events-none`/`tabIndex={-1}` tant qu'il n'y a rien à télécharger ;
          `href`/`download` ne portent une vraie valeur qu'une fois l'aperçu prêt. */}
      <a
        data-testid="proof-tile-download"
        data-format={format}
        href={dataUri ?? undefined}
        download={dataUri !== null ? previewFileName(templateId, format) : undefined}
        aria-disabled={dataUri === null}
        tabIndex={dataUri === null ? -1 : 0}
        title={dataUri !== null ? `Télécharger ${preset.label} en PNG` : undefined}
        className={`absolute right-3 top-3 rounded-lg bg-background/90 p-1 ring-1 ring-foreground/10 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
          dataUri !== null
            ? "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            : "pointer-events-none opacity-0"
        }`}
      >
        <Download className="size-3.5" />
        <span className="sr-only">Télécharger {preset.label}</span>
      </a>
    </div>
  );
}

export function ProofSheet({
  templateId, scene, nativeFormat, articleId, disabled, onFocus, onTileOutcome, initialOutcomes,
}: ProofSheetProps) {
  return (
    <div
      data-testid="proof-sheet"
      className="grid min-h-0 flex-1 auto-rows-min gap-3 overflow-auto rounded-xl bg-[var(--canvas-backdrop)] p-3"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}
    >
      {FORMAT_KEYS.map((format) => (
        <ProofTile
          key={format}
          templateId={templateId} scene={scene} nativeFormat={nativeFormat} format={format}
          articleId={articleId} disabled={disabled}
          onFocus={onFocus} onTileOutcome={onTileOutcome}
          initial={initialOutcomes?.[format]}
        />
      ))}
    </div>
  );
}
