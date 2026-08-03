"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="grid min-h-[50vh] place-items-center">
      <div className="grid max-w-md place-items-center gap-3 rounded-xl border border-dashed p-8 text-center">
        <AlertTriangle className="size-8 text-[var(--status-error)]" aria-hidden />
        <h2 className="text-lg font-semibold">Une erreur est survenue</h2>
        <p className="text-sm text-muted-foreground">
          Impossible de charger cette page. Réessayez ou contactez un administrateur si le problème persiste.
        </p>
        <Button
          onClick={reset}
          className="mt-1 bg-[var(--accent-brand)] text-[var(--accent-brand-foreground)]"
        >
          Réessayer
        </Button>
      </div>
    </div>
  );
}
