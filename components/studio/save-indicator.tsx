"use client";

import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SaveStatus } from "@/lib/studio/autosave";

// components/studio/save-indicator.tsx — Tâche 7 (U1, spec §8) : l'indicateur d'enregistrement
// QUITTE l'en-tête (voir components/studio/editor-shell.tsx, avant cette tâche : `data-testid=
// "autosave-status"` vivait dans le bandeau du haut) pour se poser À CÔTÉ de ModeSwitch — un frère
// dans le même conteneur centré, spec §5/§8. `saveIndicatorLabel`/`saveIndicatorOffersRetry` sont des
// exports PURS (aucun DOM), même discipline que lib/studio/studio-mode.ts#isModeToggleShortcut : la
// suite de tests de ce projet n'a ni jsdom ni React Testing Library, donc toute DÉCISION affichable
// doit pouvoir se vérifier sans monter de composant.
//
// TROISIÈME état (spec §8) : « Échec — réessayer » n'existait PAS avant cette tâche — un échec
// d'autosauvegarde ne laissait alors aucune affordance de reprise (défaut V2 différé). Le libellé lui-
// même porte déjà l'invite à réessayer (le texte exact de la spec), et un bouton dédié
// (`data-action="retry-save"`) rappelle `onRetry` — câblé par editor-shell.tsx sur
// `autosave.retry()` (lib/studio/autosave.ts), PAS sur un second chemin d'enregistrement : voir la
// documentation de `retry()` là-bas pour la garantie « aucune modification de scène requise ».
//
// `idle` reçoit son PROPRE libellé plutôt que de recycler "saved" : c'est l'état réel du contrôleur
// juste après un enregistrement RÉUSSI quand une modification plus récente est déjà en attente
// (lib/studio/autosave.ts#runPendingSave, branche `hasPending`) — le serveur ne détient alors PAS
// encore la toute dernière valeur (donc pas "Enregistré"), et rien n'est en vol à cet instant précis
// (donc pas "Enregistrement…" non plus). C'est aussi l'état initial avant toute frappe.
export function saveIndicatorLabel(status: SaveStatus): string {
  switch (status) {
    case "saving":
      return "Enregistrement…";
    case "saved":
      return "Enregistré";
    case "error":
      return "Échec — réessayer";
    case "idle":
    default:
      return "En attente";
  }
}

// Le SEUL état qui offre l'affordance de réessai — spec §8 : « le troisième [état] n'existe pas
// aujourd'hui ». Extrait en prédicat PUR plutôt que codé en dur dans le JSX du composant (leçon de la
// Tâche 5 : un `⌘/` inline avait échappé au test de la Tâche 1 ; ici la Tâche 5 avait déjà correctement
// extrait isModeToggleShortcut — même discipline reproduite ici dès le départ).
export function saveIndicatorOffersRetry(status: SaveStatus): boolean {
  return status === "error";
}

export interface SaveIndicatorProps {
  status: SaveStatus;
  /** Message d'échec (AutosaveState.message, lib/studio/autosave.ts) — affiché en infobulle plutôt
   * que dans le libellé principal, pour que celui-ci reste le texte STABLE de la spec (« Échec —
   * réessayer ») quel que soit le détail de l'erreur réseau sous-jacente. */
  message?: string | null;
  onRetry?: () => void;
  className?: string;
}

export function SaveIndicator({ status, message, onRetry, className }: SaveIndicatorProps) {
  const offersRetry = saveIndicatorOffersRetry(status);
  return (
    <div
      data-testid="save-indicator"
      data-status={status}
      title={offersRetry && message ? message : undefined}
      className={cn(
        "flex items-center gap-1 text-xs",
        status === "error" ? "text-destructive" : "text-muted-foreground",
        className,
      )}
    >
      <span>{saveIndicatorLabel(status)}</span>
      {offersRetry && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-action="retry-save"
          aria-label="Réessayer l'enregistrement"
          onClick={onRetry}
        >
          <RotateCw />
        </Button>
      )}
    </div>
  );
}
