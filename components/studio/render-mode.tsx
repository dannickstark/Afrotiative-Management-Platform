"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw, ZoomIn, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { PreviewPane, ARTICLE_SELECTABLE_CONTEXTS } from "./preview-pane";
import { previewTemplate } from "@/lib/actions/studio-preview-actions";
import { FORMAT_PRESETS, FORMAT_KEYS, type FormatKey } from "@/lib/studio/formats";
import type { Scene } from "@/lib/studio/scene";
import type { TemplateContext } from "@/lib/studio/tokens";
import type { PreviewArticleOption } from "@/lib/queries/studio";
import type { PreservedView } from "@/lib/studio/studio-mode";

// components/studio/render-mode.tsx — Tâche 5 (U1, spec §5) : « Rendu réel » — le second mode de
// l'éditeur. Aucun rail, aucun panneau accosté, aucune colonne de propriétés : le rendu occupe tout
// l'espace (editor-shell.tsx ne rend NI Rail NI PanelHost NI PropertyPanel/CalquesPanel dans ce
// mode — voir la branche `mode === "rendu"`).
//
// « Reuse PreviewPane for the large slot rather than writing a second render path » (brief) : la
// grande case est LITTÉRALEMENT un <PreviewPane> — même debounce 800 ms, même sélecteur d'article,
// même garantie structurelle « n'écrit rien » (tests/studio-preview.test.ts). La bande de vignettes,
// elle, appelle previewTemplate() DIRECTEMENT (via FilmstripThumb plus bas) plutôt que d'instancier
// sept <PreviewPane> complets — chacun apporterait sa PROPRE en-tête/sélecteur d'article/bouton
// Actualiser, une UI bien trop lourde pour une vignette de ~110px (brief : « small render requests
// for the filmstrip »).
//
// LIMITE HONNÊTE (spec §5, § final) : tant que U5 (re-layout) n'existe pas, les calques d'une scène
// conçue pour `format` gardent leurs positions ABSOLUES quand on les rend sur un autre format — sept
// des huit vignettes montreront donc un gabarit taillé pour un autre rapport largeur/hauteur
// (recadré/mal placé). C'est un signal UTILE (« ce gabarit ne s'adapte pas encore »), pas un bug à
// masquer : AUCUNE affordance « adapter »/« réagencer » n'apparaît nulle part dans ce fichier, et
// aucune bulle d'aide ne promet cette fonctionnalité — voir tests/studio-render-mode.test.ts.
const MAX_RENDER_ZOOM = 1; // spec §5 : « zoomable à 100 % pour inspecter la typo » — jamais au-delà.

export interface RenderModeProps {
  templateId: string;
  context: TemplateContext;
  scene: Scene;
  /** Format NATIF du gabarit (render_templates.format) — le repli quand `view.selectedId` ne pointe
   * vers aucun format promu (spec §5 : « le format courant rendu en grand »). */
  format: FormatKey;
  articles?: PreviewArticleOption[];
  disabled?: boolean;
  /** État de vue partagé avec le mode Montage (lib/studio/studio-mode.ts#PreservedView) : ICI,
   * `selectedId` porte le format PROMU (`null` = le format natif ci-dessus), `zoom`/`scrollX`/
   * `scrollY` la case large. Contrôlé par l'appelant (editor-shell.tsx) — JAMAIS de useState interne
   * pour ces trois champs — c'est ce qui garantit qu'ils survivent à un aller-retour de mode : un
   * démontage de RenderMode (quand `mode` repasse à "montage") ne perd rien, puisque rien n'y vit. */
  view: PreservedView;
  onViewChange: (view: PreservedView) => void;
  // Amorces de test UNIQUEMENT (même convention que ManualGenerate.initialContext,
  // components/studio/manual-generate.tsx) — la vraie composition (editor-shell.tsx) ne les fournit
  // JAMAIS : `degraded` provient de PreviewPane.onResult (ci-dessous), `stale` de la comparaison
  // scène courante / scène de la DERNIÈRE bande de vignettes rendue (voir l'effet plus bas) — les
  // deux ne se déclenchent qu'après un aller-retour réseau, invisible à un rendu STATIQUE
  // (react-dom/server n'exécute aucun effet). Sans ces amorces, tests/studio-render-mode.test.ts ne
  // pourrait vérifier ni légende sans harnais DOM ni Server Action mockée.
  initialDegraded?: boolean;
  initialStale?: boolean;
}

