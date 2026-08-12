"use client";

import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, Undo2, Redo2, PanelRight, Minus, Plus } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { Canvas } from "./canvas";
import { CanvasChrome, safeAreaDefaultFor, RULER_SIZE } from "./canvas-chrome";
import { SaveIndicator } from "./save-indicator";
import { Rail } from "./rail";
import { PanelHost } from "./panel-host";
import { PanelResizeHandle } from "./panel-resize-handle";
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
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { editorReducer, initEditorState, singleSelectedId, undo, redo } from "@/lib/studio/editor-state";
import { createAutosaveController, type AutosaveState } from "@/lib/studio/autosave";
import { shouldShowUnpublishedBadge } from "@/lib/studio/scene-diff";
import { validateScene, type TemplateContext } from "@/lib/studio/tokens";
import { saveTemplateScene, publishTemplate } from "@/lib/actions/studio-actions";
import { StorageBanner } from "./storage-banner";
import { useEditorPrefs } from "@/hooks/use-editor-prefs";
import { useEditorLayout } from "@/hooks/use-editor-layout";
import { useEditorKeymap } from "@/hooks/use-editor-keymap";
import {
  nextOpenPanel, setOpenPanel, toggleCollapse, type RailCategory,
  RAIL_PANEL_WIDTH_MIN, RAIL_PANEL_WIDTH_MAX, INSPECTOR_WIDTH_MIN, INSPECTOR_WIDTH_MAX,
} from "@/lib/studio/editor-prefs";
import { withRecentShape } from "@/lib/studio/shape-gallery";
import { clampZoom, nextZoom, unionBounds, zoomPresetScale, ZOOM_STEPS } from "@/lib/studio/zoom";
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

