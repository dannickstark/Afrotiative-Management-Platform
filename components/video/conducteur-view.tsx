import type { Conducteur } from "@/lib/video/rundown";
import { Badge } from "@/components/ui/badge";

function fmt(sec: number): string {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function ConducteurView({ conducteur }: { conducteur: Conducteur }) {
  const { beats, totals } = conducteur;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4 rounded-lg border bg-muted/30 px-4 py-3 text-sm">
        <span>{totals.beatCount} beats</span>
        <span>Durée {fmt(totals.totalDurationSec)}</span>
        <span>{totals.insertCount} inserts</span>
        {totals.deadLinkCount > 0 && (
          <span className="text-destructive">{totals.deadLinkCount} lien(s) mort(s)</span>
        )}
      </div>

      {beats.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucun beat à monter pour l'instant.</p>
      ) : (
        <ol className="space-y-3">
          {beats.map((b) => (
            <li key={b.position} className="rounded-lg border px-4 py-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-mono text-muted-foreground">#{b.position + 1}</span>
                <Badge variant="secondary">{b.kindLabel}</Badge>
                <span className="text-muted-foreground">{fmt(b.durationSec)}</span>
                {b.breathRisk && <Badge variant="outline">souffle</Badge>}
                {b.speakerName && <span className="text-muted-foreground">· {b.speakerName}</span>}
              </div>
              {b.spokenText && <p className="mt-2 text-sm">{b.spokenText}</p>}
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
