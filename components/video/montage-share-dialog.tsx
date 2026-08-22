"use client";

import { useState } from "react";
import { Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { MontageSharePanel } from "@/components/video/montage-share-panel";
import type { ShareRow } from "@/lib/montage/access";

// Task 5 : le panneau « Accès monteur » (Task 7) s'ouvrait auparavant en permanence au-dessus du
// conducteur ; il vit désormais derrière ce bouton. `MontageSharePanel` rend déjà sa propre Card
// (ring-1 + rounded-xl, même langage que DialogContent) — le ring propre de DialogContent est donc
// retiré (className `ring-0`) pour ne pas doubler la bordure, mais son padding par défaut (p-4)
// est conservé : c'est le vide dans lequel vit le bouton de fermeture (X), qui ne chevauche donc
// jamais le CardHeader (revue Task 5). Le titre passe en sr-only puisque CardTitle affiche déjà
// « Accès monteur » visuellement — même patron que CommandDialog (components/ui/command.tsx).
//
// Round de correction (revue Task 5) : MontageSharePanel affiche un lien fraîchement créé
// exactement une fois (« Copiez ce lien — il ne sera plus affiché ») et ne le journalise ni ne le
// réaffiche jamais. Un Dialog base-ui se ferme par défaut sur Échap ou clic hors du panneau — un
// de ces deux gestes juste après la création d'un lien effacerait silencieusement sa seule vue,
// forçant une révocation-recréation. Le Dialog est donc contrôlé ici : `secretPending` (un
// booléen, jamais le secret lui-même — remonté par MontageSharePanel via `onSecretPendingChange`)
// annule toute tentative de fermeture tant que l'utilisateur n'a pas cliqué « J'ai copié le
// lien », qui vide `justCreated` côté panneau et donc repasse `secretPending` à false.
export function MontageShareDialog({
  projectId, shares, canManage,
}: {
  projectId: string;
  shares: ShareRow[];
  canManage: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [secretPending, setSecretPending] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(next, eventDetails) => {
        if (!next && secretPending) {
          eventDetails.cancel();
          return;
        }
        setOpen(next);
      }}
    >
      <DialogTrigger render={<Button variant="outline" size="sm"><Users aria-hidden /> Accès monteur</Button>} />
      <DialogContent className="ring-0 sm:max-w-lg">
        <DialogHeader className="sr-only">
          <DialogTitle>Accès monteur</DialogTitle>
        </DialogHeader>
        <MontageSharePanel
          projectId={projectId}
          shares={shares}
          canManage={canManage}
          onSecretPendingChange={setSecretPending}
        />
      </DialogContent>
    </Dialog>
  );
}