// Chantier B, Tâche 3 — le slot de zoom (spec ci-dessous) : préréglages numériques additionnels du
// menu déroulant, EN PLUS des trois entrées « spéciales » (Ajuster/100 %/Cadrer la sélection, qui
// passent par lib/studio/zoom.ts#zoomPresetScale). `100` n'y figure PAS — déjà couvert par sa propre
// entrée dédiée (« 100 % », qui reste exacte quel que soit `fitScale` via zoomPresetScale("100", …),
// alors qu'un simple `100/100/fitScale` ici donnerait le MÊME résultat mais dupliquerait l'entrée).
const ZOOM_PERCENT_PRESETS = [50, 75, 125, 150, 200] as const;

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

  // ── Réactif (Chantier A Tâche 4, spec §2/§9) ──────────────────────────────
  // `layout` retombe sur `"full"` (hooks/use-editor-layout.ts) tant que le premier effet n'a pas
  // tourné — SSR/renderToStaticMarkup compris (voir tests/studio-editor-shell.test.ts, qui n'installe
  // AUCUN DOM et attend donc exactement la disposition trois colonnes historique). En dessous de
  // 1280px, l'inspecteur (1024–1279 : `inspector-drawer`) puis le panneau accosté ET l'inspecteur
  // (768–1023 : `all-drawers`) quittent la colonne fixe pour un `Sheet` (components/ui/sheet.tsx) —
  // voir `inspectorOpen`/`panelContent` plus bas. Sous 768px (`too-small`), la branche Montage/Rendu
  // entière cède la place à un état lecture seule (voir le rendu, plus bas).
  const layout = useEditorLayout();

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

  // ── Inspecteur en tiroir (Chantier A Tâche 4, spec §2/§9) ─────────────────
  // Sous 1280px, l'inspecteur (property-panel.tsx) n'a plus de colonne dédiée — il vit dans un
  // `Sheet` contrôlé par CET état, jamais par le composant `Sheet` lui-même (même recette que
  // components/studio/version-history.tsx : `open`/`onOpenChange` posés depuis le parent, un simple
  // bouton — pas `SheetTrigger` — pour l'ouvrir manuellement, ci-dessous dans le rendu). `false` par
  // défaut : rien ne force le tiroir ouvert tant que rien n'est sélectionné.
  const [inspectorOpen, setInspectorOpen] = useState(false);
  // S'ouvre tout SEUL dès qu'une sélection apparaît (brief : « opened on selection ») — jamais à la
  // refermeture (une sélection qui se vide ne doit pas arracher le tiroir sous les yeux de
  // l'utilisateur qui y lisait autre chose). Inerte en `full` (la colonne fixe suffit) : ce guard,
  // plutôt qu'un simple `layout !== "full"` dans la dépendance, évite de rouvrir le tiroir à chaque
  // sélection quand l'écran repasse en dessous de 1280px alors qu'une sélection était déjà en cours.
  const hadSelectionRef = useRef(state.selectedIds.length > 0);
  useEffect(() => {
    const hasSelection = state.selectedIds.length > 0;
    if (layout !== "full" && hasSelection && !hadSelectionRef.current) setInspectorOpen(true);
    hadSelectionRef.current = hasSelection;
  }, [state.selectedIds, layout]);

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
  // `fitScale` (renommé depuis `scale` — Chantier B, Tâche 3) reste EXACTEMENT ce qu'il était : la
  // mesure du conteneur par le ResizeObserver ci-dessous, RECALCULÉE, jamais touchée par le zoom
  // utilisateur. `computeCanvasScale` lui-même n'a pas changé d'une ligne (§0 non-régression du
  // brief T3) — voir sa propre documentation en tête de fichier.
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const [fitScale, setFitScale] = useState(1);
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
      if (next !== null) setFitScale(next);
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

  // ── Zoom RÉEL (Chantier B, Tâche 3) : `scale = fitScale × factor` ────────
  // `factor` vient de `EditorPrefs.zoom` (lib/studio/editor-prefs.ts, déjà persisté par utilisateur
  // depuis U1/U7 — jamais consommé avant cette tâche, voir le commentaire d'origine de
  // canvas-chrome.tsx). `"fit"` -> `1` (`scale = fitScale`, BIT À BIT le comportement d'avant cette
  // tâche — §0 non-régression) ; un nombre passe par `clampZoom` (lib/studio/zoom.ts) à CHAQUE lecture
  // — même discipline défensive que `clampPanelWidth` pour `railPanelWidth`/`inspectorWidth`
  // (editor-prefs.ts) : une valeur persistée hors bornes (ex. un futur resserrement de ZOOM_STEPS) ne
  // fait jamais déborder `scale`. `scale` — PAS `fitScale` — est ce que reçoivent `<Canvas>` et
  // `<CanvasChrome>` plus bas : c'est LA seule échelle réellement appliquée à l'écran, la même que la
  // pastille `zoom-chip` (canvas-chrome.tsx) affiche et que le slot `zoom-slot` ci-dessous affiche —
  // UNE SEULE source de vérité, jamais deux nombres qui pourraient diverger.
  const factor = prefs.zoom === "fit" ? 1 : clampZoom(prefs.zoom);
  const scale = fitScale * factor;

  function setZoom(next: number | "fit") {
    setPrefs((p) => ({ ...p, zoom: next }));
  }

  function currentViewport(): { width: number; height: number } | null {
    const el = canvasWrapRef.current;
    return el ? { width: el.clientWidth, height: el.clientHeight } : null;
  }

  // Cadre la sélection courante dans le viewport — partagé par ⇧2 (via le keymap ci-dessous) ET
  // l'entrée « Cadrer la sélection » du menu déroulant du slot (plus bas dans le rendu), pour que les
  // deux chemins produisent EXACTEMENT le même facteur plutôt que deux calculs qui pourraient diverger.
  function zoomToSelection() {
    const layers = state.scene.layers.filter((l) => state.selectedIds.includes(l.id));
    const bounds = unionBounds(layers.map((l) => l.frame));
    const viewport = currentViewport();
    if (!bounds || !viewport) return; // rien à cadrer, ou conteneur pas encore mesurable — no-op
    setZoom(zoomPresetScale("selection", fitScale, bounds, viewport));
  }

  // Chantier B, Tâche 1 — le KEYMAP CENTRAL (⌘Z/⌘⇧Z/⌘A/Échap/Suppr/flèches, avec la garde de focus
  // de lib/studio/keymap.ts). Monté ICI, sur `state`/`dispatch` déjà en place, plutôt que dans un
  // composant enfant : c'est ce qui lui donne accès à la sélection ET à la scène ENTIÈRES pour
  // ⌘A (sélectionner tous les calques) sans faire remonter ces deux valeurs par une prop dédiée.
  //
  // Chantier B, Tâche 3 (additif, déplacé ici — ce hook exigeait `fitScale`/`canvasWrapRef`/`setZoom`,
  // tous les trois posés juste au-dessus) : le troisième argument câble ⇧0/⇧1/⇧2 (le VRAI zoom) — voir
  // hooks/use-editor-keymap.ts#ZoomKeymapContext. `setZoom` écrit `EditorPrefs.zoom`, JAMAIS
  // `dispatch` : un changement de zoom n'est pas une action du réducteur de scène (aucun
  // `HistoryEntry`, aucun autosave — l'effet d'autosave plus haut ne compare QUE `state.scene`).
  useEditorKeymap(state, dispatch, { fitScale, getViewport: currentViewport, setZoom });

  const showUnpublishedBadge = shouldShowUnpublishedBadge(template.publishedVersion, state.scene, publishedScene);

  // ── Panneau accosté : le MÊME contenu, docked (full/inspector-drawer) ou en tiroir (all-drawers) ─
  // Chantier A Tâche 4 : factorisé pour ne pas dupliquer les six branches par catégorie deux fois —
  // seule la largeur transmise à PanelHost/ModelesPanel/TextePanel/ImagesPanel change selon l'endroit
  // où ce contenu atterrit (`undefined` laisse chacun retomber sur son défaut de 212px dans un
  // `Sheet`, dont la largeur suit déjà ses propres classes responsives — jamais la préférence de
  // largeur DESKTOP `prefs.railPanelWidth`, pensée pour une colonne fixe, pas pour un tiroir).
  function panelBody(width: number | undefined): ReactNode {
    switch (prefs.openPanel) {
      case "calques":
        return (
          <PanelHost open="calques" onOpenChange={collapsePanel} width={width}>
            <CalquesPanel scene={state.scene} selectedIds={state.selectedIds} dispatch={dispatch} />
          </PanelHost>
        );
      case "modeles":
        return (
          <ModelesPanel templates={templates} categories={categories} onOpenChange={collapsePanel} width={width} />
        );
      case "elements":
        return (
          <PanelHost open="elements" onOpenChange={collapsePanel} width={width}>
            <ElementsPanel
              context={template.context}
              canvas={{ width: template.width, height: template.height }}
              recentShapes={prefs.recentShapes}
              dispatch={dispatch}
              onShapeInserted={(id) => setPrefs((p) => ({ ...p, recentShapes: withRecentShape(p.recentShapes, id) }))}
            />
          </PanelHost>
        );
      case "texte":
        return (
          <TextePanel
            context={template.context}
            canvas={{ width: template.width, height: template.height }}
            dispatch={dispatch}
            onOpenChange={collapsePanel}
            width={width}
          />
        );
      case "images":
        return (
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
            width={width}
          />
        );
      case "marque":
        return (
          <PanelHost open="marque" onOpenChange={collapsePanel} width={width}>
            <MarquePanel assets={assets} brandLogoUrl={brandLogoUrl} categories={categoryColors} />
          </PanelHost>
        );
      default:
        return null;
    }
  }

  const panelContent = panelBody(layout === "all-drawers" ? undefined : prefs.railPanelWidth);

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
          {/* Correctif revue (Chantier A Tâche 4) : « aperçu seulement » n'était PAS honnête —
              annuler/rétablir/restaurer une version restaient de VRAIES actions (dispatch(undo())/
              dispatch(redo()), un vrai `HistoryEntry` du réducteur ; `VersionHistory.onRestore`
              remonte l'éditeur avec une AUTRE scène) rendues depuis cet en-tête, monté SANS condition
              de `layout` — et ces deux mutations sont ensuite autosauvegardées (l'effet plus haut ne
              distingue pas d'où vient un changement de `state.scene`), donc persistées en base malgré
              l'étiquette lecture seule. Repliées ici plutôt que simplement désactivées : un bouton
              `disabled` resterait un AFFORDANCE visible d'édition sur un écran qui prétend n'en avoir
              aucune — la même discipline que `TooSmallState` (Canvas en lecture seule, PAS un Canvas
              éditable désactivé au pixel près).

              Chantier B, Tâche 3 (additif) : le slot de zoom REJOINT ce même groupe conditionnel — le
              brief le nomme explicitement (« follow how undo/redo are gated ») : c'est un contrôle
              d'ÉDITION du canevas au même titre qu'annuler/rétablir, jamais un simple affichage, donc
              il n'a pas plus sa place qu'eux dans l'en-tête lecture seule `too-small`. */}
          {layout !== "too-small" && (
            <>
              {/* Le slot de zoom (spec Studio Pro chantier A Tâche 2, câblé ICI par le chantier B
                  Tâche 3) : `−`/`+` (nextZoom, lib/studio/zoom.ts) encadrant le pourcentage COURANT
                  (le déclencheur du menu, `scale × 100` arrondi — LA MÊME valeur que `zoom-chip`,
                  canvas-chrome.tsx, puisque les deux lisent `scale = fitScale × factor` ci-dessus) et
                  un menu déroulant Ajuster/100 %/Cadrer la sélection/préréglages 50–200 %.
                  `data-testid="zoom-slot"` reste sur le CONTENEUR (verrouillé par le test U0) — plus
                  un `<Button disabled>` isolé, mais le groupe entier du contrôle désormais vivant. */}
              <div className="flex items-center gap-0.5" data-testid="zoom-slot">
                <Button
                  type="button" variant="ghost" size="icon-sm" title="Zoom arrière"
                  aria-label="Zoom arrière" data-testid="zoom-out"
                  disabled={factor <= ZOOM_STEPS[0]}
                  onClick={() => setZoom(nextZoom(factor, -1))}
                >
                  <Minus />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        type="button" variant="outline" size="sm" className="tabular-nums px-2"
                        aria-label="Niveau de zoom" data-testid="zoom-current"
                      />
                    }
                  >
                    {Math.round(scale * 100)}%
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem data-testid="zoom-menu-fit" onClick={() => setZoom("fit")}>
                      Ajuster
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      data-testid="zoom-menu-100"
                      onClick={() => setZoom(zoomPresetScale("100", fitScale))}
                    >
                      100 %
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      data-testid="zoom-menu-selection"
                      disabled={state.selectedIds.length === 0}
                      onClick={zoomToSelection}
                    >
                      Cadrer la sélection
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {ZOOM_PERCENT_PRESETS.map((pct) => (
                      <DropdownMenuItem
                        key={pct}
                        data-testid={`zoom-menu-${pct}`}
                        onClick={() => setZoom(clampZoom(pct / 100 / fitScale))}
                      >
                        {pct} %
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  type="button" variant="ghost" size="icon-sm" title="Zoom avant"
                  aria-label="Zoom avant" data-testid="zoom-in"
                  disabled={factor >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
                  onClick={() => setZoom(nextZoom(factor, 1))}
                >
                  <Plus />
                </Button>
              </div>
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
              {/* Minor (même revue) : `Publier` ne mute jamais `state.scene` lui-même (il publie l'état
                  déjà enregistré) — replié malgré tout, pour la même cohérence « rien d'actionnable »
                  qu'annuler/rétablir/restaurer, plutôt que de laisser un seul bouton d'action survivre
                  seul dans un en-tête par ailleurs inerte. */}
              <Button
                type="button" data-action="publish" disabled={!storageConfigured || publishing}
                title={!storageConfigured ? "Indisponible : stockage R2 non configuré." : undefined}
                onClick={() => void handlePublish()}
              >
                {publishing ? "Publication…" : "Publier"}
              </Button>
            </>
          )}
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
          absolu ni d'un pad réservé sur CE conteneur.

          Chantier A Tâche 4 (spec §2/§9, responsive) : sous 768px (`layout === "too-small"`), cette
          zone entière cède la place à `TooSmallState` — QUEL que soit `mode` (Montage/Rendu réel),
          ni l'un ni l'autre n'a la place de tenir. Entre 768 et 1279px, la STRUCTURE Montage
          ci-dessous reste la même (Rail/panneau/canevas/inspecteur, dans cet ordre) — seuls le
          panneau accosté (`all-drawers` UNIQUEMENT) et l'inspecteur (`inspector-drawer` ET
          `all-drawers`) migrent d'une colonne fixe vers un `Sheet` (components/ui/sheet.tsx),
          voir `panelContent`/`inspectorOpen` ci-dessus. */}
      <div className="flex flex-1 gap-3 overflow-hidden">
        {layout === "too-small" ? (
          <TooSmallState scene={state.scene} width={template.width} height={template.height} />
        ) : mode === "montage" ? (
          <>
            <Rail selected={prefs.openPanel} onSelect={selectRailCategory} />

            {/* Correctif revue finale — Important 2 : Modèles, Texte et Images enrobent désormais
                EUX-MÊMES `<PanelHost>` (voir leurs fichiers respectifs) pour pouvoir peupler ses
                slots `search`/`primaryAction`, restés morts tant qu'un seul `<PanelHost>` ici les
                enrobait tous en simples `children` sans jamais leur passer ces deux props. Calques,
                Éléments et Marque n'ont ni l'un ni l'autre (spec §3, tableau : « — ») et restent donc
                de simples `children` enrobés ICI, inchangé.

                Chantier A Tâche 3 (spec §2/§3) : `width={prefs.railPanelWidth}` descend désormais
                aux SIX catégories (directement ici pour Calques/Éléments/Marque, via leur propre prop
                `width` pour Modèles/Texte/Images — voir panel-host.tsx) — une SEULE largeur pour le
                panneau accosté quelle que soit la catégorie ouverte, puisqu'une seule est jamais
                montée à la fois.

                Chantier A Tâche 4 (spec §2/§9) : sous 1024px (`all-drawers`), CE MÊME contenu
                (`panelContent`, calculé plus haut) n'est plus docké — il vit dans un `Sheet` contrôlé
                par `prefs.openPanel !== null`, jamais par un second état dupliqué. La poignée de
                redimensionnement rail-panel↔canevas n'a plus de sens dans un tiroir (largeur fixée par
                le `Sheet`) : elle disparaît avec la colonne docquée, pas seulement quand aucun panneau
                n'est ouvert. */}
            {layout === "all-drawers" ? (
              <Sheet open={prefs.openPanel !== null} onOpenChange={(next) => { if (!next) collapsePanel(null); }}>
                <SheetContent
                  side="left"
                  data-testid="panel-drawer"
                  showCloseButton={false}
                  className="w-auto gap-0 border-r p-0 sm:max-w-none data-[side=left]:w-auto"
                >
                  {panelContent}
                </SheetContent>
              </Sheet>
            ) : (
              <>
                {panelContent}
                {prefs.openPanel !== null && (
                  <PanelResizeHandle
                    currentWidth={prefs.railPanelWidth}
                    min={RAIL_PANEL_WIDTH_MIN}
                    max={RAIL_PANEL_WIDTH_MAX}
                    sign={1}
                    onResize={(w) => setPrefs((p) => ({ ...p, railPanelWidth: w }))}
                    label="Redimensionner le panneau"
                    testId="rail-panel-resize-handle"
                  />
                )}
              </>
            )}

            {/* CanvasChrome (Tâche 7, spec §7) : pastilles flottantes (format + zoom), règles et
                grille — rendues mais désactivées par défaut, état mémorisé par utilisateur — et le
                TOGGLE des zones sûres (sa persistance vit dans EditorPrefs, Tâche 1 ; les BANDES elles-
                mêmes restent de U2, voir canvas-chrome.tsx). `zoom={scale}` : la même échelle que
                `<Canvas>` reçoit juste en dessous, jamais EditorPrefs.zoom (mémorisé mais sans
                consommateur avant cette tâche, voir le commentaire de canvas-chrome.tsx).

                Chantier A Tâche 3 (spec §2/§3) puis revue de branche (fix wave) : `bg-muted/20` ->
                `bg-muted/40` -> `bg-neutral-100 dark:bg-neutral-900` — `bg-muted/40` restait un TOKEN,
                mais à ~1.4% d'écart du blanc pur il ne se distinguait pas franchement des panneaux
                blancs qui l'entourent (spec : « kill the white void »). `bg-neutral-100
                dark:bg-neutral-900` donne un fond d'atelier NETTEMENT visible — gris perceptible en
                clair, presque noir en sombre — pour que l'artboard (son propre box-shadow, canvas.tsx,
                inchangé) se lise comme une SURFACE posée sur un espace de travail plutôt que comme un
                rectangle flottant sur un fond resté visuellement proche du blanc.

                Chantier A Tâche 4 (spec §2/§9) : `min-w-[240px]` hors `full` — le brief nomme
                explicitement « canvas full-bleed with a minimum width » pour `all-drawers` ; la même
                garantie protège aussi `inspector-drawer`, où l'inspecteur devenu tiroir libère
                justement de la place que le canevas ne doit pas re-perdre au premier redimensionnement
                brusque. */}
            <div
              ref={canvasWrapRef}
              data-testid="canvas-backdrop"
              className={cn(
                "flex min-w-0 flex-1 items-center justify-center overflow-auto rounded-lg border bg-neutral-100 p-4 dark:bg-neutral-900",
                layout !== "full" && "min-w-[240px]",
              )}
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
                (`property-sections`, property-panel.tsx) : rien ici n'a besoin de défiler.

                Chantier A Tâche 4 (spec §2/§9) : cette colonne fixe — ELLE et sa poignée de
                redimensionnement — n'existent plus qu'en `full` (>=1280px). En dessous
                (`inspector-drawer`/`all-drawers`), l'inspecteur devient un `Sheet` déclenché soit
                AUTOMATIQUEMENT dès qu'une sélection apparaît (`inspectorOpen`, effet ci-dessus), soit
                MANUELLEMENT via le déclencheur `data-testid="inspector-drawer-trigger"` — jamais de
                colonne ET de tiroir en même temps, pour ne jamais réclamer une largeur que l'écran n'a
                pas (l'audit nomme précisément ce défaut à 1024px). */}
            {layout === "full" ? (
              <>
                {/* Chantier A Tâche 3 (spec §2/§3) : la poignée canevas↔inspecteur — toujours montée
                    (contrairement à celle du panneau accosté, l'inspecteur est TOUJOURS affiché en
                    mode Montage `full`, jamais conditionné par `prefs.openPanel`). `sign={-1}` :
                    l'inspecteur est posé à DROITE de cette poignée, glisser vers la droite le
                    RÉTRÉCIT. */}
                <PanelResizeHandle
                  currentWidth={prefs.inspectorWidth}
                  min={INSPECTOR_WIDTH_MIN}
                  max={INSPECTOR_WIDTH_MAX}
                  sign={-1}
                  onResize={(w) => setPrefs((p) => ({ ...p, inspectorWidth: w }))}
                  label="Redimensionner l'inspecteur"
                  testId="inspector-resize-handle"
                />

                <div
                  data-testid="inspector-column"
                  className="h-full shrink-0 overflow-hidden rounded-lg border"
                  style={{ width: prefs.inspectorWidth }}
                >
                  <PropertyPanel
                    scene={state.scene} selectedIds={state.selectedIds} context={template.context}
                    dispatch={dispatch} assets={assets}
                    sectionsOpen={prefs.sectionsOpen}
                    onSectionsOpenChange={(next) => setPrefs((p) => ({ ...p, sectionsOpen: next }))}
                  />
                </div>
              </>
            ) : (
              <Sheet open={inspectorOpen} onOpenChange={setInspectorOpen}>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  data-testid="inspector-drawer-trigger"
                  title="Propriétés"
                  aria-label="Propriétés"
                  className="h-full shrink-0 self-stretch"
                  onClick={() => setInspectorOpen(true)}
                >
                  <PanelRight />
                </Button>
                <SheetContent data-testid="inspector-drawer">
                  <SheetHeader>
                    <SheetTitle>Propriétés</SheetTitle>
                  </SheetHeader>
                  <div className="flex-1 overflow-auto px-4 pb-4">
                    <PropertyPanel
                      scene={state.scene} selectedIds={state.selectedIds} context={template.context}
                      dispatch={dispatch} assets={assets}
                      sectionsOpen={prefs.sectionsOpen}
                      onSectionsOpenChange={(next) => setPrefs((p) => ({ ...p, sectionsOpen: next }))}
                    />
                  </div>
                </SheetContent>
              </Sheet>
            )}
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

// ── État « écran trop petit » (Chantier A Tâche 4, spec §2/§9) ──────────────────────────────────
// Sous 768px, ni Montage (rail + panneau + canevas + inspecteur) ni Rendu réel (case large + bande de
// vignettes, components/studio/render-mode.tsx) n'ont la place de tenir sans écraser quelque chose —
// le brief nomme explicitement cette largeur « preview only ». Repli documenté par le brief lui-même
// (« reuse the render-mode preview if easy, else a simple message + the artboard preview ») : RÉUTILISER
// RenderMode aurait fait de cet état un TROISIÈME mode d'édition à part entière (templateId/context/
// previewArticles/vue préservée…) pour un palier qui n'édite justement plus rien — le repli « message +
// aperçu de l'artboard » est la lecture la plus honnête de « preview only » : LE même `<Canvas>` que
// Montage, mais SANS dispatch réel (`() => {}`) ni sélection possible (`pointer-events-none` sur son
// conteneur) — un aperçu, pas un éditeur miniature.
function TooSmallState({ scene, width, height }: { scene: Scene; width: number; height: number }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    function computeScale() {
      const el2 = wrapRef.current;
      if (!el2) return;
      const next = computeCanvasScale({ width: el2.clientWidth, height: el2.clientHeight }, { width, height }, false);
      setScale(next);
    }
    computeScale();
    const ro = new ResizeObserver(computeScale);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, height]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 overflow-hidden" data-testid="editor-too-small">
      <div className="max-w-[280px] rounded-lg border bg-card p-4 text-center shadow-sm">
        <p className="text-sm font-medium">Écran trop petit pour l&rsquo;édition — aperçu seulement</p>
        <p className="mt-1 text-xs text-muted-foreground">Agrandissez la fenêtre pour retrouver les outils d&rsquo;édition.</p>
      </div>
      <div
        ref={wrapRef}
        data-testid="editor-too-small-preview"
        className="pointer-events-none flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden rounded-lg border bg-muted/40 p-4"
      >
        {scale !== null && (
          <Canvas scene={scene} selectedIds={[]} dispatch={() => {}} scale={scale} />
        )}
      </div>
    </div>
  );
}
