"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Film, TriangleAlert } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shell/empty-state";
import { BeatInspector } from "./beat-inspector";
import { isBreathRisk } from "@/lib/video/duration";
import { reorderBeats } from "@/lib/actions/video-actions";
import { cn } from "@/lib/utils";
import { INSERT_KIND_LABEL, LINK_STATUS_LABEL } from "@/lib/video/labels";

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
  rightsNote: string | null;
  r2Key: string | null;
  linkCheckedAt: Date | string | null;
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
  // Task 5 (SP5, mode interview) : le locuteur du beat, et — pour un beat `reponse` — la question
  // à laquelle il répond. Tous deux nullables : un beat narratif n'a ni l'un ni l'autre, et un
  // beat interview peut rester non attribué (voir beat-inspector.tsx, select « Locuteur »).
  speakerId: string | null;
  answersBeatId: string | null;
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

// Task 4 (SP 014 — UX pass) — ordre de gravité des `link_status` (db/schema.ts) pour la pastille
// « pire statut » de la colonne Médias : mort/interdit (rouge) > non_verifie (ambre) > ok (vert).
// mort et interdit partagent le même rang — les deux sont rouges, aucun des deux n'est « pire » que
// l'autre pour cet indicateur agrégé.
const LINK_STATUS_SEVERITY: Record<string, number> = { ok: 0, non_verifie: 1, mort: 2, interdit: 2 };

// Couleur de la pastille — mêmes tokens `--status-*` que le reste du module (ex.
// video-status-badge.tsx, project-header.tsx), pas de nouvelle palette.
const LINK_STATUS_DOT_COLOR: Record<string, string> = {
  ok: "var(--status-approved)",
  non_verifie: "var(--status-pending)",
  mort: "var(--destructive)",
  interdit: "var(--destructive)",
};

// Le pire linkStatus parmi les inserts d'un beat, ou null si le beat n'a aucun insert — dans ce
// cas la colonne Médias n'affiche aucune pastille (brief : « un beat sans insert ne montre aucun
// point »).
function worstLinkStatus(inserts: InsertView[]): string | null {
  if (inserts.length === 0) return null;
  return inserts.reduce(
    (worst, i) => (LINK_STATUS_SEVERITY[i.linkStatus] > LINK_STATUS_SEVERITY[worst] ? i.linkStatus : worst),
    inserts[0].linkStatus,
  );
}

// Accord au pluriel du libellé d'un insert (`INSERT_KIND_LABEL`) quand son compte dépasse 1 —
// toutes les valeurs actuelles (image, vidéo, extrait, graphique, fichier) prennent un simple
// « s » ; pas de table de pluriels irréguliers tant qu'aucun cas ne l'exige.
function pluralizeInsertLabel(label: string, count: number): string {
  return count > 1 ? `${label}s` : label;
}

// Nombre d'inserts par nature (`insert_kind`, db/schema.ts), dans l'ordre de première apparition —
// alimente la colonne Médias (ex. « 1 graphique, 2 images »).
function insertCountsByKind(inserts: InsertView[]): { kind: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const insert of inserts) {
    counts.set(insert.kind, (counts.get(insert.kind) ?? 0) + 1);
  }
  return [...counts.entries()].map(([kind, count]) => ({ kind, count }));
}

// La règle « jamais pré-vérifié » (brief) ne s'applique qu'aux beats qui portent un propos à
// sourcer — narration et réponse. Un B-roll ou une transition n'a légitimement aucune source.
function requiresSource(kind: string): boolean {
  return kind === "narration" || kind === "reponse";
}

