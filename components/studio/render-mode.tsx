"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ProofSheet, type TileOutcome } from "./render/proof-sheet";
import { FormatFocus } from "./render/format-focus";
import { ARTICLE_SELECTABLE_CONTEXTS } from "@/lib/studio/preview-contexts";
import { downloadAllFormats } from "./render/export";
import { previewCache } from "@/lib/studio/preview-cache";
import { focusedFormat, type PreservedView } from "@/lib/studio/studio-mode";
import { FORMAT_KEYS, type FormatKey } from "@/lib/studio/formats";
import type { Scene } from "@/lib/studio/scene";
import type { TemplateContext } from "@/lib/studio/tokens";
import type { PreviewArticleOption } from "@/lib/queries/studio";

// components/studio/render-mode.tsx — « Rendu réel », le second mode de l'éditeur : aucun rail,
// aucun panneau accosté, aucune colonne de propriétés (editor-shell.tsx ne rend rien de tout cela
// sous `mode === "rendu"`).
//
// Ce fichier n'est plus qu'un ROUTEUR et une barre d'outils. Toute la matière vit dans ses deux
// enfants : render/proof-sheet.tsx (la planche des huit formats) et render/format-focus.tsx
// (l'inspection d'un format). `view.selectedId` décide lequel des deux est monté — voir
// `focusedFormat` (lib/studio/studio-mode.ts), le seul lecteur autorisé de ce champ ici.
//
// CE QUI A DISPARU avec la refonte, et pourquoi :
//   - la « grande case » qui était un <PreviewPane> complet : elle apportait un SECOND en-tête, un
//     SECOND badge « dégradé », son propre bouton Actualiser et son propre sélecteur d'article,
//     imbriqués dans ceux de ce fichier ;
//   - l'état `stale` / le badge « Périmé » / le bouton « ↻ rendre » : une scène modifiée produit
//     désormais une clé de cache différente (lib/studio/preview-cache.ts), donc une tuile est soit à
//     jour, soit en cours de chargement. Un seul modèle de fraîcheur, plus deux ;
//   - les deux paragraphes de provenance : le sélecteur d'article pilote maintenant LES HUIT tuiles,
//     il n'y a donc plus d'écart à démentir en toutes lettres.
//
// PreviewPane lui-même (components/studio/preview-pane.tsx) a été SUPPRIMÉ (chantier D, Tâche 6) :
// ce fichier était son dernier consommateur — la colonne de Montage ne le rendait déjà plus
// (tests/studio-editor-shell.test.ts, « l'aperçu vit désormais UNIQUEMENT dans Rendu réel »). Sa
// seule partie encore utile, `ARTICLE_SELECTABLE_CONTEXTS`, vit désormais dans le module PUR
// lib/studio/preview-contexts.ts (aucun React, même discipline que lib/studio/studio-mode.ts).
const SAMPLE_OPTION = "__sample__";

export interface RenderModeProps {
  templateId: string;
  context: TemplateContext;
  scene: Scene;
  /** Format NATIF du gabarit (render_templates.format) — celui qui porte le marqueur « natif ». */
  format: FormatKey;
  articles?: PreviewArticleOption[];
  disabled?: boolean;
  /** État de vue partagé avec le mode Montage (lib/studio/studio-mode.ts#PreservedView). ICI,
   *  `selectedId` porte le format FOCALISÉ (`null` = la planche) et `zoom`/`scrollX`/`scrollY` la
   *  vue d'inspection. Contrôlé par l'appelant (editor-shell.tsx) — JAMAIS de useState interne pour
   *  ces quatre champs : c'est ce qui les fait survivre à un aller-retour de mode, puisque rien
   *  d'eux ne vit dans cet arbre. */
  view: PreservedView;
  onViewChange: (view: PreservedView) => void;
  // Amorce de test UNIQUEMENT — la vraie composition ne la fournit JAMAIS. `react-dom/server`
  // n'exécute aucun effet, donc aucun résultat de tuile n'existe à un rendu statique.
  initialOutcomes?: Partial<Record<FormatKey, TileOutcome>>;
}

