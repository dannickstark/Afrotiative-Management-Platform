"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw, ZoomIn, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { PreviewPane, ARTICLE_SELECTABLE_CONTEXTS } from "./preview-pane";
import { previewTemplate } from "@/lib/actions/studio-preview-actions";
import { FORMAT_PRESETS, FORMAT_KEYS, type FormatKey } from "@/lib/studio/formats";
import { relayoutToFormat } from "@/lib/studio/relayout";
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
// CHANTIER D, TÂCHE 6 — le correctif de la limite honnête ci-dessus (spec §5, § final) : U5 est
// désormais `lib/studio/relayout.ts` (chantier D, Tâche 2), et `sceneForFormat` ci-dessous l'appelle
// RÉELLEMENT (`relayoutToFormat(scene, key)`), plus un simple redimensionnement du canevas. Les sept
// vignettes montrent donc, pour la première fois, le gabarit RÉAGENCÉ pour chaque format — pas une
// version recadrée/mal placée de sa mise en page d'accueil. AUCUNE affordance « adapter »/
// « réagencer » n'apparaît pour autant nulle part dans ce fichier : il n'y en a pas besoin, le
// réagencement est désormais AUTOMATIQUE (piloté par les contraintes par calque, chantier D Tâche 1),
// pas une action que l'utilisateur déclenche — voir tests/studio-render-mode.test.ts.
//
// COÛT DES RENDUS (Important 2, revue Tâche 5) : entrer en Rendu réel déclenche jusqu'à HUIT appels
// previewTemplate() — un pour la case large (PreviewPane) et sept pour la bande — et AUCUN des deux
// chemins ne passe par le cache de rendu de V1 (lib/studio/store.ts : computeInputHash/
// findCachedRender/saveRender). Vérifié, pas supposé : previewTemplateCore (lib/studio/preview-core.ts,
// le cœur derrière previewTemplate) appelle renderScene() DIRECTEMENT, jamais renderForArticle
// (lib/studio/index.ts, le SEUL appelant réel de ce cache) — et tests/studio-preview.test.ts prouve
// STRUCTURELLEMENT (parcours du graphe d'imports réel) que store.ts n'est atteignable PAR AUCUN
// CHEMIN depuis preview-core.ts ni depuis render.ts. C'est un choix DÉLIBÉRÉ de V2 (l'aperçu doit
// refléter le brouillon EN MÉMOIRE, jamais une version en cache clé par templateVersion — une scène
// non enregistrée n'a pas de version stable à cacher) et il serait FAUX d'y greffer ce cache : la
// garantie testée « l'aperçu n'écrit rien » (même fichier) inclut `saveRender`, le seul chemin
// d'écriture du cache. Chaque vignette est donc un VRAI rendu satori/resvg/sharp à chaque entrée en
// Rendu réel — pas un lookup DB bon marché. Le correctif proportionné (spec de la revue) est de ne
// PAS re-rendre les vignettes hors champ : voir l'IntersectionObserver de FilmstripThumb ci-dessous.
// Une mémoïsation inter-bascules de mode (survivre à un démontage de RenderMode) résoudrait aussi le
// problème mais construirait un second cache côté client — délibérément hors du périmètre de ce
// correctif, noté comme suite possible dans le rapport de la Tâche 5.
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
  // Chantier D, Tâche 6 (handoff H1) — amorce de test UNIQUEMENT, même convention que les deux
  // champs juste au-dessus : les formats pour lesquels FilmstripThumb doit démarrer avec sa note
  // « Texte tronqué » déjà visible (voir FilmstripThumb.initialOverflow). La vraie composition
  // (editor-shell.tsx) ne fournit JAMAIS ce champ — RenderMode le passe toujours à `undefined`, et
  // chaque vignette démarre donc réellement sans note tant que son propre aller-retour réseau n'a
  // pas répondu.
  initialOverflowFormats?: readonly FormatKey[];
}

// Chantier D, Tâche 6 — LE gabarit RÉAGENCÉ pour `key`, pas seulement redimensionné : `key === native`
// reste une identité EXACTE (raccourci, mais `relayoutToFormat` serait de toute façon une identité
// mathématique dans ce cas précis — chantier D, Tâche 2, « identité au format d'accueil ») ; sinon,
// chaque calque prend le cadre que ses contraintes par calque (chantier D, Tâche 1 — ou sa surcharge
// par format, Tâche 5) prescrivent pour `key`. EXPORTÉE pour que tests/studio-render-mode.test.ts
// puisse l'épingler directement contre `relayoutToFormat` (le §0 : cette fonction ET
// lib/studio/index.ts#renderForArticle — le chemin de GÉNÉRATION — appellent toutes deux CETTE MÊME
// fonction pure, jamais deux implémentations parallèles qui pourraient diverger).
//
// `previewTemplate` (appelé par FilmstripThumb ci-dessous avec CETTE scène déjà relayoutée) reste
// structurellement incapable d'écrire quoi que ce soit — voir toujours tests/studio-preview.test.ts
// (« une scène cliente qui ne diffère que par les dimensions du canevas »#Critique 1) : aucune ligne
// `renders`/objet R2 n'est jamais écrite, quel que soit le format demandé (previewTemplate ->
// previewTemplateCore -> renderScene, jamais renderForArticle/saveRender).
export function sceneForFormat(scene: Scene, key: FormatKey, native: FormatKey): Scene {
  if (key === native) return scene;
  return relayoutToFormat(scene, key);
}

