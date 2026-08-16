"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePreview } from "@/hooks/use-preview";
import type { Scene } from "@/lib/studio/scene";
import type { TemplateContext } from "@/lib/studio/tokens";
import type { PreviewArticleOption } from "@/lib/queries/studio";

// components/studio/preview-pane.tsx — Tâche 10, spec §4 : « aperçu réel », produit par le moteur
// V1 (renderScene) via la Server Action gardée previewTemplate, JAMAIS par renderForArticle (qui
// écrirait `renders` + R2 — voir lib/studio/preview-core.ts). Le canevas de l'éditeur sert au
// placement (fidélité DOM approximative) ; ce panneau sert à la vérité.
//
// Correctif Critique 1 (revue Lot 2) : ce panneau envoie la scène COURANTE (prop `scene`, tenue par
// le réducteur de l'éditeur) à previewTemplate à CHAQUE appel — jamais seulement templateId/articleId
// en laissant le serveur relire le brouillon en base. Avant ce correctif, previewTemplateCore lisait
// TOUJOURS la base : avec un différé de 800 ms ici contre 1500 ms pour l'autosauvegarde
// (components/studio/editor-shell.tsx:AUTOSAVE_DELAY_MS), la requête d'aperçu partait ~700 ms AVANT
// que l'édition n'atteigne la base — et les deps de l'effet ci-dessous ([scene, articleId,
// templateId]) ne se redéclenchent sur aucun signal de sauvegarde réussie, donc rien ne rattrapait
// l'écart : l'aperçu affichait la scène PRÉ-édition, en retard d'un cran, arbitrairement cumulatif
// sur des éditions consécutives, jusqu'au prochain changement (qui prévisualise alors l'édition
// PRÉCÉDENTE) ou un clic manuel sur *Actualiser*. En envoyant `scene` directement, l'aperçu n'a plus
// aucune dépendance de timing envers l'autosauvegarde : previewTemplateCore revalide (parseScene) et
// rend CETTE scène-là, sans jamais l'écrire (lib/studio/preview-core.ts) — donc pas de course.
// Exporté (Tâche 5, U1 spec §5) : components/studio/render-mode.tsx réutilise EXACTEMENT cette même
// liste pour sa légende de provenance plutôt que de la recopier — une constante dupliquée pourrait
// diverger silencieusement du sélecteur réel de ce panneau (ex. si un contexte manuel gagnait un
// jour un article associé sans que la copie ne soit mise à jour).
export const ARTICLE_SELECTABLE_CONTEXTS: TemplateContext[] = ["article_image", "social_post"];
const SAMPLE_OPTION = "__sample__";

export interface PreviewPaneProps {
  templateId: string;
  context: TemplateContext;
  scene: Scene;
  articles?: PreviewArticleOption[];
  // Tâche 15 (spec §8) : quand le stockage R2 n'est pas configuré, le studio entier bascule en
  // lecture seule (voir components/studio/storage-banner.tsx) — l'aperçu en fait partie même s'il
  // n'écrit lui-même NI ligne `renders` NI objet R2 (garantie STRUCTURELLE, vérifiée par
  // tests/studio-preview.test.ts) : c'est une simplification d'UX délibérée (un studio entièrement
  // inerte plutôt que « certaines actions marchent, d'autres pas » — spec §8, « Le studio s'affiche
  // en lecture seule »), pas une nécessité technique de previewTemplateCore lui-même.
  disabled?: boolean;
}

export function PreviewPane({ templateId, context, scene, articles, disabled }: PreviewPaneProps) {
  const [articleId, setArticleId] = useState<string | null>(null);
  const { state, refresh } = usePreview({ templateId, scene, articleId, enabled: !disabled });

  const showArticlePicker = ARTICLE_SELECTABLE_CONTEXTS.includes(context) && !!articles?.length;

  return (
    <div className="flex flex-col gap-2" data-testid="preview-pane">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Aperçu réel</span>
        <div className="flex items-center gap-2">
          {state.status === "ready" && state.degraded && (
            <Badge variant="secondary" data-testid="preview-degraded-badge">Rendu dégradé</Badge>
          )}
          {/* Qualité, D — la SEULE cause de flou que le moteur ne peut pas corriger : la photo
              source a moins de pixels que le cadre où elle est peinte, elle est donc étirée (voir
              PreparedImage.lowRes, lib/studio/images.ts). Constatée sur les octets réellement
              téléchargés pendant CE rendu, pas estimée. Le dire ICI est le seul moment utile : après
              publication, l'image est déjà en ligne et rien dans le gabarit ne peut la rattraper. */}
          {state.status === "ready" && state.lowRes && (
            <Badge
              variant="secondary" data-testid="preview-lowres-badge"
              title="La photo source est plus petite que le cadre où elle est peinte : elle est agrandie, donc floue. Réduire le cadre ou fournir une image plus grande — aucun réglage du gabarit ne peut compenser."
            >
              Image agrandie
            </Badge>
          )}
          <Button
            type="button" variant="outline" size="icon-sm"
            title={disabled ? "Indisponible : stockage R2 non configuré." : "Actualiser l'aperçu"}
            data-action="refresh-preview"
            disabled={disabled || state.status === "loading"}
            onClick={refresh}
          >
            <RefreshCw className={state.status === "loading" ? "animate-spin" : undefined} />
          </Button>
        </div>
      </div>

      {showArticlePicker && (
        <Select
          value={articleId ?? SAMPLE_OPTION} disabled={disabled}
          onValueChange={(v) => setArticleId(v === SAMPLE_OPTION ? null : v)}
        >
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
        {disabled ? (
          <p className="p-3 text-center text-xs text-muted-foreground" data-testid="preview-disabled">
            Aperçu indisponible — stockage R2 non configuré.
          </p>
        ) : (
          <>
            {state.status === "ready" && (
              <img src={state.dataUri} alt="Aperçu du gabarit" className="h-full w-full object-contain" />
            )}
            {state.status === "loading" && <span className="text-xs text-muted-foreground">Génération de l&rsquo;aperçu…</span>}
            {state.status === "idle" && <span className="text-xs text-muted-foreground">En attente…</span>}
            {state.status === "error" && (
              <p className="p-3 text-center text-xs text-destructive" data-testid="preview-error">{state.message}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