export function BeatList({
  beats, variantId, speakers = [],
}: {
  beats: BeatView[];
  // Optionnel : le contrat du plan (brief Task 12) ne portait à l'origine que
  // `beats`/`targetDurationSec` — les tests instancient BeatList sans variantId. En usage réel
  // (app/(app)/video/[id]/page.tsx), variantId est toujours fourni : sans lui, reorderBeats n'a
  // pas de variante à cibler et le glisser-déposer reste visuel-seul (voir handleDrop ci-dessous).
  // `targetDurationSec` a été retiré (Task 4, SP 014 — UX pass) avec la bande DurationMeter : le
  // cumul/la cible vivent désormais dans le bandeau de projet (Task 3, project-header.tsx), qui
  // reçoit `targetDurationSec` directement de la variante.
  variantId?: string;
  // Task 5 (SP5) : la liste des intervenants du projet, pour le select « Locuteur » de
  // BeatInspector. Défaut `[]` — les tests existants (tests/video-beat-list.test.ts) instancient
  // BeatList sans cette prop, et un projet hors mode interview n'a de toute façon aucun intervenant.
  speakers?: { id: string; name: string }[];
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

  const selected = items.find((b) => b.id === selectedId) ?? null;
  // Les beats `question` de LA MÊME variante (`items`, pas `beats` — un réordonnancement en vol ne
  // doit pas désynchroniser les positions affichées dans le select « Répond à ») — voir
  // beat-inspector.tsx.
  const questionBeats = items
    .filter((b) => b.kind === "question")
    .map((b) => ({ id: b.id, position: b.position, spokenText: b.spokenText }));

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
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">#</TableHead>
            <TableHead>Beat</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Texte</TableHead>
            <TableHead className="text-right">Durée</TableHead>
            <TableHead>Médias</TableHead>
            <TableHead>Sources</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((beat, index) => {
            const breathRisk = isBreathRisk(beat.spokenText);
            const worstStatus = worstLinkStatus(beat.inserts);
            const sourceCount = beat.sources?.length ?? 0;
            const missingSource = requiresSource(beat.kind) && sourceCount === 0;
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
                <TableCell>
                  {beat.inserts.length === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <div className="flex items-center gap-2 text-sm">
                      <span>
                        {insertCountsByKind(beat.inserts).map(({ kind, count }, i) => (
                          <span key={kind}>
                            {i > 0 && ", "}
                            {count} {pluralizeInsertLabel((INSERT_KIND_LABEL[kind] ?? kind).toLowerCase(), count)}
                          </span>
                        ))}
                      </span>
                      {worstStatus && (
                        <span
                          className="inline-block size-1.5 shrink-0 rounded-full"
                          style={{ backgroundColor: LINK_STATUS_DOT_COLOR[worstStatus] }}
                          title={LINK_STATUS_LABEL[worstStatus] ?? worstStatus}
                          aria-label={LINK_STATUS_LABEL[worstStatus] ?? worstStatus}
                        />
                      )}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  {missingSource ? (
                    <Badge variant="destructive">0</Badge>
                  ) : (
                    <span className="tabular-nums text-sm">{sourceCount}</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {/* Légende des trois pastilles de statut de lien (colonne Médias) — même code couleur que
          le reste du module, jamais la couleur seule : voir aussi le `title`/`aria-label` posé sur
          chaque pastille ci-dessus. */}
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block size-1.5 rounded-full"
            style={{ backgroundColor: LINK_STATUS_DOT_COLOR.ok }}
            aria-hidden
          />
          {LINK_STATUS_LABEL.ok}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block size-1.5 rounded-full"
            style={{ backgroundColor: LINK_STATUS_DOT_COLOR.non_verifie }}
            aria-hidden
          />
          {LINK_STATUS_LABEL.non_verifie}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block size-1.5 rounded-full"
            style={{ backgroundColor: LINK_STATUS_DOT_COLOR.mort }}
            aria-hidden
          />
          {LINK_STATUS_LABEL.mort} / {LINK_STATUS_LABEL.interdit}
        </span>
      </p>

      <BeatInspector
        beat={selected}
        open={selected !== null}
        onOpenChange={(open) => { if (!open) setSelectedId(null); }}
        onSaved={handleSaved}
        speakers={speakers}
        questionBeats={questionBeats}
      />
    </div>
  );
}
