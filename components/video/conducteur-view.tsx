import type { Conducteur } from "@/lib/video/rundown";
import { Badge } from "@/components/ui/badge";
import { BeatCheckToggle, InsertDeadFlag } from "@/components/video/conducteur-annotations";
import { plural } from "@/lib/video/labels";
import { cn } from "@/lib/utils";

function fmt(sec: number): string {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Task 9 : `annotate` optionnelle — absente, la vue reste strictement en lecture seule (patron
// d'origine, Task 4) ; présente, elle porte soit `projectId` (voie app, garde video:annotate déjà
// vérifiée par l'appelant) soit `shareToken` (voie jeton de partage), jamais les deux à la fois en
// pratique. C'est cette même valeur qui redescend telle quelle vers les server actions
// (toggleBeatChecked/flagInsertDead), qui l'imposent ou la vérifient — la vue ne fait AUCUN choix
// d'autorisation elle-même.
export function ConducteurView({
  conducteur, annotate,
}: {
  conducteur: Conducteur;
  annotate?: { projectId?: string; shareToken?: string };
}) {
  const { beats, totals } = conducteur;
  // Avancement montage : compte les beats dont `checked` (le flag « Monté ») est vrai. Gardé contre
  // la division par zéro quand la variante n'a aucun beat — la barre reste alors à 0 %, pas NaN.
  const montedCount = beats.filter((b) => b.checked).length;
  const montedPct = totals.beatCount === 0 ? 0 : Math.round((montedCount / totals.beatCount) * 100);
  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-lg border bg-muted/30 px-4 py-3 text-sm">
        <div className="flex flex-wrap gap-4">
          <span>{totals.beatCount} {plural(totals.beatCount, "beat")}</span>
          <span>Durée {fmt(totals.totalDurationSec)}</span>
          <span>{totals.insertCount} {plural(totals.insertCount, "insert")}</span>
          {totals.deadLinkCount > 0 && (
            <span className="text-destructive">{totals.deadLinkCount} lien(s) mort(s)</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="shrink-0 text-xs text-muted-foreground">
            {montedCount} / {totals.beatCount} {plural(totals.beatCount, "beat")} {plural(totals.beatCount, "monté")}
          </span>
          <div className="h-1 w-full flex-1 rounded-full bg-border">
            <div
              className="h-1 rounded-full bg-[var(--status-approved)]"
              style={{ width: `${montedPct}%` }}
            />
          </div>
        </div>
      </div>

      {beats.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucun beat à monter pour l'instant.</p>
      ) : (
        <ol className="space-y-3">
          {beats.map((b) => (
            <li
              key={b.position}
              className={cn("rounded-lg border px-4 py-3", b.checked && "bg-muted/40")}
            >
              <div className="flex items-center gap-2 text-sm">
                <span className="font-mono text-muted-foreground">#{b.position + 1}</span>
                <Badge variant="secondary">{b.kindLabel}</Badge>
                <span className="text-muted-foreground">{fmt(b.durationSec)}</span>
                {b.breathRisk && <Badge variant="outline">souffle</Badge>}
                {b.speakerName && <span className="text-muted-foreground">· {b.speakerName}</span>}
                {annotate && b.id && (
                  <BeatCheckToggle beatId={b.id} checked={b.checked} annotate={annotate} />
                )}
              </div>
              {b.spokenText && (
                <p className={cn("mt-2 text-sm", b.checked && "text-muted-foreground")}>{b.spokenText}</p>
              )}
              {b.directionNote && <p className="mt-1 text-xs text-muted-foreground">Réal. : {b.directionNote}</p>}
              {b.screenText && <p className="mt-1 text-xs text-muted-foreground">Écran : {b.screenText}</p>}
              {(b.transitionIn || b.transitionOut) && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Transition : {b.transitionIn ?? "—"} → {b.transitionOut ?? "—"}
                </p>
              )}
              {b.inserts.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {b.inserts.map((ins) => (
                    <li key={ins.id} className="flex flex-wrap items-center gap-2 text-xs">
                      <Badge variant="secondary">{ins.kindLabel}</Badge>
                      {(ins.tcIn || ins.tcOut) && <span className="font-mono">{ins.tcIn ?? "—"}–{ins.tcOut ?? "—"}</span>}
                      {ins.mediaUrl && <a href={ins.mediaUrl} className="underline" target="_blank" rel="noreferrer">média</a>}
                      {ins.credit && <span className="text-muted-foreground">© {ins.credit}</span>}
                      {ins.rightsNote && <span className="text-muted-foreground">droits : {ins.rightsNote}</span>}
                      <Badge variant={ins.linkStatus === "mort" || ins.linkStatus === "interdit" ? "destructive" : "outline"}>
                        {ins.linkLabel}
                      </Badge>
                      {annotate && (
                        <InsertDeadFlag insertId={ins.id} linkStatus={ins.linkStatus} annotate={annotate} />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
