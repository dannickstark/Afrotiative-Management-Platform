"use client";
import { useEffect, useState } from "react";
import { ExternalLink, ImageOff, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { previewArticleImage } from "@/lib/actions/article-preview-actions";
import type { RenderForArticleResult } from "@/lib/studio";
import { MISSING_LABEL } from "@/lib/pipeline/completeness";

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
    () => setState({
      status: "done",
      // reason: "render_failed" — un rejet de la promesse est un échec de TRANSPORT, jamais le
      // signal "stockage R2 non configuré" (celui-là arrive toujours en `ok:false` résolu, jamais
      // en rejet — voir renderForArticle, lib/studio/index.ts). Le rafraîchissement manuel
      // (refreshPreview, ci-dessous dans ce fichier) est le seul moyen de sortir de cet état.
      result: { ok: false, reason: "render_failed", message: "Aperçu indisponible pour le moment." },
    }),
  );
}

// V3 Tâche 4 (dette V1 §3 assignée à V3) : le moteur (MissingTokensError, lib/studio/values.ts)
// nomme déjà les jetons manquants dans son message, mais sous leur forme TECHNIQUE
// (« article.image », « category.name ») — un rédacteur ne reconnaît pas ce vocabulaire. Cette
// table ne couvre QUE les deux jetons que V1 §6 fait échouer par construction pour le contexte
// article_image (image à la une, catégorie) et réutilise délibérément lib/pipeline/completeness.ts
// ::MISSING_LABEL — le MÊME vocabulaire que la garde de complétude de la publication
// (lib/wp/publish.ts) et la file /queue, pour qu'un rédacteur ne voie jamais deux noms différents
// pour le même manque.
const RENDER_TOKEN_LABEL: Record<string, string> = {
  "article.image": MISSING_LABEL.featuredImageUrl,
  "category.name": MISSING_LABEL.categoryId,
};

const MISSING_TOKENS_PATTERN = /Valeurs manquantes pour : (.+)\.$/;

