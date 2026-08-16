"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Film, TriangleAlert } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shell/empty-state";
import { DurationMeter } from "./duration-meter";
import { BeatInspector } from "./beat-inspector";
import { isBreathRisk } from "@/lib/video/duration";
import { reorderBeats } from "@/lib/actions/video-actions";
import { cn } from "@/lib/utils";

// Task 12 — Produces (voir brief) : la forme consommée par la vue Écriture. `sources` est
// optionnel : script_beats.sources existe en base et alimente BeatInspector (liste des sources),
// mais n'entre pas dans le contrat BeatList/DurationMeter du plan, donc un champ optionnel plutôt
// qu'un ajout au contrat figé — les appelants qui ne le fournissent pas (ex. les fixtures de test)
// restent valides.
export type InsertView = {
  id: string;
  kind: string;
  url: string | null;
  tcIn: string | null;
  tcOut: string | null;
  displayDurationSec: number | null;
  credit: string | null;
  linkStatus: string;
};

export type BeatView = {
  id: string;
  externalId: string;
  position: number;
  kind: string;
  spokenText: string;
  directionNote: string | null;
  screenText: string | null;
  transitionIn: string | null;
  transitionOut: string | null;
  estimatedDurationSec: number;
  durationOverrideSec: number | null;
  locallyEdited: boolean;
  inserts: InsertView[];
  sources?: string[];
};

// Round de correction 1 (Task 12, I2) : durée AFFICHÉE = durée STOCKÉE (`durationOverrideSec ??
// estimatedDurationSec`), jamais recalculée côté client via `beatSeconds()`. La valeur stockée a
// été calculée côté serveur avec la cadence des RÉGLAGES (lib/queries/video-settings.ts,
// configurable), alors que `beatSeconds()` appelée sans second argument retombe sur
// `DEFAULT_WPM` — dès que le réglage diffère de 155 mots/min, la colonne « Durée » et le cumul
// contredisaient silencieusement la valeur que la vue montage et les exports du SP2 utiliseront.
// Même `??` que lib/video/duration.ts#beatSeconds — une durée forcée à 0 reste un choix légitime.
function storedSeconds(beat: Pick<BeatView, "durationOverrideSec" | "estimatedDurationSec">): number {
  return beat.durationOverrideSec ?? beat.estimatedDurationSec;
}

// Libellés français des `beat_kind` (db/schema.ts) — même motif que PLATFORM_LABEL
// (components/video/project-list.tsx) : une table de correspondance plutôt qu'un `replace` cosmétique,
// parce que ces valeurs ne sont pas de simples mots français à espaces près (ex. "broll", "reponse").
// Exportée (Task 13) : la revue de diff (diff-review.tsx) affiche le type de chaque beat proposé
// avec le même libellé que la vue Écriture — une seconde table divergerait silencieusement.
export const KIND_LABEL: Record<string, string> = {
  narration: "Narration",
  question: "Question",
  reponse: "Réponse",
  insert: "Insert",
  broll: "B-roll",
  transition: "Transition",
  texte_ecran: "Texte à l'écran",
  son: "Son",
  note: "Note",
};

