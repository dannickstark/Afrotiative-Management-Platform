"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, Undo2, Redo2 } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Canvas } from "./canvas";
import { Rail } from "./rail";
import { PanelHost } from "./panel-host";
import { CalquesPanel } from "./panels/calques-panel";
import { ModelesPanel } from "./panels/modeles-panel";
import { ImagesPanel } from "./panels/images-panel";
import { MarquePanel, type MarqueCategoryColor } from "./panels/marque-panel";
import { TextePanel } from "./panels/texte-panel";
import { ElementsPanel } from "./panels/elements-panel";
import { PropertyPanel } from "./property-panel";
import { VersionHistory } from "./version-history";
import { ModeSwitch } from "./mode-switch";
import { RenderMode } from "./render-mode";
import { editorReducer, initEditorState, undo, redo } from "@/lib/studio/editor-state";
import { createAutosaveController, type AutosaveState } from "@/lib/studio/autosave";
import { shouldShowUnpublishedBadge } from "@/lib/studio/scene-diff";
import { validateScene, type TemplateContext } from "@/lib/studio/tokens";
import { saveTemplateScene, publishTemplate } from "@/lib/actions/studio-actions";
import { StorageBanner } from "./storage-banner";
import { useEditorPrefs } from "@/hooks/use-editor-prefs";
import { nextOpenPanel, type RailCategory } from "@/lib/studio/editor-prefs";
import { withRecentShape } from "@/lib/studio/shape-gallery";
import { preserveView, type StudioMode, type PreservedView } from "@/lib/studio/studio-mode";
import type { Scene } from "@/lib/studio/scene";
import type { FormatKey } from "@/lib/studio/formats";
import type { TemplateVersionRow, PreviewArticleOption, TemplateRow, CategoryOption } from "@/lib/queries/studio";
import type { AssetRow } from "@/lib/queries/assets";

// components/studio/editor-shell.tsx — Tâche 9 : compose canevas + panneau de calques + panneau de
// propriétés + aperçu réel + historique, et porte l'autosauvegarde et la publication (spec §3).
// Tâche 1 (U1, spec §3) : le rail d'icônes + le panneau accosté remplacent la colonne de calques
// dédiée — voir le second bloc de commentaire, juste avant le rendu, pour le détail de la disposition.
const AUTOSAVE_DELAY_MS = 1500;

// Raccourci clavier repliant le panneau accosté (spec §9 / §3 : « ⌘/ »). Choix documenté dans le
// rapport de la Tâche 1 : ni Chrome ni Safari ne réservent Cmd+/ par défaut sur macOS (Cmd+Shift+/,
// qui produit « ? », ouvre la recherche du menu Aide — un raccourci DIFFÉRENT) donc pas de collision
// technique constatée ; conservé tel quel plutôt que le repli « ⌘. » envisagé par la spec.
const COLLAPSE_PANEL_KEY = "/";

const CONTEXT_LABEL: Record<TemplateContext, string> = {
  article_image: "Image à la une",
  social_post: "Publication sociale",
  quote_card: "Carte citation",
  newsletter_header: "Bandeau newsletter",
  recap_card: "Carte récap",
};

function autosaveLabel(s: AutosaveState): string {
  switch (s.status) {
    case "saving": return "Enregistrement…";
    case "saved": return "Enregistré";
    case "error": return `Échec — ${s.message ?? "erreur inconnue"}`;
    default: return s.dirty ? "Modifications non enregistrées" : "Enregistré";
  }
}

export interface EditorShellTemplate {
  id: string;
  name: string;
  context: TemplateContext;
  channel: string | null;
  categoryId: string | null;
  format: FormatKey;
  width: number;
  height: number;
  archived: boolean;
  publishedVersion: number | null;
}

