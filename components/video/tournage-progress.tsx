// components/video/tournage-progress.tsx — Task 6 (SP 014, UX pass) : en-tête d'avancement du
// mode Journal de components/video/tournage-view.tsx (prises retenues, total de prises, beats sans
// prise) et la barre de filtres client qui l'accompagne. Extrait dans son propre fichier pour garder
// tournage-view.tsx navigable — même esprit que components/video/conducteur-view.tsx dont la barre
// de progression (piste + remplissage `var(--status-approved)`) est reprise ici à l'identique.
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { plural } from "@/lib/video/labels";
import type { TournageBeat } from "@/lib/video/takes-core";

export type TournageFilter = "tous" | "sans_prise" | "a_revoir";

// Un beat « à revoir » a des prises mais aucune marquée `bonne` — beats.takes est vide dans le cas
// « sans prise », un cas distinct traité séparément (cf. lib/video/takes-core.ts#TournageBeat).
export function beatNeedsReview(beat: TournageBeat): boolean {
  return beat.takes.length > 0 && !beat.takes.some((t) => t.status === "bonne");
}

export function beatHasNoTake(beat: TournageBeat): boolean {
  return beat.takes.length === 0;
}

export function filterBeats(beats: TournageBeat[], filter: TournageFilter): TournageBeat[] {
  if (filter === "sans_prise") return beats.filter(beatHasNoTake);
  if (filter === "a_revoir") return beats.filter(beatNeedsReview);
  return beats;
}

// Quelle carte doit être "pleine" (accordéon) compte tenu du filtre actif — dérivée à CHAQUE rendu
// depuis `visible`, jamais figée dans le seul état stocké. Sans ça, changer de filtre pouvait
// exclure le beat déplié de `visible` : plus aucune carte pleine ne s'affichait (donc plus de
// boutons plateau 44px) tant que l'utilisateur n'avait pas cliqué "Déplier" (revue Task 6, ronde 2 —
// finding important, components/video/tournage-view.tsx#JournalMode). Repli : si le beat
// actuellement déplié est toujours visible, on le garde ; sinon le premier beat visible qui a
// encore besoin d'attention (pas de prise retenue) ; sinon le premier beat visible tout court.
export function resolveExpandedId(
  visible: TournageBeat[], currentExpandedId: string | undefined,
): string | undefined {
  if (currentExpandedId !== undefined && visible.some((b) => b.id === currentExpandedId)) {
    return currentExpandedId;
  }
  return (visible.find((b) => b.selectedTakeId === null) ?? visible[0])?.id;
}

const FILTERS: { value: TournageFilter; label: string }[] = [
  { value: "tous", label: "Tous les beats" },
  { value: "sans_prise", label: "Sans prise" },
  { value: "a_revoir", label: "À revoir" },
];

export function TournageProgressHeader({ beats, filter, onFilterChange }: {
  beats: TournageBeat[];
  filter: TournageFilter;
  onFilterChange: (f: TournageFilter) => void;
}) {
  const retainedCount = beats.filter((b) => b.selectedTakeId !== null).length;
  const totalBeats = beats.length;
  // Gardé contre la division par zéro quand la variante n'a aucun beat — la barre reste alors à
  // 0 %, pas NaN (même garde que ConducteurView#montedPct).
  const pct = totalBeats === 0 ? 0 : Math.round((retainedCount / totalBeats) * 100);
  const totalTakes = beats.reduce((sum, b) => sum + b.takes.length, 0);
  const noTakeCount = beats.filter(beatHasNoTake).length;

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 px-4 py-3 text-sm">
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-xs text-muted-foreground">
          Prises retenues : {retainedCount} / {totalBeats} {plural(totalBeats, "beat")}
        </span>
        <div className="h-1 w-full flex-1 rounded-full bg-border">
          <div
            className="h-1 rounded-full bg-[var(--status-approved)]"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <span>{totalTakes} prise(s)</span>
        {noTakeCount > 0 && <Badge variant="outline">{noTakeCount} {plural(noTakeCount, "beat")} sans prise</Badge>}
      </div>
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Button
            key={f.value}
            type="button"
            size="sm"
            variant={filter === f.value ? "default" : "outline"}
            aria-pressed={filter === f.value}
            onClick={() => onFilterChange(f.value)}
          >
            {f.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
