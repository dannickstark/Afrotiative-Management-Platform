"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { verifyProjectLinks } from "@/lib/actions/video-actions";

// Task 6 (SP3) — bouton projet : vérifie en une fois le lien de tous les inserts du projet (par
// opposition au bouton par insert de InsertRow, ci-dessous dans beat-inspector.tsx). Monté en tête
// de l'onglet Écriture (app/(app)/video/[id]/page.tsx).
export function VerifyAllLinks({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      const res = await verifyProjectLinks(projectId);
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success(`${res.counts.ok} ok · ${res.counts.mort} morts · ${res.counts.interdit} interdits`);
      router.refresh();
    });
  }

  return (
    <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={handleClick}>
      {isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Link2 aria-hidden />}
      Vérifier tous les liens
    </Button>
  );
}
