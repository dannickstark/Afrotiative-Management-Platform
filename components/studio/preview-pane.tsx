"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { previewTemplate } from "@/lib/actions/studio-preview-actions";
import type { Scene } from "@/lib/studio/scene";
import type { TemplateContext } from "@/lib/studio/tokens";
import type { PreviewArticleOption } from "@/lib/queries/studio";

// components/studio/preview-pane.tsx — Tâche 10, spec §4 : « aperçu réel », produit par le moteur
// V1 (renderScene) via la Server Action gardée previewTemplate, JAMAIS par renderForArticle (qui
// écrirait `renders` + R2 — voir lib/studio/preview-core.ts). Le canevas de l'éditeur sert au
// placement (fidélité DOM approximative) ; ce panneau sert à la vérité.
const PREVIEW_DEBOUNCE_MS = 800;
const ARTICLE_SELECTABLE_CONTEXTS: TemplateContext[] = ["article_image", "social_post"];
const SAMPLE_OPTION = "__sample__";

export interface PreviewPaneProps {
  templateId: string;
  context: TemplateContext;
  scene: Scene;
  articles?: PreviewArticleOption[];
}

type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; dataUri: string; degraded: boolean }
  | { status: "error"; message: string };

export function PreviewPane({ templateId, context, scene, articles }: PreviewPaneProps) {
  const [articleId, setArticleId] = useState<string | null>(null);
  const [state, setState] = useState<PreviewState>({ status: "idle" });
  // Protège contre une réponse PÉRIMÉE (une requête plus récente — *Actualiser*, ou un nouveau
  // différé — est repartie entre-temps) qui écraserait un résultat plus frais avec un résultat plus
  // vieux arrivé en second à cause de la latence réseau.
  const requestIdRef = useRef(0);

  async function runPreview() {
    const id = ++requestIdRef.current;
    setState({ status: "loading" });
    try {
      const res = await previewTemplate({ templateId, articleId: articleId ?? undefined });
      if (id !== requestIdRef.current) return;
      setState(res.ok ? { status: "ready", dataUri: res.dataUri, degraded: res.degraded } : { status: "error", message: res.message });
    } catch (e) {
      if (id !== requestIdRef.current) return;
      setState({ status: "error", message: e instanceof Error ? e.message : "Aperçu impossible." });
    }
  }

  // Différé 800 ms après stabilisation de la scène OU changement d'article sélectionné (spec §4) —
  // pas à chaque frappe/glisser, exactement comme l'autosave (Tâche 9) mais avec son propre délai,
  // volontairement plus court (800 ms) : l'aperçu ne modifie rien côté serveur, un différé plus
  // court n'a donc pas le même coût qu'un autosave trop fréquent.
  useEffect(() => {
    const t = setTimeout(() => { void runPreview(); }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, articleId, templateId]);

  const showArticlePicker = ARTICLE_SELECTABLE_CONTEXTS.includes(context) && !!articles?.length;

  return (
    <div className="flex flex-col gap-2" data-testid="preview-pane">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Aperçu réel</span>
        <div className="flex items-center gap-2">
          {state.status === "ready" && state.degraded && (
            <Badge variant="secondary" data-testid="preview-degraded-badge">Rendu dégradé</Badge>
          )}
          <Button
            type="button" variant="outline" size="icon-sm" title="Actualiser l'aperçu"
            data-action="refresh-preview"
            disabled={state.status === "loading"}
            onClick={() => void runPreview()}
          >
            <RefreshCw className={state.status === "loading" ? "animate-spin" : undefined} />
          </Button>
        </div>
      </div>

      {showArticlePicker && (
        <Select value={articleId ?? SAMPLE_OPTION} onValueChange={(v) => setArticleId(v === SAMPLE_OPTION ? null : v)}>
          <SelectTrigger className="w-full" data-action="preview-article-select">
            {/* Base UI's <SelectValue> ne dérive PAS automatiquement le libellé affiché du
                <SelectItem> correspondant (contrairement à un <select> natif) — il faut le
                mapper explicitement, comme components/queue/fix-popover.tsx le fait déjà pour
                son sélecteur de catégorie. Sans ce mappeur, le combobox affichait la valeur
                technique brute ("__sample__") au lieu de « Valeurs d'exemple » — repéré en
                vérifiant l'écran réel, pas seulement en lisant le code. */}
            <SelectValue placeholder="Valeurs d'exemple">
              {(v: string | null) => (v && v !== SAMPLE_OPTION ? articles!.find((a) => a.id === v)?.title ?? v : "Valeurs d'exemple")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SAMPLE_OPTION}>Valeurs d&rsquo;exemple</SelectItem>
            {articles!.map((a) => <SelectItem key={a.id} value={a.id}>{a.title}</SelectItem>)}
          </SelectContent>
        </Select>
      )}

      <div
        className="flex items-center justify-center overflow-hidden rounded-lg border bg-muted/30"
        style={{ aspectRatio: `${scene.canvas.width} / ${scene.canvas.height}` }}
      >
        {state.status === "ready" && (
          <img src={state.dataUri} alt="Aperçu du gabarit" className="h-full w-full object-contain" />
        )}
        {state.status === "loading" && <span className="text-xs text-muted-foreground">Génération de l&rsquo;aperçu…</span>}
        {state.status === "idle" && <span className="text-xs text-muted-foreground">En attente…</span>}
        {state.status === "error" && (
          <p className="p-3 text-center text-xs text-destructive" data-testid="preview-error">{state.message}</p>
        )}
      </div>
    </div>
  );
}
