"use client";
import { useState } from "react";
import { ExternalLink, ImageOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type ImageFields = {
  featuredImageUrl: string | null;
  imageCredit: string | null;
  imageSourceUrl: string | null;
};

// Featured image preview + mandatory, always-visible credit. Shown in the
// pending/attention color whenever there's nothing to flag for review: a
// missing image or a broken URL — both need a human to fix them before
// publish (approveAndPublish blocks a set image without a credit).
export function ImagePanel({
  featuredImageUrl, imageCredit, imageSourceUrl, onImageChange, readOnly,
}: ImageFields & {
  onImageChange: (fields: ImageFields) => void;
  readOnly?: boolean;
}) {
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftUrl, setDraftUrl] = useState(featuredImageUrl ?? "");
  const [draftCredit, setDraftCredit] = useState(imageCredit ?? "");
  const [draftSourceUrl, setDraftSourceUrl] = useState(imageSourceUrl ?? "");

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
    <div className="space-y-2">
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
    </div>
  );
}