export interface EditorShellProps {
  template: EditorShellTemplate;
  initialScene: Scene;
  publishedScene: Scene | null;
  versions: TemplateVersionRow[];
  previewArticles: PreviewArticleOption[];
  // Tâche 13 (Lot 3) : la bibliothèque d'assets (Tâche 11), pour les sélecteurs de
  // components/studio/property-panel.tsx. Défaut [] pour ne pas casser un appelant qui n'aurait pas
  // encore cette prop (aucun aujourd'hui hors ce fichier, mais même filet que PropertyPanel lui-même).
  assets?: AssetRow[];
  // Tâche 15 (spec §8) : getStudioConfig() redescendu par le Server Component (app/(app)/studio/
  // [id]/page.tsx) — bannière + aperçu et publication désactivés quand le stockage R2 n'est pas
  // configuré, plutôt que d'échouer au clic. Défaut `true` : les appelants historiques (aucun
  // aujourd'hui hors cette page) restent pleinement fonctionnels sans cette prop.
  storageConfigured?: boolean;
  // Tâche 2 (U1, spec §3) : données du panneau « Modèles » (gabarits existants à dupliquer, groupés
  // par contexte, et les catégories du dialogue de création) — mêmes requêtes (lib/queries/studio.ts)
  // que app/(app)/studio/page.tsx, chargées UNE FOIS par le Server Component (app/(app)/studio/[id]/
  // page.tsx) et redescendues ici, jamais refetchées côté client. Défaut [] : un appelant qui
  // n'aurait pas encore ces props (aucun aujourd'hui hors cette page) affiche un panneau Modèles sans
  // gabarit à dupliquer, plutôt que de planter.
  templates?: TemplateRow[];
  categories?: CategoryOption[];
  // Tâche 2 (U1, spec §3) : données du panneau « Marque » (lecture seule) — brandLogoUrl() vient
  // d'une variable d'environnement (lib/studio/bindings.ts), categoryColors de wpCategories.color
  // (db/schema.ts) via getTaxonomy() (lib/queries/settings.ts) ; toutes deux lues UNIQUEMENT côté
  // serveur et redescendues en props, jamais importées ici (voir la note du fichier de page sur le
  // pool `pg`). Défauts "" / [] : mêmes garanties qu'assets/storageConfigured ci-dessus.
  brandLogoUrl?: string;
  categoryColors?: MarqueCategoryColor[];
}

// Composant EXTÉRIEUR : ne porte AUCUN état d'édition lui-même, seulement le mécanisme de
// rechargement après *Restaurer* (voir `sceneSeed`/`resetNonce` ci-dessous). C'est ce qui permet à
// `template`/`publishedScene`/`versions` de se rafraîchir NORMALEMENT en tant que simples PROPS
// après une publication (publishTemplate appelle déjà revalidatePath côté serveur,
// lib/actions/studio-actions.ts) SANS jamais remonter — donc SANS jamais perdre l'historique
// annuler/rétablir ni la sélection en cours — après un simple autosave, qui pose pourtant lui aussi
// `updatedAt` en base : les deux opérations ne sont PAS distinguables via les props seules, d'où ce
// découpage plutôt qu'une `key` posée sur `updatedAt`.
export function EditorShell(props: EditorShellProps) {
  const [sceneSeed, setSceneSeed] = useState(props.initialScene);
  const [resetNonce, setResetNonce] = useState(0);

  function handleRestore(scene: Scene) {
    setSceneSeed(scene);
    setResetNonce((n) => n + 1); // remonte SEULEMENT ici — jamais depuis un simple changement de props
  }

  return (
    <EditorShellInner
      key={resetNonce}
      template={props.template}
      initialScene={sceneSeed}
      publishedScene={props.publishedScene}
      versions={props.versions}
      previewArticles={props.previewArticles}
      assets={props.assets ?? []}
      storageConfigured={props.storageConfigured ?? true}
      templates={props.templates ?? []}
      categories={props.categories ?? []}
      brandLogoUrl={props.brandLogoUrl ?? ""}
      categoryColors={props.categoryColors ?? []}
      onRestore={handleRestore}
    />
  );
}

interface EditorShellInnerProps extends EditorShellProps {
  onRestore: (scene: Scene) => void;
}

