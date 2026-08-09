"use client";
import { useState } from "react";
import { ExternalLink, ImageOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { previewArticleImage } from "@/lib/actions/article-preview-actions";
import type { RenderForArticleResult } from "@/lib/studio";

export type ImageFields = {
  featuredImageUrl: string | null;
  imageCredit: string | null;
  imageSourceUrl: string | null;
};

export type PreviewStatus = "idle" | "loading" | "done";
export type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; result: RenderForArticleResult };

// Orchestre le chargement à la demande de l'onglet « Aperçu final » (spec V3 §1 : « calculé à la
// demande, au premier affichage de l'onglet — jamais au chargement de la page »). Extraite en
// fonction PURE et exportée : `bun test` n'a pas de DOM, donc pas de simulation de clic possible
// (même convention que tests/studio-layer-panel.test.ts) — la garantie « exactement un rendu,
// jamais deux » ne peut être prouvée par un compteur d'appels QUE si la décision vit ici, hors
// composant, plutôt que dans une fermeture React ré-inspectée indirectement.
//
// No-op sauf si l'onglet ouvert est "final" ET qu'aucun appel n'a encore été fait (status idle) :
// un second passage sur l'onglet — y compris après publication — ne déclenche donc RIEN côté
// client, en plus du cache par inputHash que V1 applique déjà côté serveur (tests/studio-e2e.
// test.ts) si un second appel réseau devait quand même partir. `setState` bascule sur "loading" DE
// FAÇON SYNCHRONE, avant l'attente de fetchPreview, pour qu'une réouverture déclenchée avant la
// résolution de la première ne puisse pas repasser la garde.
export function handleTabOpen(
  tabValue: string,
  status: PreviewStatus,
  setState: (s: PreviewState) => void,
  articleId: string,
  fetchPreview: (articleId: string) => Promise<RenderForArticleResult>,
): void {
  if (tabValue !== "final" || status !== "idle") return;
  setState({ status: "loading" });
  fetchPreview(articleId).then(
    (result) => setState({ status: "done", result }),
    () => setState({ status: "done", result: { ok: false, message: "Aperçu indisponible pour le moment." } }),
  );
}