export function RenderMode({
  templateId, context, scene, format, articles, disabled, view, onViewChange, initialOutcomes,
}: RenderModeProps) {
  const focused = focusedFormat(view);
  const [articleId, setArticleId] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Partial<Record<FormatKey, TileOutcome>>>(
    initialOutcomes ?? {},
  );
  const [exporting, setExporting] = useState<{ done: number; total: number } | null>(null);

  const handleTileOutcome = useCallback((key: FormatKey, outcome: TileOutcome) => {
    setOutcomes((prev) => {
      const before = prev[key];
      if (before !== undefined && before.ready === outcome.ready
        && before.overflow === outcome.overflow && before.lowRes === outcome.lowRes) return prev;
      return { ...prev, [key]: outcome };
    });
  }, []);

  // Ne compte QUE les formats dont le rendu a abouti. Une tuile jamais entrée dans le viewport n'a
  // rien à déclarer : la compter comme saine serait un mensonge, la compter comme suspecte aussi.
  // Tant que les huit ne sont pas connus, la pastille se qualifie (« … sur 5 rendus ») — c'est la
  // conséquence directe du gating de visibilité, et la dire est plus honnête que la masquer.
  const rendered = FORMAT_KEYS.filter((k) => outcomes[k]?.ready === true);
  const flagged = rendered.filter((k) => outcomes[k]!.overflow || outcomes[k]!.lowRes);
  const allRendered = rendered.length === FORMAT_KEYS.length;

  const showArticlePicker = ARTICLE_SELECTABLE_CONTEXTS.includes(context) && !!articles?.length;

  function focusFormat(key: FormatKey) {
    onViewChange({ ...view, selectedId: key, zoom: "fit", scrollX: 0, scrollY: 0 });
  }

  function exitFocus() {
    onViewChange({ ...view, selectedId: null });
  }

  // Purge les entrées CE GABARIT (jamais tout le cache — correctif de revue, chantier D Tâche 6) et
  // laisse les tuiles visibles se relancer. `previewCache` a une portée MODULE, partagée par tous les
  // gabarits ouverts pendant la session (lib/studio/preview-cache.ts) : un `clear()` global aurait
  // fait payer à un utilisateur qui bascule entre plusieurs gabarits le coût d'un VRAI rendu
  // satori/resvg/sharp pour CHAQUE tuile de CHAQUE AUTRE gabarit, alors que rien n'y avait changé.
  // Le seul cas qu'un hachage de scène ne peut pas voir, pour CE gabarit : une image source modifiée
  // à distance, dont l'URL n'a pas changé.
  function refreshAll() {
    previewCache.deleteByTemplate(templateId);
    setOutcomes({});
  }

  async function exportAll() {
    setExporting({ done: 0, total: FORMAT_KEYS.length });
    try {
      await downloadAllFormats({
        templateId, scene, nativeFormat: format, articleId,
        onProgress: (done, total) => setExporting({ done, total }),
      });
    } catch (e) {
      // downloadAllFormats ne rejette que sur une panne du RENDU lui-même (previewTemplate qui
      // lève, jamais un simple `ok: false` — celui-là est déjà avalé en un format SAUTÉ). Le bouton
      // est déclenché en fire-and-forget (`void exportAll()`), donc sans ce catch la panne devenait
      // un rejet de promesse non géré, invisible pour l'utilisateur. Même mécanisme de report que
      // les échecs de publication (editor-shell.tsx).
      toast.error(`Téléchargement interrompu : ${e instanceof Error ? e.message : "erreur inconnue"}.`);
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3" data-testid="render-mode">
      <div className="flex flex-wrap items-center gap-2" data-testid="render-toolbar">
        {showArticlePicker ? (
          <Select
            value={articleId ?? SAMPLE_OPTION} disabled={disabled}
            onValueChange={(v) => setArticleId(v === SAMPLE_OPTION ? null : v)}
          >
            <SelectTrigger className="w-full sm:w-64" data-testid="render-article-select">
              {/* Base UI ne dérive PAS le libellé affiché du <SelectItem> correspondant — il faut le
                  mapper explicitement, même correctif que preview-pane.tsx (aujourd'hui supprimé —
                  ce mappeur vivait déjà là avant la refonte). */}
              <SelectValue placeholder="Valeurs d'exemple">
                {(v: string | null) => (v && v !== SAMPLE_OPTION
                  ? articles!.find((a) => a.id === v)?.title ?? v
                  : "Valeurs d'exemple")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SAMPLE_OPTION}>Valeurs d&rsquo;exemple</SelectItem>
              {articles!.map((a) => <SelectItem key={a.id} value={a.id}>{a.title}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : (
          <span
            data-testid="render-sample-chip"
            className="rounded-4xl bg-muted px-2 py-0.5 text-xs text-muted-foreground"
          >
            Valeurs d&rsquo;exemple
          </span>
        )}

        {flagged.length > 0 && (
          <button
            type="button"
            data-testid="render-warning-summary"
            onClick={() => focusFormat(flagged[0]!)}
            title="Ouvrir le premier format signalé"
            className="inline-flex h-8 items-center gap-1.5 rounded-4xl bg-amber-600/15 px-2.5 text-xs text-amber-700 transition-colors hover:bg-amber-600/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:text-amber-500"
          >
            <TriangleAlert className="size-3.5" />
            {allRendered
              ? `${flagged.length} format${flagged.length > 1 ? "s" : ""} à vérifier`
              : `${flagged.length} format${flagged.length > 1 ? "s" : ""} à vérifier sur ${rendered.length} rendu${rendered.length > 1 ? "s" : ""}`}
          </button>
        )}

        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button" variant="outline" size="sm"
            data-testid="render-refresh-all" data-action="refresh-all"
            disabled={disabled} onClick={refreshAll}
            title="Refaire tous les rendus — utile si une image source a changé sans que son URL change."
          >
            <RefreshCw />Actualiser
          </Button>
          <Button
            type="button" variant="outline" size="sm"
            data-testid="render-export-all"
            disabled={disabled || exporting !== null} onClick={() => void exportAll()}
          >
            {exporting === null ? "Tout télécharger" : `${exporting.done}/${exporting.total}`}
          </Button>
        </div>
      </div>

      {focused === null ? (
        <ProofSheet
          templateId={templateId} scene={scene} nativeFormat={format} articleId={articleId}
          disabled={disabled} onFocus={focusFormat} onTileOutcome={handleTileOutcome}
          initialOutcomes={initialOutcomes}
        />
      ) : (
        <FormatFocus
          templateId={templateId} scene={scene} nativeFormat={format} format={focused}
          articleId={articleId} disabled={disabled}
          view={view} onViewChange={onViewChange}
          onExit={exitFocus} onFormatChange={focusFormat}
          outcomes={outcomes}
        />
      )}
    </div>
  );
}