export function BeatList({
  beats, targetDurationSec, variantId,
}: {
  beats: BeatView[];
  targetDurationSec: number | null;
  // Optionnel : le contrat du plan (brief Task 12) ne porte que `beats`/`targetDurationSec` — les
  // tests instancient BeatList sans variantId. En usage réel (app/(app)/video/[id]/page.tsx),
  // variantId est toujours fourni : sans lui, reorderBeats n'a pas de variante à cibler et le
  // glisser-déposer reste visuel-seul (voir handleDrop ci-dessous).
  variantId?: string;
}) {
  const [items, setItems] = useState(beats);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  // Une nouvelle liste de props (changement de variante, ou rechargement après import) remplace
  // l'état local plutôt que de fusionner — le brief ne demande pas de survivre à un changement de
  // variante en préservant un réordonnancement en vol.
  useEffect(() => {
    setItems(beats);
  }, [beats]);

  const totalSec = items.reduce((sum, b) => sum + storedSeconds(b), 0);
  const selected = items.find((b) => b.id === selectedId) ?? null;

  function handleDrop(targetIndex: number) {
    if (!dragId) return;
    const fromIndex = items.findIndex((b) => b.id === dragId);
    setDragId(null);
    if (fromIndex === -1 || fromIndex === targetIndex) return;

    const next = [...items];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(targetIndex, 0, moved);
    const previous = items;
    setItems(next);

    if (!variantId) return;
    reorderBeats({ variantId, order: next.map((b) => b.externalId) }).then((res) => {
      if (!res.ok) {
        setItems(previous);
        toast.error(res.message);
      }
    });
  }

  function handleSaved(patch: Partial<BeatView> & { id: string }) {
    setItems((prev) => prev.map((b) => (b.id === patch.id ? { ...b, ...patch, locallyEdited: true } : b)));
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<Film className="size-8 text-muted-foreground" aria-hidden />}
        title="Aucun beat"
        hint="Aucun beat — importez la réponse de Claude pour commencer."
      />
    );
  }

  return (
    <div className="space-y-4">
      <DurationMeter totalSec={totalSec} targetSec={targetDurationSec} />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">#</TableHead>
            <TableHead>Beat</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Texte</TableHead>
            <TableHead className="text-right">Durée</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((beat, index) => {
            const breathRisk = isBreathRisk(beat.spokenText);
            return (
              <TableRow
                key={beat.id}
                data-beat-id={beat.id}
                className="cursor-pointer"
                // Round de correction 1 (Task 12, Minor), corrigé au round 2 (N1) : la ligne
                // n'était ouvrable qu'à la souris (`onClick` seul, sans piste de tabulation) —
                // l'inspecteur était inatteignable au clavier. `tabIndex` + Entrée/Espace en font
                // une ligne focalisable et actionnable SANS `role="button"` : ce rôle écrasait le
                // rôle implicite `row` de la `<tr>`, ce qui détachait ses `<td>` de toute ligne et
                // faisait perdre à la table entière sa structure ligne/colonne pour un lecteur
                // d'écran (plus d'annonce « ligne 3 sur 12 », plus de navigation par cellule) — un
                // correctif d'accessibilité en cassait une autre, plus large. Un `button` ARIA ne
                // peut de toute façon pas contenir de contenu tabulaire.
                tabIndex={0}
                aria-label={`Ouvrir le beat ${beat.externalId}`}
                draggable
                // `setData` — pas seulement l'état local `dragId` — parce que Firefox exige un
                // appel réel à dataTransfer.setData pour amorcer une opération de glisser (même
                // motif que components/studio/layer-panel.tsx#LayerRow).
                onDragStart={(e) => { e.dataTransfer.setData("text/beat-id", beat.id); setDragId(beat.id); }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDrop(index);
                }}
                onClick={() => setSelectedId(beat.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedId(beat.id);
                  }
                }}
              >
                <TableCell className="text-muted-foreground">{index + 1}</TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <span className="font-mono text-xs text-muted-foreground">{beat.externalId}</span>
                    {beat.locallyEdited && <Badge variant="outline">Modifié localement</Badge>}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{KIND_LABEL[beat.kind] ?? beat.kind}</Badge>
                </TableCell>
                <TableCell className="max-w-md">
                  <div
                    className="line-clamp-2 text-sm text-foreground [&_p]:inline"
                    // spokenText est déjà assaini côté serveur (lib/sanitize.ts, appliqué avant
                    // écriture en base) — ni ré-assaini ni contourné ici, cf. contraintes du brief.
                    dangerouslySetInnerHTML={{ __html: beat.spokenText }}
                  />
                  {breathRisk && (
                    <div className="mt-1 flex items-center gap-1 text-xs text-[var(--status-pending)]">
                      <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                      {/* Signal, jamais un blocage : simple avertissement, aucune désactivation de
                          l'enregistrement n'en découle. */}
                      <span>Trop long à dire d&apos;un souffle</span>
                    </div>
                  )}
                </TableCell>
                <TableCell className={cn("text-right tabular-nums", breathRisk && "text-[var(--status-pending)]")}>
                  {storedSeconds(beat)} s
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <BeatInspector
        beat={selected}
        open={selected !== null}
        onOpenChange={(open) => { if (!open) setSelectedId(null); }}
        onSaved={handleSaved}
      />
    </div>
  );
}
