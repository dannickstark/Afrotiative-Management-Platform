"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { History, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { restoreVersion } from "@/lib/actions/studio-actions";
import type { TemplateVersionRow } from "@/lib/queries/studio";
import type { Scene } from "@/lib/studio/scene";

// components/studio/version-history.tsx — Tâche 9 (spec §3) : liste les versions publiées d'un
// gabarit, chacune avec *Restaurer*. Restaurer copie l'instantané choisi dans le BROUILLON
// (restoreVersionCore, lib/studio/template-core.ts) SANS toucher publishedVersion — « republier
// reste un geste explicite ».
//
// `onRestore(scene)` recharge le canevas de l'éditeur CÔTÉ CLIENT, immédiatement, avec la scène de
// la version choisie — sans second aller-retour serveur : `versions` (chargé par le Server
// Component parent, lib/queries/studio.ts:getTemplateById) porte déjà l'instantané COMPLET de
// chaque version, pas seulement ses métadonnées. restoreVersion() reste le SEUL chemin d'écriture
// réel (persiste le brouillon en base) ; ce composant ne fait qu'en refléter le résultat côté
// client sans attendre un rechargement de page pour que le canevas se mette à jour.
export interface VersionHistoryProps {
  templateId: string;
  publishedVersion: number | null;
  versions: TemplateVersionRow[];
  onRestore: (scene: Scene) => void;
}

const dateFormatter = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
});

export function VersionHistory({ templateId, publishedVersion, versions, onRestore }: VersionHistoryProps) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);

  function handleRestore(v: TemplateVersionRow) {
    setRestoringVersion(v.version);
    startTransition(async () => {
      const res = await restoreVersion(templateId, v.version);
      setRestoringVersion(null);
      if (res.ok) {
        toast.success(`Version ${v.version} restaurée dans le brouillon.`);
        setOpen(false);
        onRestore(v.scene);
      } else {
        toast.error(res.message);
      }
    });
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        type="button" variant="outline" size="sm" data-action="version-history"
        onClick={() => setOpen(true)}
      >
        <History />
        Historique{versions.length > 0 ? ` (${versions.length})` : ""}
      </Button>
      <SheetContent data-testid="version-history-sheet">
        <SheetHeader>
          <SheetTitle>Historique des versions</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-2 overflow-auto px-4 pb-4">
          {versions.length === 0 && (
            <p className="text-sm text-muted-foreground">Ce gabarit n&rsquo;a jamais été publié.</p>
          )}
          {versions.map((v) => (
            <div
              key={v.version}
              data-version-row={v.version}
              className="flex items-center justify-between gap-2 rounded-lg border p-2.5"
            >
              <div>
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  Version {v.version}
                  {v.version === publishedVersion && <Badge>Publiée</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                  {dateFormatter.format(v.publishedAt)}
                  {v.publishedByName ? ` · ${v.publishedByName}` : ""}
                </p>
              </div>
              <Button
                type="button" variant="outline" size="sm"
                data-action="restore" data-version={v.version}
                disabled={pending && restoringVersion === v.version}
                onClick={() => handleRestore(v)}
              >
                <RotateCcw />
                {pending && restoringVersion === v.version ? "Restauration…" : "Restaurer"}
              </Button>
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
