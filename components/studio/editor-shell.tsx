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
import { CanvasChrome, safeAreaDefaultFor, RULER_SIZE } from "./canvas-chrome";
import { SaveIndicator } from "./save-indicator";
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
import { editorReducer, initEditorState, singleSelectedId, undo, redo } from "@/lib/studio/editor-state";
import { createAutosaveController, type AutosaveState } from "@/lib/studio/autosave";
import { shouldShowUnpublishedBadge } from "@/lib/studio/scene-diff";
import { validateScene, type TemplateContext } from "@/lib/studio/tokens";
import { saveTemplateScene, publishTemplate } from "@/lib/actions/studio-actions";
import { StorageBanner } from "./storage-banner";
import { useEditorPrefs } from "@/hooks/use-editor-prefs";
import { nextOpenPanel, setOpenPanel, toggleCollapse, type RailCategory } from "@/lib/studio/editor-prefs";
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

// Correctif revue finale — Important 6 (spec §7) : PURE, exportée pour un test direct sans DOM ni
// ResizeObserver (tests/studio-editor-shell.test.ts). Avant ce correctif, `pad` était figé à 32
// (annulant tout juste le `p-4` du conteneur qui enrobe <CanvasChrome>) — les règles ajoutent
// `RULER_SIZE` (canvas-chrome.tsx) de CHAQUE côté sans jamais faire grandir ce pad, donc l'artboard
// grandissait de `2 × RULER_SIZE` par axe sans jamais se rééchelonner : activer les règles ajoutait
// des barres de défilement et les rendait pourtant invisibles (le bord de DÉPART, haut/gauche — là où
// vivent les règles — reste hors de portée du défilement dans un conteneur `justify-center` +
// `overflow-auto`).
// `null` (jamais `1`) quand le conteneur est trop petit pour être mesuré, UNE FOIS le pad des
// règles retranché : reproduit fidèlement le `return;` d'origine (qui laissait `scale` INCHANGÉ,
// sans jamais le réinitialiser) plutôt que d'inventer un comportement différent pour ce cas limite.
export function computeCanvasScale(
  available: { width: number; height: number },
  template: { width: number; height: number },
  rulers: boolean,
): number | null {
  const pad = 32 + (rulers ? 2 * RULER_SIZE : 0);
  const availW = available.width - pad;
  const availH = available.height - pad;
  if (availW <= 0 || availH <= 0) return null;
  const k = Math.min(availW / template.width, availH / template.height, 1);
  return k > 0 ? k : 1;
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
  // Tâche 7 (U1, spec §7) : le défaut des zones sûres suit le FORMAT de CE gabarit uniquement au tout
  // premier lancement dans ce navigateur (voir hooks/use-editor-prefs.ts et
  // canvas-chrome.tsx#safeAreaDefaultFor) — une préférence déjà enregistrée reste prioritaire.
  // Correctif revue finale (amendement de spec §3) : `hasLayers` ouvre Modèles pour un gabarit tout
  // juste créé (scène sans le moindre calque) — voir lib/studio/editor-prefs.ts#openModelesIfEmpty
  // pour la règle exacte (jamais si un panneau est déjà ouvert).
  const [prefs, setPrefs] = useEditorPrefs({
    defaultSafeAreas: safeAreaDefaultFor(template.format),
    hasLayers: initialScene.layers.length > 0,
  });

  // Correctif revue finale (Minor, second passage) — Close 1 : `selectRailCategory` et
  // `collapsePanel` passaient auparavant par un simple `{ ...p, openPanel: next }` littéral, jamais
  // par `setOpenPanel` (lib/studio/editor-prefs.ts) — donc `lastOpenPanel` restait périmé après une
  // fermeture au RAIL ou au CHEVRON, et ⌘/ pouvait restaurer un panneau qui n'était plus celui
  // réellement ouvert juste avant. Les deux passent maintenant par `setOpenPanel`, LE seul point
  // d'écriture de `openPanel`, pour que `lastOpenPanel` reste à jour quel que soit le geste qui
  // ferme.
  function selectRailCategory(category: RailCategory) {
    setPrefs((p) => setOpenPanel(p, nextOpenPanel(p.openPanel, category)));
  }

  function collapsePanel(next: RailCategory | null) {
    setPrefs((p) => setOpenPanel(p, next));
  }

  // Bascule le panneau accosté au clavier (⌘/) — voir COLLAPSE_PANEL_KEY ci-dessus pour le choix
  // documenté. `toggleCollapse` (lib/studio/editor-prefs.ts) est un VRAI aller-retour — replie en
  // mémorisant quel panneau était ouvert (via `setOpenPanel`, désormais partagé avec les deux
  // fonctions ci-dessus), et réaffiche le DERNIER panneau réellement fermé — par n'importe quel
  // geste — la fois suivante quand rien n'est ouvert.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== COLLAPSE_PANEL_KEY || (!e.metaKey && !e.ctrlKey)) return;
      e.preventDefault();
      setPrefs((p) => toggleCollapse(p));
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setPrefs]);

  // ── Modes Montage ⇄ Rendu réel (Tâche 5, U1 spec §5) ──────────────────────
  // `mode` ne pilote qu'un rendu CONDITIONNEL plus bas (jamais une `key` React) : basculer ne
  // démonte ni ne réinitialise `state`/`dispatch` (le réducteur de l'éditeur, ci-dessus) — c'est ce
  // qui garantit gratuitement que la sélection de calques courante (state.selectedIds) survit à
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

  // ── Mise à l'échelle du canevas (spec §2, §7) ────────────────────────────
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = canvasWrapRef.current;
    if (!el) return;
    function computeScale() {
      const el2 = canvasWrapRef.current;
      if (!el2) return;
      const next = computeCanvasScale(
        { width: el2.clientWidth, height: el2.clientHeight },
        { width: template.width, height: template.height },
        prefs.rulers,
      );
      if (next !== null) setScale(next);
    }
    computeScale();
    const ro = new ResizeObserver(computeScale);
    ro.observe(el);
    return () => ro.disconnect();
    // Correctif revue finale — Important 6 : `prefs.rulers` doit être une dépendance de cet effet.
    // Avant ce correctif, `pad` était figé à 32 (annulant tout juste le `p-4` de ce conteneur) : les
    // règles ajoutent `RULER_SIZE` de chaque côté (canvas-chrome.tsx) SANS jamais redéclencher un
    // recalcul d'échelle — l'artboard grandissait de `2 × RULER_SIZE` par axe et débordait par le
    // bord de DÉPART (haut/gauche, ce conteneur étant `justify-center` + `overflow-auto` : le
    // débordement côté FIN reste atteignable au défilement, jamais celui côté départ) — exactement
    // là où vivent les règles, les rendant de facto invisibles en plus de faire apparaître des
    // barres de défilement inattendues.
  }, [template.width, template.height, prefs.rulers]);

  const showUnpublishedBadge = shouldShowUnpublishedBadge(template.publishedVersion, state.scene, publishedScene);

  return (
    <div className="flex h-full flex-col gap-3" data-testid="editor-shell">
      {/* Chantier A Tâche 2 : cet en-tête EST désormais la seule barre supérieure de l'éditeur —
          la coque admin (SidebarProvider/AppSidebar/Breadcrumbs/SidebarTrigger, app/(app)/layout.tsx)
          a quitté cet arbre dès la Tâche 1 (app/(studio-editor)/layout.tsx, plein écran, requireUser()
          seul), rendant CET en-tête le haut visuel de tout l'écran plutôt qu'un second bandeau sous
          un en-tête admin. Trois colonnes (grid, pas flex-wrap justify-between comme avant cette
          tâche) : GAUCHE retour + nom + SaveIndicator, CENTRE ModeSwitch, DROITE slot zoom
          (chantier B) + undo/redo + Historique + Publier — plutôt que deux colonnes aux extrémités,
          pour que ModeSwitch reste visuellement CENTRÉ même quand la colonne gauche (nom du gabarit)
          ou la colonne droite change de largeur, tel que la brief de tâche le nomme (« CENTER : le
          ModeSwitch »). ModeSwitch + SaveIndicator vivaient avant cette tâche en position absolue
          au-dessus du CANEVAS (Tâches 5/7, spec §5/§8, indépendant de la coque admin) — un FRÈRE du
          contenu de mode, jamais de cet en-tête. Les remonter ICI, dans l'unique en-tête de la barre
          supérieure, tient la même promesse (« les DEUX états », « à côté du sélecteur de mode »)
          sans plus jamais dépendre d'un positionnement absolu ni d'un pad (`pt-11`) réservé pour lui
          — voir le conteneur juste en dessous, qui ne porte plus ni l'un ni l'autre. */}
      <header className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-b pb-3">
        <div className="flex min-w-0 items-center gap-2">
          {/* Correctif chantier A T2 : AVANT cette tâche, ce lien portait déjà `href="/studio"` (donc
              naviguait réellement) mais SANS texte visible — une simple flèche icône, `aria-label`
              seul. La brief de tâche nomme explicitement la forme cible « ← Gabarits » : le texte
              devient visible (`data-testid="editor-back-to-templates"`, verrouillé par le test U0 —
              voir tests/studio-editor-shell.test.ts), l'`aria-label` de secours n'étant donc plus
              nécessaire (le nom accessible vient désormais du texte du lien lui-même). */}
          <Link
            href="/studio"
            data-testid="editor-back-to-templates"
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "shrink-0 gap-1 px-2")}
          >
            <ArrowLeft />
            Gabarits
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
          <SaveIndicator
            status={autosaveState.status}
            message={autosaveState.message}
            onRetry={() => void autosave.retry()}
            className="shrink-0"
          />
        </div>

        <div className="flex items-center justify-center">
          <ModeSwitch mode={mode} onChange={changeMode} />
        </div>

        <div className="flex items-center justify-end gap-2">
          {/* Slot chantier B (spec Studio Pro chantier A, Tâche 2) : affordance de zoom
              DÉLIBÉRÉMENT inerte — `disabled`, aucun `onClick` — juste un emplacement réservé dans la
              barre. Le vrai contrôle (lecture/écriture du zoom réel du canevas, `scale` ci-dessus)
              est câblé par le chantier B, pas ici ; ce bouton n'affiche que "100%" en dur pour occuper
              la place et fixer la forme attendue (`data-testid="zoom-slot"`, verrouillé par le test
              U0 ci-dessous). */}
          <Button
            type="button" variant="outline" size="sm" disabled
            data-testid="zoom-slot" aria-label="Zoom (à venir)"
            className="tabular-nums"
          >
            100%
          </Button>
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
          ModeSwitch et SaveIndicator ne sont PLUS ici depuis le chantier A Tâche 2 — ils vivaient en
          position absolue sur ce conteneur (`relative` + `pt-11`, retirés avec eux) pour rester
          visibles au-dessus du canevas dans « les DEUX états » (spec §5/§8). Ils vivent désormais
          dans l'en-tête ci-dessus (editor-shell.tsx:353), frères dans sa colonne gauche/centrale, et
          y restent visibles quel que soit `mode` puisque cet en-tête n'est jamais conditionné par
          lui — la même garantie « les deux états », sans plus jamais dépendre d'un positionnement
          absolu ni d'un pad réservé sur CE conteneur. */}
      <div className="flex flex-1 gap-3 overflow-hidden">
        {mode === "montage" ? (
          <>
            <Rail selected={prefs.openPanel} onSelect={selectRailCategory} />

            {/* Correctif revue finale — Important 2 : Modèles, Texte et Images enrobent désormais
                EUX-MÊMES `<PanelHost>` (voir leurs fichiers respectifs) pour pouvoir peupler ses
                slots `search`/`primaryAction`, restés morts tant qu'un seul `<PanelHost>` ici les
                enrobait tous en simples `children` sans jamais leur passer ces deux props. Calques,
                Éléments et Marque n'ont ni l'un ni l'autre (spec §3, tableau : « — ») et restent donc
                de simples `children` enrobés ICI, inchangé. */}
            {prefs.openPanel === "calques" && (
              <PanelHost open="calques" onOpenChange={collapsePanel}>
                <CalquesPanel scene={state.scene} selectedIds={state.selectedIds} dispatch={dispatch} />
              </PanelHost>
            )}
            {prefs.openPanel === "modeles" && (
              <ModelesPanel templates={templates} categories={categories} onOpenChange={collapsePanel} />
            )}
            {prefs.openPanel === "elements" && (
              <PanelHost open="elements" onOpenChange={collapsePanel}>
                <ElementsPanel
                  context={template.context}
                  canvas={{ width: template.width, height: template.height }}
                  recentShapes={prefs.recentShapes}
                  dispatch={dispatch}
                  onShapeInserted={(id) => setPrefs((p) => ({ ...p, recentShapes: withRecentShape(p.recentShapes, id) }))}
                />
              </PanelHost>
            )}
            {prefs.openPanel === "texte" && (
              <TextePanel
                context={template.context}
                canvas={{ width: template.width, height: template.height }}
                dispatch={dispatch}
                onOpenChange={collapsePanel}
              />
            )}
            {prefs.openPanel === "images" && (
              <ImagesPanel
                context={template.context}
                assets={assets}
                scene={state.scene}
                // Tâche 3 (U2) : ce panneau assigne un asset à UN calque image — une sélection
                // multiple lui arrive donc comme `null` et désactive son sélecteur, voir la note en
                // tête de images-panel.tsx.
                selectedId={singleSelectedId(state.selectedIds)}
                dispatch={dispatch}
                onOpenChange={collapsePanel}
              />
            )}
            {prefs.openPanel === "marque" && (
              <PanelHost open="marque" onOpenChange={collapsePanel}>
                <MarquePanel assets={assets} brandLogoUrl={brandLogoUrl} categories={categoryColors} />
              </PanelHost>
            )}

            {/* CanvasChrome (Tâche 7, spec §7) : pastilles flottantes (format + zoom), règles et
                grille — rendues mais désactivées par défaut, état mémorisé par utilisateur — et le
                TOGGLE des zones sûres (sa persistance vit dans EditorPrefs, Tâche 1 ; les BANDES elles-
                mêmes restent de U2, voir canvas-chrome.tsx). `zoom={scale}` : la même échelle que
                `<Canvas>` reçoit juste en dessous, jamais EditorPrefs.zoom (mémorisé mais sans
                consommateur avant cette tâche, voir le commentaire de canvas-chrome.tsx). */}
            <div
              ref={canvasWrapRef}
              className="flex min-w-0 flex-1 items-center justify-center overflow-auto rounded-lg border bg-muted/20 p-4"
            >
              <CanvasChrome
                format={template.format}
                zoom={scale}
                prefs={{
                  rulers: prefs.rulers, grid: prefs.grid, safeAreas: prefs.safeAreas,
                  showBindings: prefs.showBindings,
                }}
                onToggleRulers={() => setPrefs((p) => ({ ...p, rulers: !p.rulers }))}
                onToggleGrid={() => setPrefs((p) => ({ ...p, grid: !p.grid }))}
                onToggleSafeAreas={() => setPrefs((p) => ({ ...p, safeAreas: !p.safeAreas }))}
                onToggleBindings={() => setPrefs((p) => ({ ...p, showBindings: !p.showBindings }))}
              >
                <Canvas
                  scene={state.scene} selectedIds={state.selectedIds} dispatch={dispatch} scale={scale}
                  showBindings={prefs.showBindings}
                />
              </CanvasChrome>
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
                scene={state.scene} selectedIds={state.selectedIds} context={template.context}
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