// PURE — traduit le message technique de MissingTokensError, tel que renderForArticle le renvoie
// (« Génération de l'image échouée — Valeurs manquantes pour : article.image, category.name. »),
// en une liste de champs qu'un rédacteur reconnaît (« Image à la une, Catégorie »), au lieu des
// jetons bruts. Un jeton sans traduction connue (hors V1 §6 : cette table ne couvre QUE
// image/catégorie) reste affiché sous sa forme brute plutôt que d'être silencieusement avalé — un
// futur gabarit référençant un jeton optionnel manquant (ex. brand.logo) doit rester diagnosticable.
// Les messages qui ne nomment PAS de jetons manquants (stockage non configuré, article introuvable,
// échec réseau de l'image…) ressortent inchangés : seul ce motif précis est un vocabulaire à
// traduire, tout le reste est déjà un message français directement affichable.
export function friendlyPreviewMessage(message: string): string {
  const match = MISSING_TOKENS_PATTERN.exec(message);
  if (!match) return message;
  const labels = match[1].split(",").map((t) => RENDER_TOKEN_LABEL[t.trim()] ?? t.trim());
  return `Informations manquantes : ${labels.join(", ")}.`;
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
  // les deux arrivent par la même forme { ok: false, message }. Le moteur (lib/studio/index.ts)
  // choisit déjà un message français, mais pour les jetons manquants il les nomme sous leur forme
  // TECHNIQUE (« article.image ») — friendlyPreviewMessage (Tâche 4, V1 §3 dette assignée à V3) le
  // traduit en un champ qu'un rédacteur reconnaît (« Image à la une ») ; les autres messages (déjà
  // du français directement affichable) ressortent inchangés.
  if (!result.ok) {
    return (
      <div className="flex aspect-video w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-[var(--status-pending)]/50 bg-[var(--status-pending)]/10 p-3 text-center text-xs font-medium text-[var(--status-pending)]">
        <ImageOff className="size-5" aria-hidden />
        <span>{friendlyPreviewMessage(result.message)}</span>
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
  articleId, featuredImageUrl, imageCredit, imageSourceUrl, categoryId, onImageChange, readOnly,
}: ImageFields & {
  articleId: string;
  // Revue finale V3, Important 2 : le rendu article_image dépend AUSSI de la catégorie (jeton
  // category.name, lib/studio/bindings.ts) — pas seulement de l'image — donc l'effet ci-dessous
  // doit invalider l'aperçu sur un changement de l'un OU l'autre, pas seulement de l'image.
  categoryId: string | null;
  onImageChange: (fields: ImageFields) => void;
  readOnly?: boolean;
}) {
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftUrl, setDraftUrl] = useState(featuredImageUrl ?? "");
  const [draftCredit, setDraftCredit] = useState(imageCredit ?? "");
  const [draftSourceUrl, setDraftSourceUrl] = useState(imageSourceUrl ?? "");
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });

  // Revue finale V3, Important 2 : sans ceci, un aperçu déjà "done" (succès OU échec) ne pouvait
  // JAMAIS être recalculé après une correction — handleTabOpen no-op sauf si status === "idle", et
  // rouvrir l'onglet après avoir changé l'image/catégorie ne suffisait donc pas à faire disparaître
  // un message « Informations manquantes » périmé. Cet effet réarme la garde à "idle" dès que l'une
  // des DEUX entrées du rendu change ; le prochain passage sur l'onglet « Aperçu final » (Tabs.
  // onValueChange -> handleTabOpen) redéclenche alors bien un appel. Le cache par inputHash de V1
  // (lib/studio/store.ts) rend ce rappel bon marché quand les entrées sont en réalité identiques —
  // ce qui préserve la garantie « exactement un rendu à l'ouverture, aucun à la réouverture » pour
  // le cas où RIEN n'a changé (tests/article-preview.test.ts, Section 1) : cet effet ne s'exécute
  // alors qu'au montage, où `preview` vaut déjà "idle" — un no-op sans second appel réseau.
  useEffect(() => {
    setPreview({ status: "idle" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- volontairement scindé sur les deux
    // SEULES entrées du rendu article_image (image, catégorie), pas sur `articleId` : un changement
    // d'article démonte/remonte ce composant (clé de route), donc ne passe jamais par cet effet.
  }, [featuredImageUrl, categoryId]);

  // Revue finale V3, Important 2 : affordance de rafraîchissement manuel — nécessaire en PLUS de
  // l'effet ci-dessus, pour le cas qu'il ne couvre pas : un échec de TRANSPORT (réseau, promesse
  // rejetée — handleTabOpen) sans que l'image ni la catégorie n'aient changé. Sans bouton, ce cas
  // restait bloqué sur « Aperçu indisponible pour le moment. » jusqu'à un rechargement complet de
  // la page. Réutilise handleTabOpen (déjà testé, tests/article-preview.test.ts) en forçant le
  // statut passé à "idle" : la garde `status !== "idle"` ne porte que sur cet argument, pas sur
  // `preview.status` réel, donc un appel explicite la contourne délibérément — exactement l'usage
  // qu'un rafraîchissement demandé par l'utilisateur doit avoir.
  function refreshPreview() {
    handleTabOpen("final", "idle", setPreview, articleId, previewArticleImage);
  }

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

      <TabsContent value="final" className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          {/* Revue finale V3, Important 2 : décision explicite — l'aperçu lit l'article PERSISTÉ
              (renderForArticle interroge `articles`, lib/studio/index.ts) alors que ce panneau
              affiche l'état LOCAL, pas encore enregistré (EditorShell, useState). Plutôt que de
              suivre précisément un état "modifié depuis le dernier enregistrement" (aucun signal de
              ce type n'existe ailleurs dans l'éditeur — "Enregistrer" est un bouton explicite, pas
              un autosave), ce rappel reste affiché EN PERMANENCE sous l'onglet : toujours vrai,
              jamais un faux négatif, et ne demande aucune plomberie de comparaison supplémentaire. */}
          <p className="text-xs leading-tight text-muted-foreground">
            Reflète la dernière version enregistrée de l&apos;image et de la catégorie.
          </p>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            onClick={refreshPreview}
            disabled={preview.status === "loading"}
            aria-label="Rafraîchir l'aperçu final"
          >
            <RefreshCw className={`size-3.5 ${preview.status === "loading" ? "animate-spin" : ""}`} aria-hidden />
          </Button>
        </div>
        <PreviewTabContent state={preview} />
      </TabsContent>
    </Tabs>
  );
}
