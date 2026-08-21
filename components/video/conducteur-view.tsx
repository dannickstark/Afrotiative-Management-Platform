import type { Conducteur } from "@/lib/video/rundown";
import { Badge } from "@/components/ui/badge";
import { BeatCheckToggle, InsertDeadFlag } from "@/components/video/conducteur-annotations";

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
                {annotate && b.id && (
                  <BeatCheckToggle beatId={b.id} checked={b.checked} annotate={annotate} />
                )}
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
