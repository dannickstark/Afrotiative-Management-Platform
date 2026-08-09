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
import { LayerPanel } from "./layer-panel";
import { PropertyPanel } from "./property-panel";
import { VersionHistory } from "./version-history";
import { PreviewPane } from "./preview-pane";
import { editorReducer, initEditorState, undo, redo } from "@/lib/studio/editor-state";
import { createAutosaveController, type AutosaveState } from "@/lib/studio/autosave";
import { shouldShowUnpublishedBadge } from "@/lib/studio/scene-diff";
import { validateScene, type TemplateContext } from "@/lib/studio/tokens";
import { saveTemplateScene, publishTemplate } from "@/lib/actions/studio-actions";
import type { Scene } from "@/lib/studio/scene";
import type { FormatKey } from "@/lib/studio/formats";
import type { TemplateVersionRow, PreviewArticleOption } from "@/lib/queries/studio";

// components/studio/editor-shell.tsx — Tâche 9 : compose canevas + panneau de calques + panneau de
// propriétés + aperçu réel + historique, et porte l'autosauvegarde et la publication (spec §3).
const AUTOSAVE_DELAY_MS = 1500;

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
      onRestore={handleRestore}
    />
  );
}

interface EditorShellInnerProps extends EditorShellProps {
  onRestore: (scene: Scene) => void;
}

function EditorShellInner({ template, initialScene, publishedScene, versions, previewArticles, onRestore }: EditorShellInnerProps) {
  const router = useRouter();
  const [state, dispatch] = useReducer(editorReducer, initialScene, initEditorState);

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
          <Button type="button" data-action="publish" disabled={publishing} onClick={() => void handlePublish()}>
            {publishing ? "Publication…" : "Publier"}
          </Button>
        </div>
      </header>

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

      <div className="grid flex-1 grid-cols-[220px_1fr_300px] gap-3 overflow-hidden">
        <div className="overflow-auto rounded-lg border p-2">
          <LayerPanel scene={state.scene} selectedId={state.selectedId} dispatch={dispatch} />
        </div>

        <div ref={canvasWrapRef} className="flex items-center justify-center overflow-auto rounded-lg border bg-muted/20 p-4">
          <Canvas scene={state.scene} selectedId={state.selectedId} dispatch={dispatch} scale={scale} />
        </div>

        <div className="flex flex-col gap-3 overflow-auto">
          <div className="rounded-lg border">
            <PropertyPanel scene={state.scene} selectedId={state.selectedId} context={template.context} dispatch={dispatch} />
          </div>
          <div className="rounded-lg border p-2">
            <PreviewPane templateId={template.id} context={template.context} scene={state.scene} articles={previewArticles} />
          </div>
        </div>
      </div>
    </div>
  );
}
