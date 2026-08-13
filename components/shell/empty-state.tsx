import { Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Shared empty state primitive (Plan 011 Part A) — promoted from components/dashboard/empty-state.tsx
// so table empties (feeds/members/taxonomy/runs) can adopt the same look, with an optional `action`
// slot for their existing add-CTA (e.g. "Ajouter une source") instead of a bare text row.
export function EmptyState({
  icon, title, hint, action, titleClassName,
}: {
  icon?: ReactNode;
  title: string;
  // Chantier E Tâche 3 : élargi de `string` à `ReactNode` pour que les surfaces vides du studio
  // (property-panel.tsx) puissent y ancrer un `data-testid` verrouillé par des tests existants
  // (ex. `<span data-testid="property-panel-empty-hint">…</span>`) sans que ce composant partagé lui
  // -même ait besoin de connaître cette contrainte. Élargissement rétrocompatible : `string` reste un
  // `ReactNode` valide, donc tous les appelants actuels (members-table.tsx, feeds-table.tsx,
  // taxonomy-tables.tsx, runs-view.tsx, pending-list.tsx, error-list.tsx — tous passent une chaîne)
  // continuent de typechecker sans modification.
  hint?: ReactNode;
  action?: ReactNode;
  // Chantier E Tâche 5 (finition de marque) — ADDITIF, optionnel, `undefined` par défaut : permet aux
  // DEUX surfaces vides du studio (property-panel.tsx, editor-shell.tsx#TooSmallState) de poser
  // `font-heading` sur LEUR titre sans changer le rendu par défaut de ce composant PARTAGÉ pour ses
  // autres appelants (members-table.tsx, feeds-table.tsx, taxonomy-tables.tsx, runs-view.tsx,
  // pending-list.tsx, error-list.tsx) — le brief de tâche ne demande la police éditoriale QUE pour les
  // titres d'EmptyState « du studio », jamais pour le reste du produit.
  titleClassName?: string;
}) {
  return (
    <div className="grid place-items-center gap-3 rounded-lg border border-dashed py-16 text-center">
      {icon ?? <Inbox className="size-8 text-muted-foreground" aria-hidden />}
      <div className="space-y-1">
        <p className={cn("font-medium", titleClassName)}>{title}</p>
        {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      </div>
      {action}
    </div>
  );
}
