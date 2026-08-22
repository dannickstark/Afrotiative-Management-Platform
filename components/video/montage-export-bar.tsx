import { Download, FileJson, Film } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Task 5 : les trois exports restent de vrais téléchargements servis par /api/montage/export —
// des <a href> habillés avec buttonVariants (patron déjà établi par components/queue/row-actions.tsx
// et app/(app)/settings/error.tsx), jamais des onClick ni un composant client pour le seul style.
export function MontageExportBar({ variantId }: { variantId: string }) {
  const linkClass = cn(buttonVariants({ variant: "outline", size: "sm" }));
  return (
    <div className="flex flex-wrap gap-2">
      <a href={`/api/montage/export?variantId=${variantId}&format=csv`} className={linkClass}>
        <Download aria-hidden /> Export CSV
      </a>
      <a href={`/api/montage/export?variantId=${variantId}&format=json`} className={linkClass}>
        <FileJson aria-hidden /> Export JSON
      </a>
      <a href={`/api/montage/export?variantId=${variantId}&format=manifest`} className={linkClass}>
        <Film aria-hidden /> Manifeste médias
      </a>
    </div>
  );
}
