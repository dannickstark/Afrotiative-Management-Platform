"use client";
// components/video/conducteur-annotations.tsx — Task 9 : contrôles d'annotation du monteur
// (beat coché, insert signalé mort), rendus par ConducteurView à côté de chaque beat/insert
// UNIQUEMENT quand celle-ci reçoit la prop `annotate` (voir components/video/conducteur-view.tsx).
// Même patron que components/video/montage-share-panel.tsx : useTransition + toast +
// router.refresh() plutôt qu'un état local dérivé — la vérité reste côté serveur, journalisée.
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, Circle, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toggleBeatChecked, flagInsertDead } from "@/lib/actions/montage-actions";

type AnnotateAuth = { projectId?: string; shareToken?: string };

export function BeatCheckToggle({
  beatId, checked, annotate,
}: {
  beatId: string;
  checked: boolean;
  annotate: AnnotateAuth;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      const res = await toggleBeatChecked({ beatId, projectId: annotate.projectId, shareToken: annotate.shareToken });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success(res.checked ? "Beat marqué monté." : "Beat démarqué.");
      router.refresh();
    });
  }

  return (
    <Button variant={checked ? "secondary" : "outline"} size="sm" disabled={isPending} onClick={handleClick}>
      {isPending ? (
        <Loader2 className="animate-spin" aria-hidden />
      ) : checked ? (
        <CheckCircle2 aria-hidden />
      ) : (
        <Circle aria-hidden />
      )}
      Monté
    </Button>
  );
}

export function InsertDeadFlag({
  insertId, linkStatus, annotate,
}: {
  insertId: string;
  linkStatus: string;
  annotate: AnnotateAuth;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  if (linkStatus === "mort") return null;

  function handleClick() {
    startTransition(async () => {
      const res = await flagInsertDead({ insertId, projectId: annotate.projectId, shareToken: annotate.shareToken });
      if (!res.ok) {
        toast.error(res.message ?? "Échec du signalement.");
        return;
      }
      toast.success("Lien signalé comme mort.");
      router.refresh();
    });
  }

  return (
    <Button variant="ghost" size="sm" disabled={isPending} onClick={handleClick}>
      {isPending ? <Loader2 className="animate-spin" aria-hidden /> : <TriangleAlert aria-hidden />}
      Signaler lien mort
    </Button>
  );
}
