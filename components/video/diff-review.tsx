"use client";
import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { KIND_LABEL } from "./beat-list";
import type { BeatChange, BeatConflict, Diff } from "@/lib/video/import";

// Task 13 — libellés français des champs fusionnés (lib/video/import.ts#MERGE_FIELDS), affichés
// pour dire QUOI a changé sans obliger l'utilisateur à connaître les noms internes.
const FIELD_LABEL: Record<string, string> = {
  kind: "Type",
  spokenText: "Texte",
  directionNote: "Note de réalisation",
  screenText: "Texte à l'écran",
  transitionIn: "Transition d'entrée",
  transitionOut: "Transition de sortie",
  sources: "Sources",
  inserts: "Inserts",
};

function fieldsText(fields: string[]): string {
  return fields.map((f) => FIELD_LABEL[f] ?? f).join(", ");
}

// spokenText arrive déjà assaini : sanitizeIncomingBeats (lib/video/persist.ts) l'assainit AVANT
// computeMerge, donc `next`/`ours`/`theirs` en portent tous une version sûre — même motif que
// BeatList (components/video/beat-list.tsx) pour dangerouslySetInnerHTML.
function SpokenTextPreview({ html, lines = 3 }: { html: string; lines?: number }) {
  return (
    <div
      className={lines === 3 ? "line-clamp-3 text-sm [&_p]:inline" : "line-clamp-4 text-sm [&_p]:inline"}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function ChangeRow({
  change, accepted, onToggle,
}: {
  change: BeatChange;
  accepted: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="flex items-start gap-3 rounded-md border p-3">
      <Checkbox
        data-testid={`accept-${change.externalId}`}
        checked={accepted}
        onCheckedChange={onToggle}
        aria-label={`Retenir ${change.externalId}`}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">{change.externalId}</span>
          <Badge variant="outline">{KIND_LABEL[change.next.kind] ?? change.next.kind}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">Champs modifiés : {fieldsText(change.fields)}</p>
        {change.next.spokenText && <SpokenTextPreview html={change.next.spokenText} />}
      </div>
    </li>
  );
}

// Un conflit s'affiche côte à côte (spec §5.3, brief Task 13) : « Votre version » (l'état actuel en
// base, édité par l'humain) contre « Version de Claude » (ce que le nouveau payload propose) — le
// choix ne se tranche jamais tout seul, d'où la case décochée par défaut.
function ConflictRow({
  conflict, accepted, onToggle,
}: {
  conflict: BeatConflict;
  accepted: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
      <div className="flex items-start gap-3">
        <Checkbox
          data-testid={`accept-${conflict.externalId}`}
          checked={accepted}
          onCheckedChange={onToggle}
          aria-label={`Retenir la version de Claude pour ${conflict.externalId}`}
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <TriangleAlert className="size-4 text-amber-600" aria-hidden />
            <span className="font-mono text-xs text-muted-foreground">{conflict.externalId}</span>
            <span className="text-xs text-muted-foreground">Champs en conflit : {fieldsText(conflict.fields)}</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-md border bg-muted/30 p-2">
              <p className="mb-1 text-xs font-medium text-muted-foreground">Votre version</p>
              <SpokenTextPreview html={conflict.ours.spokenText} lines={4} />
            </div>
            <div className="rounded-md border bg-muted/30 p-2">
              <p className="mb-1 text-xs font-medium text-muted-foreground">Version de Claude</p>
              <SpokenTextPreview html={conflict.theirs.spokenText} lines={4} />
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}

function RemovedRow({
  externalId, accepted, onToggle,
}: {
  externalId: string;
  accepted: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="flex items-center gap-3 rounded-md border p-3">
      <Checkbox
        data-testid={`accept-${externalId}`}
        checked={accepted}
        onCheckedChange={onToggle}
        aria-label={`Supprimer ${externalId}`}
      />
      <span className="font-mono text-xs text-muted-foreground">{externalId}</span>
      <Badge variant="destructive">Suppression proposée</Badge>
    </li>
  );
}

function defaultAccepted(diff: Diff): Set<string> {
  return new Set([...diff.added, ...diff.modified].map((c) => c.externalId));
}

// Task 13 — revue du diff calculé par computeMerge (lib/video/import.ts). Règle produit imposée
// (spec §5.3) : ajouts et modifications cochés par défaut (un modèle qui abrège sa réponse ne doit
// pas pouvoir effacer un beat par omission), suppressions et conflits décochés par défaut (un
// conflit ne se tranche jamais tout seul). `onApply` reçoit la liste des externalId retenus —
// l'appelant (ImportPanel) construit la requête `applyImport` à partir de cette sélection.
export function DiffReview({ diff, onApply }: { diff: Diff; onApply: (accept: string[]) => void }) {
  const [accepted, setAccepted] = useState<Set<string>>(() => defaultAccepted(diff));

  // Round de correction 1 (C1) : ImportPanel remplace `prepared` (donc `diff`) sans démonter
  // DiffReview — même composant, même position, React CONSERVE `accepted` entre deux analyses
  // réussies (coller, échouer, corriger, ré-analyser passe par ce chemin exact). Sans cet effet, un
  // externalId coché parce qu'il était un AJOUT dans le premier diff resterait coché s'il devient
  // une SUPPRESSION ou un CONFLIT dans le second — exactement ce que la règle produit interdit.
  // Se déclenche aussi au premier rendu (même valeur que l'initialisation paresseuse ci-dessus,
  // sans effet observable) plutôt que de dépendre d'un montage/démontage que l'appelant ne fait pas.
  useEffect(() => {
    setAccepted(defaultAccepted(diff));
  }, [diff]);

  function toggle(id: string) {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const rien = diff.added.length === 0 && diff.modified.length === 0
    && diff.conflicts.length === 0 && diff.removed.length === 0;

  if (rien) {
    return <p className="text-sm text-muted-foreground">Aucune différence avec l&apos;état actuel — rien à appliquer.</p>;
  }

  return (
    <div className="space-y-6">
      {diff.added.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Ajouts ({diff.added.length})</h3>
          <ul className="space-y-2">
            {diff.added.map((c) => (
              <ChangeRow key={c.externalId} change={c} accepted={accepted.has(c.externalId)} onToggle={() => toggle(c.externalId)} />
            ))}
          </ul>
        </section>
      )}
      {diff.modified.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Modifications ({diff.modified.length})</h3>
          <ul className="space-y-2">
            {diff.modified.map((c) => (
              <ChangeRow key={c.externalId} change={c} accepted={accepted.has(c.externalId)} onToggle={() => toggle(c.externalId)} />
            ))}
          </ul>
        </section>
      )}
      {diff.conflicts.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Conflits ({diff.conflicts.length})</h3>
          <p className="text-xs text-muted-foreground">
            Un même champ a été touché à la fois par vous et par Claude depuis le dernier import.
            Cochez pour retenir la version de Claude ; laissez décoché pour garder la vôtre.
          </p>
          <ul className="space-y-2">
            {diff.conflicts.map((c) => (
              <ConflictRow key={c.externalId} conflict={c} accepted={accepted.has(c.externalId)} onToggle={() => toggle(c.externalId)} />
            ))}
          </ul>
        </section>
      )}
      {diff.removed.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Suppressions proposées ({diff.removed.length})</h3>
          <p className="text-xs text-muted-foreground">
            Ces beats n&apos;apparaissent plus dans le payload. Cochez pour les supprimer ;
            laissé décoché, le beat est conservé.
          </p>
          <ul className="space-y-2">
            {diff.removed.map((r) => (
              <RemovedRow key={r.externalId} externalId={r.externalId} accepted={accepted.has(r.externalId)} onToggle={() => toggle(r.externalId)} />
            ))}
          </ul>
        </section>
      )}
      <div className="flex justify-end border-t pt-4">
        <Button type="button" data-testid="apply" onClick={() => onApply([...accepted])}>
          Appliquer
        </Button>
      </div>
    </div>
  );
}