function EditorShellInner({
  template, initialScene, publishedScene, versions, previewArticles, assets = [],
  templates = [], categories = [], brandLogoUrl = "", categoryColors = [],
  storageConfigured = true, onRestore,
}: EditorShellInnerProps) {
  const router = useRouter();
  const [state, dispatch] = useReducer(editorReducer, initialScene, initEditorState);

  // ── Rail + panneau accosté (Tâche 1, spec §3) ────────────────────────────
  const [prefs, setPrefs] = useEditorPrefs();

  function selectRailCategory(category: RailCategory) {
    setPrefs((p) => ({ ...p, openPanel: nextOpenPanel(p.openPanel, category) }));
  }

  // Replie le panneau au clavier (⌘/) — voir COLLAPSE_PANEL_KEY ci-dessus pour le choix documenté.
  // Ne fait rien quand aucun panneau n'est ouvert : le rail (clic) reste la SEULE façon d'en OUVRIR
  // un ; ce raccourci ne fait que reproduire l'action du chevron de panel-host.tsx.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== COLLAPSE_PANEL_KEY || (!e.metaKey && !e.ctrlKey)) return;
      e.preventDefault();
      setPrefs((p) => (p.openPanel ? { ...p, openPanel: nextOpenPanel(p.openPanel, p.openPanel) } : p));
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setPrefs]);

  // ── Modes Montage ⇄ Rendu réel (Tâche 5, U1 spec §5) ──────────────────────
  // `mode` ne pilote qu'un rendu CONDITIONNEL plus bas (jamais une `key` React) : basculer ne
  // démonte ni ne réinitialise `state`/`dispatch` (le réducteur de l'éditeur, ci-dessus) — c'est ce
  // qui garantit gratuitement que la sélection de calque courante (state.selectedId) survit à
  // l'aller-retour, sans le moindre code dédié. `view` (lib/studio/studio-mode.ts#PreservedView)
  // porte ce que le mode Montage ne porte PAS encore lui-même : le format promu dans la case large
  // de Rendu réel, son zoom et son défilement — voir components/studio/render-mode.tsx pour le
  // détail de cette réutilisation du champ `selectedId`. `preserveView` est l'identité par contrat
  // (voir sa documentation) ; l'appeler ICI, au point de bascule, documente explicitement où passer
  // une éventuelle transformation future plutôt que de copier silencieusement `view` d'un mode à
  // l'autre sans qu'aucun symbole ne porte cette garantie.
  const [mode, setMode] = useState<StudioMode>("montage");
  const [view, setView] = useState<PreservedView>({ selectedId: null, zoom: "fit", scrollX: 0, scrollY: 0 });
  function changeMode(next: StudioMode) {
    setMode(next);
    setView((v) => preserveView(v));
  }

  // ── Autosauvegarde (spec §3) ─────────────────────────────────────────────
  const [autosaveState, setAutosaveState] = useState<AutosaveState>({ status: "idle", message: null, dirty: false });
  const autosaveRef = useRef<ReturnType<typeof createAutosaveController<Scene>> | null>(null);
  if (!autosaveRef.current) {
    autosaveRef.current = createAutosaveController<Scene>({
      save: (scene) => saveTemplateScene(template.id, scene),
      delayMs: AUTOSAVE_DELAY_MS,
      onChange: setAutosaveState,
    });
  }
  const autosave = autosaveRef.current;
  useEffect(() => () => autosave.destroy(), [autosave]);

  // Ne notifie PAS tant que `state.scene` est encore LA MÊME RÉFÉRENCE que la valeur d'origine — le
  // serveur détient déjà exactement cette valeur, un autosave serait un aller-retour pour rien (et
  // afficherait « Enregistrement… » avant la moindre action de l'utilisateur). Comparée par
  // RÉFÉRENCE à une valeur capturée UNE FOIS (`initialSceneRef`), pas par un simple booléen « ai-je
  // déjà tourné » : repéré en vérifiant l'écran réel dans un navigateur (pas seulement en lisant le
  // code) — un booléen de type `mountedRef` se fait piéger par le double appel d'effet du Strict
  // Mode de React en développement (monte -> nettoie -> remonte, sur la MÊME instance, donc le
  // booléen reste déjà à `true` au second passage) et déclenchait un autosave fantôme au montage,
  // visible dans les journaux du serveur dev comme un saveTemplateScene() sans la moindre édition.
  // Le réducteur (lib/studio/editor-state.ts) garantit renvoyer LA MÊME référence tant qu'aucune
  // modification valide n'a été committée — cette comparaison est donc immunisée contre le nombre de
  // fois où l'effet est rejoué, Strict Mode ou pas.
  const initialSceneRef = useRef(initialScene);
  useEffect(() => {
    if (state.scene === initialSceneRef.current) return;
    autosave.notifyChange(state.scene);
  }, [state.scene, autosave]);

  // ── Publication (spec §3/§8) ─────────────────────────────────────────────
  const [publishing, setPublishing] = useState(false);
  const [publishErrors, setPublishErrors] = useState<string[] | null>(null);

  async function handlePublish() {
    setPublishing(true);
    setPublishErrors(null);
    try {
      // Publier doit voir le tout DERNIER brouillon, pas un instantané périmé par le différé
      // encore en attente (spec §3) — flush() force cet enregistrement et l'attend.
      const flushRes = await autosave.flush();
      if (flushRes && !flushRes.ok) {
        toast.error(`Publication annulée : l'enregistrement du brouillon a échoué (${flushRes.message}).`);
        return;
      }

      const res = await publishTemplate(template.id);
      if (res.ok) {
        toast.success(`Gabarit publié — version ${res.version}.`);
        router.refresh(); // rafraîchit publishedVersion/publishedScene/versions (props), sans remonter
        return;
      }

      // Champ par champ (spec §8) : validateScene(scene, contexte) reproduit exactement la liste
      // que publishTemplateCore a jointe dans res.message (même calcul des deux côtés — voir
      // tests/studio-autosave.test.ts) — recalculée ici pour l'afficher élément par élément plutôt
      // que comme un seul bloc de texte. Si elle est vide (refus pour une autre raison, ex. gabarit
      // introuvable), le message brut de l'action sert de repli.
      const errors = validateScene(state.scene, template.context);
      setPublishErrors(errors.length > 0 ? errors : [res.message]);
      toast.error("Publication refusée.");
    } finally {
      setPublishing(false);
    }
  }

  // ── Mise à l'échelle du canevas (spec §2) ────────────────────────────────
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = canvasWrapRef.current;
    if (!el) return;
    function computeScale() {
      const el2 = canvasWrapRef.current;
      if (!el2) return;
      const pad = 32;
      const availW = el2.clientWidth - pad;
      const availH = el2.clientHeight - pad;
      if (availW <= 0 || availH <= 0) return;
      const k = Math.min(availW / template.width, availH / template.height, 1);
      setScale(k > 0 ? k : 1);
    }
    computeScale();
    const ro = new ResizeObserver(computeScale);
    ro.observe(el);
    return () => ro.disconnect();
  }, [template.width, template.height]);

  const showUnpublishedBadge = shouldShowUnpublishedBadge(template.publishedVersion, state.scene, publishedScene);

  return (
    <div className="flex h-full flex-col gap-3" data-testid="editor-shell">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <Link href="/studio" className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }))} aria-label="Retour aux gabarits">
            <ArrowLeft />
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">{template.name}</h1>
            <p className="truncate text-xs text-muted-foreground">
              {CONTEXT_LABEL[template.context]} · {template.width}×{template.height}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {template.archived && <Badge variant="outline">Archivé</Badge>}
            {template.publishedVersion === null
              ? <Badge variant="secondary">Brouillon</Badge>
              : <Badge>Publié (v{template.publishedVersion})</Badge>}
            {showUnpublishedBadge && (
              <Badge variant="secondary" data-testid="unpublished-badge">Modifications non publiées</Badge>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span
            className={cn(
              "text-xs",
              autosaveState.status === "error" ? "text-destructive" : "text-muted-foreground",
            )}
            data-testid="autosave-status"
            data-status={autosaveState.status}
          >
            {autosaveLabel(autosaveState)}
          </span>
          <Button
            type="button" variant="ghost" size="icon-sm" title="Annuler"
            disabled={state.past.length === 0} onClick={() => dispatch(undo())}
          >
            <Undo2 />
          </Button>
          <Button
            type="button" variant="ghost" size="icon-sm" title="Rétablir"
            disabled={state.future.length === 0} onClick={() => dispatch(redo())}
          >
            <Redo2 />
          </Button>
          <VersionHistory
            templateId={template.id} publishedVersion={template.publishedVersion} versions={versions}
            onRestore={onRestore}
          />
          <Button
            type="button" data-action="publish" disabled={!storageConfigured || publishing}
            title={!storageConfigured ? "Indisponible : stockage R2 non configuré." : undefined}
            onClick={() => void handlePublish()}
          >
            {publishing ? "Publication…" : "Publier"}
          </Button>
        </div>
      </header>

      {!storageConfigured && <StorageBanner />}

      {publishErrors && (
        <div
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          data-testid="publish-errors"
        >
          <p className="font-medium">La publication a été refusée :</p>
          <ul className="list-disc pl-5">
            {publishErrors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}

      {/* Rail + panneau accosté + canevas + colonne propriétés (Tâche 1, spec §2/§3) EN Montage ;
          RenderMode (Tâche 5, spec §5) prend TOUT cet espace en Rendu réel — aucun des quatre
          (Rail/PanelHost/Canvas/colonne propriétés) n'est rendu dans ce second mode, voir
          components/studio/render-mode.tsx pour la preuve testée (tests/studio-render-mode.test.ts).
          ModeSwitch (le contrôle segmenté flottant) est un FRÈRE du contenu propre au mode, PAS un
          enfant de l'une ou l'autre branche — spec §5 : « centré au-dessus du canevas, présent dans
          les DEUX états » — positionné en absolu sur ce conteneur `relative`, `pt-11` lui réservant
          de la place plutôt que de chevaucher le haut du rail/canevas/case large. */}
      <div className="relative flex flex-1 gap-3 overflow-hidden pt-11">
        <ModeSwitch
          mode={mode} onChange={changeMode}
          className="absolute left-1/2 top-0 z-10 -translate-x-1/2"
        />

        {mode === "montage" ? (
          <>
            <Rail selected={prefs.openPanel} onSelect={selectRailCategory} />

            {prefs.openPanel && (
              <PanelHost
                open={prefs.openPanel}
                onOpenChange={(next) => setPrefs((p) => ({ ...p, openPanel: next }))}
              >
                {prefs.openPanel === "calques" && (
                  <CalquesPanel scene={state.scene} selectedId={state.selectedId} dispatch={dispatch} />
                )}
                {/* Modèles / Images / Marque (Tâche 2, U1 spec §3) : chaque panneau HÉBERGE une surface
                    existante (templates-table.tsx, asset-picker.tsx) plutôt que d'en reconstruire une
                    copie — voir le rapport de la Tâche 2. Texte (Tâche 3, spec §4) et Éléments (Tâche 4,
                    spec §3) insèrent désormais un calque via `dispatch` — voir
                    components/studio/panels/texte-panel.tsx et panels/elements-panel.tsx pour le
                    cheminement complet clic -> calque lié. */}
                {prefs.openPanel === "modeles" && (
                  <ModelesPanel templates={templates} categories={categories} />
                )}
                {prefs.openPanel === "elements" && (
                  <ElementsPanel
                    context={template.context}
                    canvas={{ width: template.width, height: template.height }}
                    recentShapes={prefs.recentShapes}
                    dispatch={dispatch}
                    onShapeInserted={(id) => setPrefs((p) => ({ ...p, recentShapes: withRecentShape(p.recentShapes, id) }))}
                  />
                )}
                {prefs.openPanel === "texte" && (
                  <TextePanel
                    context={template.context}
                    canvas={{ width: template.width, height: template.height }}
                    dispatch={dispatch}
                  />
                )}
                {prefs.openPanel === "images" && (
                  <ImagesPanel context={template.context} assets={assets} />
                )}
                {prefs.openPanel === "marque" && (
                  <MarquePanel assets={assets} brandLogoUrl={brandLogoUrl} categories={categoryColors} />
                )}
              </PanelHost>
            )}

            <div
              ref={canvasWrapRef}
              className="flex min-w-0 flex-1 items-center justify-center overflow-auto rounded-lg border bg-muted/20 p-4"
            >
              <Canvas scene={state.scene} selectedId={state.selectedId} dispatch={dispatch} scale={scale} />
            </div>

            {/* Tâche 6 (U1, spec §6) : `h-full` + `overflow-hidden` donnent à cette colonne une
                hauteur RÉELLEMENT bornée — c'est ce qui rend la bande de géométrie de PropertyPanel
                RÉELLEMENT épinglée à l'écran (property-panel.tsx#PropertyPanel n'utilise son propre
                `h-full` que si un ancêtre lui donne une hauteur définie), pas seulement première
                dans l'ordre du HTML. La colonne ne porte plus PreviewPane depuis la revue de cette
                tâche (spec §2 : panneau + aperçu empilés se disputant 300px de largeur ET la même
                hauteur était LE défaut de l'ancienne colonne unique) — Rendu réel (Tâche 5, spec §5)
                est désormais le SEUL foyer de l'aperçu, accessible via ModeSwitch ou `R`. Un seul
                enfant (PropertyPanel) gère lui-même son propre défilement interne
                (`property-sections`, property-panel.tsx) : rien ici n'a besoin de défiler. */}
            <div className="h-full w-[300px] shrink-0 overflow-hidden rounded-lg border">
              <PropertyPanel
                scene={state.scene} selectedId={state.selectedId} context={template.context}
                dispatch={dispatch} assets={assets}
                sectionsOpen={prefs.sectionsOpen}
                onSectionsOpenChange={(next) => setPrefs((p) => ({ ...p, sectionsOpen: next }))}
              />
            </div>
          </>
        ) : (
          <RenderMode
            templateId={template.id} context={template.context} scene={state.scene} format={template.format}
            articles={previewArticles} disabled={!storageConfigured}
            view={view} onViewChange={setView}
          />
        )}
      </div>
    </div>
  );
}
