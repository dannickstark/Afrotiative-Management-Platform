"use client";

import { useEffect, useMemo, useRef } from "react";
import { ArrowLeft, Download, Maximize2, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { usePreview, type PreviewState } from "@/hooks/use-preview";
import { sceneForFormat } from "@/lib/studio/relayout";
import { formatNavAction, zoomStep, type PreservedView } from "@/lib/studio/studio-mode";
import { FORMAT_PRESETS, FORMAT_KEYS, type FormatKey } from "@/lib/studio/formats";
import { previewFileName } from "./export";
import type { TileOutcome } from "./proof-sheet";
import type { Scene } from "@/lib/studio/scene";

// components/studio/render/format-focus.tsx — UN format, en grand, zoomable et exportable.
//
// LE défaut d'origine que ce fichier corrige : l'ancienne grande case était un <PreviewPane>, qui
// imposait `aspectRatio: canvas.width/height` à sa boîte image, LUI-MÊME enveloppé dans un
// `width:100%;height:100%` sous `overflow-hidden`. Pour une story (1080×1920) la boîte calculait
// 1,78× la largeur du conteneur en hauteur : rognée, jamais ajustée. « Ajuster à l'écran »
// n'ajustait pas.
//
// Le correctif n'est pas un calcul plus malin, c'est la SUPPRESSION des deux règles imbriquées : en
// mode « fit », un simple `object-contain` dans un conteneur `flex-1 min-h-0` ajuste correctement,
// sans la moindre mesure JS. Le zoom explicite, lui, pose une largeur en pixels et laisse défiler.
export interface FormatFocusProps {
  templateId: string;
  scene: Scene;
  nativeFormat: FormatKey;
  format: FormatKey;
  articleId: string | null;
  disabled?: boolean;
  view: PreservedView;
  onViewChange: (view: PreservedView) => void;
  onExit: () => void;
  onFormatChange: (format: FormatKey) => void;
  /** Résultats connus de la planche — alimente les puces d'alerte de la bande de formats. */
  outcomes: Partial<Record<FormatKey, TileOutcome>>;
  // Amorce de test UNIQUEMENT — même convention que RenderModeProps.initialDegraded.
  initialState?: PreviewState;
}

export function FormatFocus({
  templateId, scene, nativeFormat, format, articleId, disabled,
  view, onViewChange, onExit, onFormatChange, outcomes, initialState,
}: FormatFocusProps) {
  const preset = FORMAT_PRESETS[format];
  const variant = useMemo(
    () => sceneForFormat(scene, format, nativeFormat),
    [scene, format, nativeFormat],
  );
  const live = usePreview({ templateId, scene: variant, format, articleId, enabled: !disabled });
  const state = initialState ?? live.state;

  // ← / → / Échap. La DÉCISION vit dans lib/studio/studio-mode.ts (pure, testée sans DOM) ; ce
  // composant ne fait que traduire l'événement réel du navigateur en littéral avant de l'interroger.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as (HTMLElement | null);
      const action = formatNavAction({
        key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey,
        target: target ? { tagName: target.tagName, isContentEditable: target.isContentEditable } : null,
      });
      if (action === null) return;
      e.preventDefault();
      if (action === "exit") { onExit(); return; }
      const index = FORMAT_KEYS.indexOf(format);
      const next = action === "next"
        ? (index + 1) % FORMAT_KEYS.length
        : (index - 1 + FORMAT_KEYS.length) % FORMAT_KEYS.length;
      onFormatChange(FORMAT_KEYS[next]!);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [format, onExit, onFormatChange]);

  // Défilement : ÉCRAN -> état à chaque défilement, état -> ÉCRAN seulement au changement de format
  // ou de zoom — jamais à chaque rendu, sous peine de figer le défilement natif du navigateur en
  // réécrivant sa position à chaque frappe ailleurs dans l'éditeur.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = view.scrollX;
    el.scrollTop = view.scrollY;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format, view.zoom]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    onViewChange({ ...view, scrollX: el.scrollLeft, scrollY: el.scrollTop });
  }

  const dataUri = state.status === "ready" ? state.dataUri : null;
  const isFit = view.zoom === "fit";
  const pixelWidth = isFit ? null : Math.round(preset.width * (view.zoom as number));

  return (
    <div
      data-testid="format-focus" data-format={format}
      className="flex min-h-0 flex-1 flex-col gap-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button" variant="ghost" size="sm"
          data-testid="format-focus-back" onClick={onExit}
        >
          <ArrowLeft />Planche
        </Button>
        <span className="text-sm font-medium">{preset.label}</span>
        <span className="text-xs text-muted-foreground">{preset.width}×{preset.height}</span>

        <div className="ml-auto flex items-center gap-1 rounded-lg border p-0.5" data-testid="format-focus-zoom">
          <Button
            type="button" variant={isFit ? "secondary" : "ghost"} size="icon-sm"
            title="Ajuster à l'écran" data-action="zoom-fit"
            onClick={() => onViewChange({ ...view, zoom: "fit" })}
          >
            <Maximize2 />
          </Button>
          <Button
            type="button" variant="ghost" size="icon-sm"
            title="Réduire" data-action="zoom-out"
            onClick={() => onViewChange({ ...view, zoom: zoomStep(view.zoom, -1) })}
          >
            <Minus />
          </Button>
          <span className="min-w-10 text-center text-xs tabular-nums text-muted-foreground">
            {isFit ? "Ajusté" : `${Math.round((view.zoom as number) * 100)} %`}
          </span>
          <Button
            type="button" variant="ghost" size="icon-sm"
            title="Agrandir — jamais au-delà de 100 % : au-dessus des pixels natifs, on inspecterait un agrandissement, pas une typographie."
            data-action="zoom-in"
            onClick={() => onViewChange({ ...view, zoom: zoomStep(view.zoom, 1) })}
          >
            <Plus />
          </Button>
        </div>

        {/* Toujours rendue — SIBLING du reste, jamais conditionnée à `dataUri !== null` : le harnais de
            test statique (`renderToStaticMarkup`) n'exécute aucun effet, donc `dataUri` y est TOUJOURS
            `null` même quand `initialState` porte un `dataUri`. Même solution que
            components/studio/render/proof-sheet.tsx (bouton de téléchargement de tuile) : rendu inerte
            via `aria-disabled`/`pointer-events-none`/`tabIndex={-1}` et `href` omis tant qu'il n'y a
            rien à télécharger, `href`/`download` ne portent une vraie valeur qu'une fois l'aperçu prêt. */}
        <a
          data-testid="format-focus-download"
          href={dataUri ?? undefined}
          download={dataUri !== null ? previewFileName(templateId, format) : undefined}
          aria-disabled={dataUri === null}
          tabIndex={dataUri === null ? -1 : 0}
          title={dataUri !== null ? `Télécharger ${preset.label} en PNG` : undefined}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            dataUri !== null ? "hover:bg-muted" : "pointer-events-none opacity-0",
          )}
        >
          <Download className="size-4" />PNG
        </a>
      </div>

      <div className="flex gap-1 overflow-x-auto pb-1" data-testid="format-focus-strip">
        {FORMAT_KEYS.map((key) => {
          const o = outcomes[key];
          const flagged = o?.overflow === true || o?.lowRes === true;
          return (
            <button
              key={key} type="button"
              data-testid="format-focus-pill" data-format={key}
              onClick={() => onFormatChange(key)}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-4xl px-2 py-0.5 text-[11px] transition-colors",
                key === format ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              {FORMAT_PRESETS[key].label}
              {flagged && (
                <span
                  data-testid="format-focus-pill-dot" data-format={key}
                  className="size-1.5 rounded-4xl bg-amber-600 dark:bg-amber-500"
                />
              )}
            </button>
          );
        })}
      </div>

      {state.status === "ready" && state.degraded && (
        <Badge variant="secondary" data-testid="format-focus-degraded">
          Rendu dégradé — une police est repliée sur la police par défaut.
        </Badge>
      )}
      {state.status === "ready" && state.overflow && (
        <p className="text-xs text-amber-600 dark:text-amber-500" data-testid="format-focus-overflow">
          Un texte contraint dépasse sa limite de lignes dans ce format : il risque de déborder du
          cadre. Mesure faite avec la police de repli — approximative si ce calque porte une police
          personnalisée.
        </p>
      )}
      {state.status === "ready" && state.lowRes && (
        <p className="text-xs text-amber-600 dark:text-amber-500" data-testid="format-focus-lowres">
          La photo source est plus petite que son cadre dans ce format : elle est agrandie, donc
          floue. Réduire le cadre ou fournir une image plus grande — aucun réglage du gabarit ne peut
          compenser.
        </p>
      )}

      <div
        ref={scrollRef} onScroll={handleScroll}
        className={cn(
          "min-h-0 flex-1 rounded-xl bg-[var(--canvas-backdrop)] p-4",
          isFit ? "flex items-center justify-center overflow-hidden" : "overflow-auto",
        )}
      >
        {/* En « fit » : AUCUNE largeur imposée, AUCUN aspect-ratio — `object-contain` dans ce
            conteneur flex ajuste seul. En zoom : une largeur en pixels, et le conteneur défile. */}
        <div
          data-testid="format-focus-surface"
          className={isFit ? "flex h-full w-full items-center justify-center" : undefined}
          style={pixelWidth === null ? undefined : { width: pixelWidth }}
        >
          {dataUri !== null && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={dataUri} alt={`Rendu — ${preset.label}`}
              className={isFit ? "max-h-full max-w-full object-contain" : "w-full"}
            />
          )}
          {state.status === "loading" && (
            <span className="text-xs text-muted-foreground">Génération du rendu…</span>
          )}
          {state.status === "idle" && <span className="text-xs text-muted-foreground">En attente…</span>}
          {state.status === "error" && (
            <p className="p-3 text-center text-xs text-destructive">{state.message}</p>
          )}
        </div>
      </div>
    </div>
  );
}
