"use client";

import { Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { MontageSharePanel } from "@/components/video/montage-share-panel";
import type { ShareRow } from "@/lib/montage/access";

// Task 5 : le panneau « Accès monteur » (Task 7) s'ouvrait auparavant en permanence au-dessus du
// conducteur ; il vit désormais derrière ce bouton. `MontageSharePanel` rend déjà sa propre Card
// (ring-1 + rounded-xl, même langage que DialogContent) — DialogContent est donc réduit à un cadre
// invisible (p-0, sans ring propre) pour ne pas doubler la bordure, et le titre passe en sr-only
// puisque CardTitle affiche déjà « Accès monteur » visuellement. Même patron que CommandDialog
// (components/ui/command.tsx). La garde `can(user.role, "video", "manage")` reste entièrement dans
// la page (app/(app)/video/[id]/page.tsx) : ce composant ne décide de rien, `canManage` lui est
// transmis tel quel et il ne rend même le bouton déclencheur que si l'appelant le monte.
export function MontageShareDialog({
  projectId, shares, canManage,
}: {
  projectId: string;
  shares: ShareRow[];
  canManage: boolean;
}) {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" size="sm"><Users aria-hidden /> Accès monteur</Button>} />
      <DialogContent className="p-0 ring-0 sm:max-w-lg" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>Accès monteur</DialogTitle>
        </DialogHeader>
        <MontageSharePanel projectId={projectId} shares={shares} canManage={canManage} />
      </DialogContent>
    </Dialog>
  );
}