type ThumbState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; dataUri: string }
  | { status: "error" };

function FilmstripThumb({
  templateId, scene, nativeFormat, format, disabled, refreshNonce, onPromote, initialOverflow = false,
}: {
  templateId: string;
  scene: Scene;
  nativeFormat: FormatKey;
  format: FormatKey;
  disabled?: boolean;
  refreshNonce: number;
  onPromote: (format: FormatKey) => void;
  // Chantier D, Tâche 6 (handoff H1) — amorce de test UNIQUEMENT, même convention que
  // RenderModeProps.initialDegraded/initialStale ci-dessous : la vraie composition (RenderMode) ne la
  // fournit JAMAIS, elle vaut toujours `false` au montage réel. `overflow` (l'état ci-dessous) ne
  // devient vrai qu'après le VRAI aller-retour réseau (previewTemplate -> overflowingLayerIds,
  // lib/studio/relayout-warn.ts), invisible à un rendu STATIQUE (react-dom/server n'exécute aucun
  // effet) — sans cette amorce, tests/studio-render-mode.test.ts ne pourrait jamais affirmer que la
  // légende de débordement SUIT réellement un résultat plutôt que d'être un texte figé dans le JSX.
  initialOverflow?: boolean;
}) {
  const preset = FORMAT_PRESETS[format];
  const [state, setState] = useState<ThumbState>({ status: "idle" });
  // Chantier D, Tâche 6 (handoff H1) — le calque texte contraint qui déborde `maxLines` UNE FOIS ce
  // gabarit relayouté vers CE format, mesuré côté serveur (previewTemplateCore ->
  // overflowingLayerIds, FALLBACK-FONT-APPROXIMATIF — handoff H2, voir le commentaire de
  // PreviewResult.overflowingLayerIds, lib/studio/preview-core.ts) — SÉPARÉ de `state` ci-dessus :
  // un rendu en ERREUR (state.status==="error") ne doit pas effacer un débordement déjà connu d'un
  // rendu PRÉCÉDENT réussi, et inversement un rendu qui RÉUSSIT sans calque en débordement doit bien
  // faire RETOMBER cette alerte (pas de « sticky » optimiste dans un sens comme dans l'autre).
  const [overflow, setOverflow] = useState(initialOverflow);
  const requestIdRef = useRef(0);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Important 2 (revue Tâche 5) : previewTemplate() n'est JAMAIS gratuit ici (voir le commentaire
  // d'en-tête du fichier — aucun cache ne l'absorbe), donc rendre les SEPT vignettes inconditionnellement
  // au montage revient à sept rendus satori/resvg/sharp à chaque entrée en Rendu réel, même pour les
  // vignettes hors champ (la bande défile horizontalement, `overflow-x-auto` sur son conteneur).
  // IntersectionObserver ne déclenche `visible` qu'une fois cette vignette PRÉCISE entrée dans le
  // viewport — l'observateur tient compte de TOUT ancêtre à défilement/`overflow` qui la clippe, pas
  // seulement de `root` (comportement standard de l'API), donc une vignette scrollée hors de la bande
  // reste bien `isIntersecting: false` même avec `root` par défaut (le viewport du navigateur).
  // `.disconnect()` dès la première apparition : on ne veut PAS re-déclencher `visible` à chaque
  // sortie/entrée du viewport lors d'un défilement, seulement en découvrir l'existence une fois.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = buttonRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true); // repli : pas d'IntersectionObserver (jamais le cas en navigateur réel) -> rendu immédiat, comportement d'avant ce correctif.
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }, // amorce un peu AVANT l'entrée réelle dans le viewport, pour un défilement fluide.
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Se déclenche à la PREMIÈRE apparition dans le viewport (`visible`) puis à chaque bascule de
  // `refreshNonce` (« ↻ rendre », voir RenderMode ci-dessous) — JAMAIS à chaque frappe dans l'éditeur
  // (voir le commentaire de PÉRIMÉ plus bas) NI pour une vignette jamais scrollée jusqu'ici. `scene`
  // est délibérément ABSENTE des dépendances : elle est lue depuis la fermeture au moment où l'effet
  // s'exécute (première apparition, ou nonce bascule après un rendu PARENT à jour) — jamais mémorisée
  // séparément.
  useEffect(() => {
    if (disabled || !visible) return;
    const id = ++requestIdRef.current;
    setState({ status: "loading" });
    const variant = sceneForFormat(scene, format, nativeFormat);
    // Chantier D, Tâche 6 (handoff H1) — `format` transmis EN PLUS de `scene: variant` : c'est ce qui
    // fait calculer `overflowingLayerIds` côté serveur (voir PreviewTemplateInput.format,
    // lib/studio/preview-core.ts). Passer `variant` (déjà relayoutée) plutôt que `scene` brute ne
    // change PAS le résultat de la mesure — `overflowingLayerIds` relayoute lui-même en interne, et
    // `relayoutToFormat` est IDEMPOTENTE sur une scène déjà à ce format (chantier D, Tâche 2, identité)
    // — mais évite un second aller-retour distinct rien que pour cette mesure.
    previewTemplate({ templateId, scene: variant, format })
      .then((res) => {
        if (id !== requestIdRef.current) return;
        setState(res.ok ? { status: "ready", dataUri: res.dataUri } : { status: "error" });
        setOverflow(res.ok && res.overflowingLayerIds.length > 0);
      })
      .catch(() => {
        if (id === requestIdRef.current) { setState({ status: "error" }); setOverflow(false); }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, format, nativeFormat, refreshNonce, disabled, visible]);

  return (
    <button
      ref={buttonRef}
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
      {/* Chantier D, Tâche 6 (handoff H1) — la note « texte contraint qui déborde maxLines » que la
          Tâche 3 avait écrite mais laissée SANS appelant (geometry-strip.tsx la reçoit encore en
          prop, jamais fournie par property-panel.tsx) trouve ICI sa place naturelle : c'est LE
          filmstrip qu'un designer regarde pour évaluer chaque format, pas la bande de géométrie d'un
          format unique. Discrète, dans le style des autres notes de ce chantier, et UNIQUEMENT quand
          `overflow` est réellement vrai pour CE format précis — jamais un avertissement permanent.

          CORRECTIF HONNÊTETÉ (revue de branche, avant fusion chantier D) : le libellé disait « Texte
          tronqué » et le survol « le surplus sera coupé au rendu (maxLines) » — un MÉCANISME
          (troncage) que le moteur réel ne fournit PAS (voir le même correctif sur
          maxLinesOverflowNote, geometry-strip.tsx, pour la preuve : lineClamp de satori est inerte
          sur le style réellement peint, `display:"flex"`). Reformulé sans ce mécanisme : le texte
          DÉBORDE du cadre, il n'est pas proprement coupé. */}
      {overflow && (
        <span
          className="truncate text-[10px] text-amber-600 dark:text-amber-500"
          data-testid="filmstrip-overflow-badge"
          data-format={format}
          title="Un texte contraint dépasse sa limite de lignes dans ce format — il risque de déborder du cadre. Mesuré avec la police de repli, approximatif si ce calque porte une police personnalisée."
        >
          Texte déborde
        </span>
      )}
    </button>
  );
}

export function RenderMode({
  templateId, context, scene, format, articles, disabled, view, onViewChange,
  initialDegraded = false, initialStale = false, initialOverflowFormats,
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
  // utilisent toujours les valeurs d'exemple. Cette légende décrit UNIQUEMENT la case large — voir
  // Important 1 de la revue Tâche 5 : la bande de vignettes ci-dessous n'a PAS ce choix (FilmstripThumb
  // n'envoie jamais `articleId` à previewTemplate, ligne ~107) et porte donc sa PROPRE légende, plus
  // bas, pour ne jamais laisser croire qu'elle suit le même sélecteur. `ARTICLE_SELECTABLE_CONTEXTS`
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
            ? "Provenance de cette case : valeurs d'exemple, ou l'article choisi dans le sélecteur ci-dessous."
            : "Provenance de cette case : valeurs d'exemple."}
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
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium">Autres formats</span>
            {/* Important 1 (revue Tâche 5) : la bande n'a PAS le choix « article » de la case large
                — FilmstripThumb (ci-dessus) appelle previewTemplate SANS `articleId`, toujours avec
                les valeurs d'exemple, quel que soit l'article sélectionné dans PreviewPane au-dessus.
                Légende SÉPARÉE et TOUJOURS visible plutôt qu'une extension du texte de la case large,
                pour que ce fait reste vrai même si la case large montre un article. */}
            <span className="text-xs text-muted-foreground" data-testid="render-filmstrip-provenance">
              {"Ces vignettes utilisent toujours des valeurs d'exemple, quel que soit l'article choisi ci-dessus."}
            </span>
          </div>
          {stale && (
            <div className="flex items-center gap-2">
              <Badge variant="secondary" data-testid="render-stale-badge">Périmé</Badge>
              <Button
                type="button" variant="outline" size="sm" data-action="rerender"
                disabled={disabled} onClick={rerenderFilmstrip}
              >
                <RefreshCw />rendre
              </Button>
            </div>
          )}
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1" data-testid="render-filmstrip">
          {otherFormats.map((key) => (
            <FilmstripThumb
              key={key} templateId={templateId} scene={scene} nativeFormat={format} format={key}
              disabled={disabled} refreshNonce={refreshNonce} onPromote={promote}
              initialOverflow={initialOverflowFormats?.includes(key) ?? false}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