// Même scène, calques INCHANGÉS, canevas remplacé par les dimensions de `key` — c'est EXACTEMENT le
// mécanisme que tests/studio-preview.test.ts vérifie déjà côté moteur (« une scène cliente qui ne
// diffère que par les dimensions du canevas »#Critique 1) : aucune ligne `renders`/objet R2 n'est
// jamais écrite, quel que soit le format demandé (previewTemplate -> previewTemplateCore ->
// renderScene, jamais renderForArticle/saveRender).
function sceneForFormat(scene: Scene, key: FormatKey, native: FormatKey): Scene {
  if (key === native) return scene;
  const preset = FORMAT_PRESETS[key];
  return { ...scene, canvas: { ...scene.canvas, width: preset.width, height: preset.height } };
}

type ThumbState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; dataUri: string }
  | { status: "error" };

function FilmstripThumb({
  templateId, scene, nativeFormat, format, disabled, refreshNonce, onPromote,
}: {
  templateId: string;
  scene: Scene;
  nativeFormat: FormatKey;
  format: FormatKey;
  disabled?: boolean;
  refreshNonce: number;
  onPromote: (format: FormatKey) => void;
}) {
  const preset = FORMAT_PRESETS[format];
  const [state, setState] = useState<ThumbState>({ status: "idle" });
  const requestIdRef = useRef(0);

  // Se déclenche au montage puis à chaque bascule de `refreshNonce` (« ↻ rendre », voir RenderMode
  // ci-dessous) — JAMAIS à chaque frappe dans l'éditeur : sept rendus satori/resvg par touche serait
  // un coût réel (spec §5 : « le rendu est asynchrone » — c'est précisément ce qui justifie le badge
  // « Périmé » plutôt qu'un rafraîchissement automatique comme PreviewPane). `scene` est
  // délibérément ABSENTE des dépendances : elle est lue depuis la fermeture au moment où l'effet
  // s'exécute (montage, ou nonce bascule après un rendu PARENT à jour) — jamais mémorisée séparément.
  useEffect(() => {
    if (disabled) return;
    const id = ++requestIdRef.current;
    setState({ status: "loading" });
    const variant = sceneForFormat(scene, format, nativeFormat);
    previewTemplate({ templateId, scene: variant })
      .then((res) => {
        if (id !== requestIdRef.current) return;
        setState(res.ok ? { status: "ready", dataUri: res.dataUri } : { status: "error" });
      })
      .catch(() => {
        if (id === requestIdRef.current) setState({ status: "error" });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, format, nativeFormat, refreshNonce, disabled]);

  return (
    <button
      type="button"
      data-testid="filmstrip-thumb"
      data-format={format}
      onClick={() => onPromote(format)}
      title={`Promouvoir ${preset.label} dans la case large`}
      className="flex w-28 shrink-0 flex-col gap-1 rounded-lg border p-1 text-left transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span
        className="flex items-center justify-center overflow-hidden rounded bg-muted/30"
        style={{ aspectRatio: `${preset.width} / ${preset.height}` }}
      >
        {state.status === "ready" && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={state.dataUri} alt={`Aperçu — ${preset.label}`} className="h-full w-full object-contain" />
        )}
        {state.status === "loading" && <span className="text-[10px] text-muted-foreground">…</span>}
        {state.status === "error" && <span className="text-[10px] text-destructive">Échec</span>}
        {state.status === "idle" && <span className="text-[10px] text-muted-foreground">En attente…</span>}
      </span>
      <span className="truncate text-[11px] font-medium">{preset.label}</span>
      <span className="text-[10px] text-muted-foreground">{preset.width}×{preset.height}</span>
    </button>
  );
}

export function RenderMode({
  templateId, context, scene, format, articles, disabled, view, onViewChange,
  initialDegraded = false, initialStale = false,
}: RenderModeProps) {
  // Défensif : `view.selectedId` est un `string | null` générique (lib/studio/studio-mode.ts) — ne
  // JAMAIS indexer FORMAT_PRESETS avec une valeur qui ne serait pas une clé de format réelle (rien
  // ne devrait jamais y écrire autre chose que ce que `promote()` pose plus bas, mais un futur
  // appelant qui réutiliserait `view.selectedId` pour autre chose — une sélection de calque, par
  // exemple — ne doit pas faire planter ce composant).
  const largeFormat: FormatKey =
    view.selectedId && (FORMAT_KEYS as readonly string[]).includes(view.selectedId)
      ? (view.selectedId as FormatKey)
      : format;
  const largeScene = sceneForFormat(scene, largeFormat, format);
  const otherFormats = FORMAT_KEYS.filter((key) => key !== largeFormat);

  const [degraded, setDegraded] = useState(initialDegraded);

  // Périmée = la scène courante diffère de celle utilisée pour la DERNIÈRE bande de vignettes
  // rendue. Ne concerne QUE la bande (voir le commentaire de FilmstripThumb ci-dessus) — la case
  // large, elle, reste TOUJOURS à jour d'elle-même (PreviewPane se rafraîchit seul, 800 ms après
  // stabilisation, exactement comme dans la colonne propriétés du mode Montage).
  const [stale, setStale] = useState(initialStale);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const renderedSceneRef = useRef(scene);
  useEffect(() => {
    if (scene !== renderedSceneRef.current) setStale(true);
  }, [scene]);

  function rerenderFilmstrip() {
    renderedSceneRef.current = scene;
    setStale(false);
    setRefreshNonce((n) => n + 1);
  }

  function promote(key: FormatKey) {
    onViewChange({ ...view, selectedId: key === format ? null : key });
  }

  function setZoom(zoom: number | "fit") {
    onViewChange({ ...view, zoom });
  }

  // Défilement de la case large : ÉCRAN -> état à chaque défilement (handleScroll), état -> ÉCRAN
  // seulement quand `largeFormat` change (promotion d'une vignette, ou retour d'un aller-retour de
  // mode) — jamais à chaque rendu, sous peine de figer le défilement natif du navigateur en
  // réécrivant sa position à chaque frappe ailleurs dans l'éditeur.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = view.scrollX;
    el.scrollTop = view.scrollY;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [largeFormat]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    onViewChange({ ...view, scrollX: el.scrollLeft, scrollY: el.scrollTop });
  }

  // « provenance stated — sample values or a chosen article » (spec §5) : PreviewPane porte déjà ce
  // choix (son sélecteur « Valeurs d'exemple » / article, visible uniquement pour les contextes
  // article_image/social_post — components/studio/preview-pane.tsx) mais ne l'affiche QUE quand des
  // articles sont fournis pour un contexte éligible ; les trois contextes à saisie manuelle (citation,
  // bandeau, récap — components/studio/manual-generate.tsx) n'ont, eux, JAMAIS d'article associé et
  // utilisent toujours les valeurs d'exemple. Cette légende, TOUJOURS visible, couvre les deux cas
  // sans dupliquer l'état interne (privé) du sélecteur de PreviewPane — `ARTICLE_SELECTABLE_CONTEXTS`
  // est réexportée par preview-pane.tsx pour cette raison précise, pas recopiée ici.
  const showArticlePicker = ARTICLE_SELECTABLE_CONTEXTS.includes(context) && !!articles?.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4" data-testid="render-mode">
      <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="render-large" data-format={largeFormat}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{FORMAT_PRESETS[largeFormat].label}</span>
            <span className="text-xs text-muted-foreground">
              {FORMAT_PRESETS[largeFormat].width}×{FORMAT_PRESETS[largeFormat].height}
            </span>
            {degraded && (
              <Badge variant="secondary" data-testid="render-degraded-badge">
                Rendu dégradé — une police est repliée sur la police par défaut
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1 rounded-lg border p-0.5">
            <Button
              type="button" variant={view.zoom === "fit" ? "secondary" : "ghost"} size="icon-sm"
              title="Ajuster à l'écran" data-action="zoom-fit" onClick={() => setZoom("fit")}
            >
              <Maximize2 />
            </Button>
            <Button
              type="button" variant={view.zoom === MAX_RENDER_ZOOM ? "secondary" : "ghost"} size="icon-sm"
              title="Zoomer à 100 % pour inspecter la typo" data-action="zoom-100"
              onClick={() => setZoom(MAX_RENDER_ZOOM)}
            >
              <ZoomIn />
            </Button>
          </div>
        </div>

        <p className="text-xs text-muted-foreground" data-testid="render-provenance">
          {showArticlePicker
            ? "Provenance : valeurs d'exemple, ou l'article choisi dans le sélecteur ci-dessous."
            : "Provenance : valeurs d'exemple."}
        </p>

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className={cn(
            "min-h-0 flex-1 rounded-lg border bg-muted/20 p-4",
            view.zoom === "fit" ? "flex items-center justify-center overflow-hidden" : "overflow-auto",
          )}
        >
          <div
            style={
              view.zoom === "fit"
                ? { width: "100%", height: "100%" }
                : { width: FORMAT_PRESETS[largeFormat].width * (view.zoom as number) }
            }
          >
            <PreviewPane
              templateId={templateId} context={context} scene={largeScene} articles={articles}
              disabled={disabled}
              onResult={(res) => setDegraded(res?.degraded ?? false)}
            />
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">Autres formats</span>
          {stale && (
            <div className="flex items-center gap-2">
              <Badge variant="secondary" data-testid="render-stale-badge">Périmé</Badge>
              <Button
                type="button" variant="outline" size="sm" data-action="rerender"
                disabled={disabled} onClick={rerenderFilmstrip}
              >
                <RefreshCw />↻ rendre
              </Button>
            </div>
          )}
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1" data-testid="render-filmstrip">
          {otherFormats.map((key) => (
            <FilmstripThumb
              key={key} templateId={templateId} scene={scene} nativeFormat={format} format={key}
              disabled={disabled} refreshNonce={refreshNonce} onPromote={promote}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
