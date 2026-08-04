"use client";

import Link from "next/link";
import { AlertTriangle, ShieldAlert } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Next.js error boundary scoped to the settings subtree (app/(app)/settings/**). A refused role
// (e.g. Journaliste on any /settings/* page, or Éditeur on /settings/team or
// /settings/integrations) hits this via the thrown PermissionError from requirePermission
// (lib/rbac.ts) in each settings page's server component — without this boundary that throw
// bubbles up to the generic app-level error.tsx (app/(app)/error.tsx) with a confusing "an error
// occurred" message instead of a clear "you don't have access" one.
//
// This is UX only: it does NOT weaken the actual server-side refusal — requirePermission still
// throws and the settings content is never rendered to a refused role. It only decides what the
// refused user SEES once that throw happens.
//
// error.name survives to the client for a thrown Error in a Server Component in dev, but Next.js
// may redact server error details (message, and in some configurations name) in production for
// non-digest errors. So this deliberately stays generic for anything it can't positively identify
// as a PermissionError, rather than assuming every error here is a permission refusal.
export default function SettingsError({ error }: { error: Error & { digest?: string } }) {
  const isPermissionError = error.name === "PermissionError";

  return (
    <div className="grid min-h-[50vh] place-items-center">
      <div className="grid max-w-md place-items-center gap-3 rounded-xl border border-dashed p-8 text-center">
        {isPermissionError ? (
          <>
            <ShieldAlert className="size-8 text-[var(--status-error)]" aria-hidden />
            <h2 className="text-lg font-semibold">Accès refusé</h2>
            <p className="text-sm text-muted-foreground">
              Vous n&apos;avez pas les droits pour cette page.
            </p>
          </>
        ) : (
          <>
            <AlertTriangle className="size-8 text-[var(--status-error)]" aria-hidden />
            <h2 className="text-lg font-semibold">Une erreur est survenue</h2>
            <p className="text-sm text-muted-foreground">
              Impossible de charger cette page. Contactez un administrateur si le problème persiste.
            </p>
          </>
        )}
        <Link href="/dashboard" className={cn(buttonVariants({}), "mt-1 bg-[var(--accent-brand)] text-[var(--accent-brand-foreground)]")}>
          Retour au tableau de bord
        </Link>
      </div>
    </div>
  );
}