// Rendu pur des états de l'onglet « Aperçu final » — composant séparé pour être testable en HTML
// statique (react-dom/server), même convention que TokenPicker/LayerPanel (tests/studio-token-
// picker.test.ts, tests/studio-layer-panel.test.ts). Les quatre états explicites du tableau spec
// V3 §1 sont tous des retranchements de PreviewState["status"] === "done" : "idle"/"loading" ne
// sont que l'attente transitoire du tout premier appel, pas un des quatre.
export function PreviewTabContent({ state }: { state: PreviewState }) {
  if (state.status !== "done") {
    return (
      <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed text-muted-foreground">
        <Loader2 className="size-5 animate-spin" aria-hidden />
        <span className="text-xs">Génération de l&apos;aperçu…</span>
      </div>
    );
  }

  const { result } = state;

  // Recouvre à la fois « informations manquantes » et « stockage R2 non configuré » (spec V3 §1) :
  // les deux arrivent par la même forme { ok: false, message } — le moteur (lib/studio/index.ts)
  // choisit déjà un message français qui NOMME ce qui manque plutôt qu'une trace technique ; cet
  // onglet l'affiche tel quel, sans relecture d'erreur ni icône d'alerte rouge.
  if (!result.ok) {
    return (
      <div className="flex aspect-video w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-[var(--status-pending)]/50 bg-[var(--status-pending)]/10 p-3 text-center text-xs font-medium text-[var(--status-pending)]">
        <ImageOff className="size-5" aria-hidden />
        <span>{result.message}</span>
      </div>
    );
  }

  if (result.url === null) {
    return (
      <div className="flex aspect-video w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
        <span>Aucun gabarit configuré — l&apos;image originale sera publiée telle quelle.</span>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {/* eslint-disable-next-line @next/next/no-img-element -- rendu R2 (lib/studio), aucun pattern remote configuré — même choix que l'image originale ci-dessous. */}
      <img src={result.url} alt="" className="aspect-video w-full rounded-md border object-cover" />
      <p className="text-xs text-muted-foreground">
        Aperçu généré à partir du gabarit du site.{result.degraded ? " Rendu dégradé (police ou image de repli)." : ""}
      </p>
    </div>
  );
}

// Featured image preview + mandatory, always-visible credit. Shown in the
// pending/attention color whenever there's nothing to flag for review: a
// missing image or a broken URL — both need a human to fix them before
// publish (approveAndPublish blocks a set image without a credit).
export function ImagePanel({
  articleId, featuredImageUrl, imageCredit, imageSourceUrl, onImageChange, readOnly,
}: ImageFields & {
  articleId: string;
  onImageChange: (fields: ImageFields) => void;
  readOnly?: boolean;
}) {
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftUrl, setDraftUrl] = useState(featuredImageUrl ?? "");
  const [draftCredit, setDraftCredit] = useState(imageCredit ?? "");
  const [draftSourceUrl, setDraftSourceUrl] = useState(imageSourceUrl ?? "");
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });

  function openEditor() {
    setDraftUrl(featuredImageUrl ?? "");
    setDraftCredit(imageCredit ?? "");
    setDraftSourceUrl(imageSourceUrl ?? "");
    setEditing(true);
  }

  function applyChange() {
    onImageChange({
      featuredImageUrl: draftUrl.trim() || null,
      imageCredit: draftCredit.trim() || null,
      imageSourceUrl: draftSourceUrl.trim() || null,
    });
    setLoadError(false);
    setEditing(false);
  }

  const showPlaceholder = !featuredImageUrl || loadError;

  return (
    <Tabs
      defaultValue="original"
      onValueChange={(v) => handleTabOpen(String(v), preview.status, setPreview, articleId, previewArticleImage)}
    >
      <TabsList className="mb-2 w-full">
        <TabsTrigger value="original" className="flex-1">Image originale</TabsTrigger>
        <TabsTrigger value="final" className="flex-1">Aperçu final</TabsTrigger>
      </TabsList>

      <TabsContent value="original" className="space-y-2">
        {showPlaceholder ? (
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-[var(--status-pending)]/50 bg-[var(--status-pending)]/10 text-[var(--status-pending)]">
            <ImageOff className="size-5" />
            <span className="text-xs font-medium">
              {featuredImageUrl && loadError ? "Échec du chargement de l'image" : "Image absente"}
            </span>
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- external, arbitrary source URLs; no next.config remote pattern configured.
          <img
            src={featuredImageUrl}
            alt=""
            className="aspect-video w-full rounded-md border object-cover"
            onError={() => setLoadError(true)}
          />
        )}

        <div className="text-xs">
          {imageCredit ? (
            <span className="text-muted-foreground">
              Crédit :{" "}
              {imageSourceUrl ? (
                <a
                  href={imageSourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-2 hover:underline"
                >
                  {imageCredit} <ExternalLink className="size-3" />
                </a>
              ) : (
                <span className="font-medium text-foreground">{imageCredit}</span>
              )}
            </span>
          ) : (
            <span className="font-medium text-[var(--status-pending)]">Crédit manquant</span>
          )}
        </div>

        {!readOnly && (
          editing ? (
            <div className="space-y-1.5 rounded-md border p-2">
              <Input
                placeholder="URL de l'image"
                aria-label="URL de l'image"
                value={draftUrl}
                onChange={(e) => setDraftUrl(e.target.value)}
              />
              <Input
                placeholder="Crédit (nom du média)"
                aria-label="Crédit de l'image"
                value={draftCredit}
                onChange={(e) => setDraftCredit(e.target.value)}
              />
              <Input
                placeholder="Lien source"
                aria-label="Lien source de l'image"
                value={draftSourceUrl}
                onChange={(e) => setDraftSourceUrl(e.target.value)}
              />
              <div className="flex justify-end gap-1.5 pt-0.5">
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Annuler
                </Button>
                <Button type="button" size="sm" onClick={applyChange}>
                  Appliquer
                </Button>
              </div>
            </div>
          ) : (
            <Button type="button" variant="outline" size="sm" className="w-full" onClick={openEditor}>
              Changer l'image
            </Button>
          )
        )}
      </TabsContent>

      <TabsContent value="final">
        <PreviewTabContent state={preview} />
      </TabsContent>
    </Tabs>
  );
}
