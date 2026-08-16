import { cn } from "@/lib/utils";

// Task 12 — cumul de durée face à la durée cible d'une variante. Module PUR côté rendu (aucun
// accès DB/réseau) : `totalSec` est déjà calculé par l'appelant via `variantSeconds`
// (lib/video/duration.ts), pas recalculé ici.
//
// `X min SS s` — même format que ProjectList#formatDuration (components/video/project-list.tsx) ;
// non réexporté d'ici pour éviter un couplage entre l'écran de liste et celui d'écriture, le format
// tenant en trois lignes.
function formatMinSec(totalSec: number): string {
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes} min ${String(seconds).padStart(2, "0")} s`;
}

export function DurationMeter({ totalSec, targetSec }: { totalSec: number; targetSec: number | null }) {
  // Point de conception : sans cible, aucun écart ne s'affiche — targetSec est souvent absent tant
  // que le brief n'a pas été rempli (variant.targetDurationSec est nullable), et un écart contre
  // zéro serait un mensonge visuel plutôt qu'une absence d'info.
  const diff = targetSec === null ? null : totalSec - targetSec;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-4 py-3 text-sm">
      <span>
        Cumul : <span className="font-medium">{formatMinSec(totalSec)}</span>
      </span>
      {targetSec !== null && diff !== null && (
        <>
          <span className="text-muted-foreground">Cible : {formatMinSec(targetSec)}</span>
          {/* Signe moins U+2212 (« − »), pas un tiret ASCII — c'est le vrai signe mathématique,
              distinct visuellement du tiret utilisé ailleurs dans l'écran (ex. ProjectList). */}
          <span className={cn("font-medium", diff > 0 && "text-destructive")}>
            {diff > 0 ? `+${diff} s` : diff < 0 ? `−${Math.abs(diff)} s` : "0 s"}
          </span>
        </>
      )}
    </div>
  );
}
