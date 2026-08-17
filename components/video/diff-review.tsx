"use client";
import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { KIND_LABEL } from "./beat-list";
import { defaultAccept } from "@/lib/video/import";
import type { BeatChange, BeatConflict, BeatSnapshot, Diff } from "@/lib/video/import";

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

// Rendu lisible d'un insert : un modèle en produit rarement tous les champs, donc seuls ceux
// réellement posés s'affichent — une ligne de sept « — » n'apprendrait rien à qui doit trancher.
function insertLine(ins: BeatSnapshot["inserts"][number]): string {
  const parts: string[] = [ins.type];
  if (ins.url) parts.push(ins.url);
  if (ins.tc_in || ins.tc_out) parts.push(`${ins.tc_in ?? "…"} → ${ins.tc_out ?? "…"}`);
  if (ins.duree_affichage_sec != null) parts.push(`${ins.duree_affichage_sec} s`);
  if (ins.credit) parts.push(`crédit : ${ins.credit}`);
  if (ins.droits) parts.push(`droits : ${ins.droits}`);
  return parts.join(" · ");
}

/**
 * Round de correction final (C1, aggravant) : la valeur d'UN champ contesté, sous une forme lisible.
 * Le côte-à-côte n'affichait que `spokenText` — un conflit sur `inserts`, `sources`, `screenText`,
 * `kind` ou une transition se présentait donc avec deux panneaux IDENTIQUES sous l'étiquette
 * « Champs en conflit : Inserts », et l'humain devait trancher sans voir ce qu'il tranchait.
 */
function FieldValue({ field, snapshot }: { field: string; snapshot: BeatSnapshot }) {
  if (field === "spokenText") return <SpokenTextPreview html={snapshot.spokenText} lines={4} />;

  if (field === "kind") {
    return <p className="text-sm">{KIND_LABEL[snapshot.kind] ?? snapshot.kind}</p>;
  }

  if (field === "sources") {
    if (snapshot.sources.length === 0) return <p className="text-sm text-muted-foreground">Aucune source</p>;
    return (
      <ul className="space-y-0.5">
        {snapshot.sources.map((s, i) => (
          <li key={`${s}-${i}`} className="truncate text-xs" title={s}>{s}</li>
        ))}
      </ul>
    );
  }

  if (field === "inserts") {
    if (snapshot.inserts.length === 0) return <p className="text-sm text-muted-foreground">Aucun insert</p>;
    return (
      <ul className="space-y-0.5">
        {snapshot.inserts.map((ins, i) => {
          const line = insertLine(ins);
          return <li key={`${ins.type}-${i}`} className="truncate text-xs" title={line}>{line}</li>;
        })}
      </ul>
    );
  }

  const value = (snapshot as unknown as Record<string, unknown>)[field];
  if (value == null || value === "") return <p className="text-sm text-muted-foreground">Vide</p>;
  return <p className="text-sm break-words">{String(value)}</p>;
}

// « Votre version » contre « Version de Claude », pour UN champ contesté.
function FieldComparison({ field, conflict }: { field: string; conflict: BeatConflict }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium">{FIELD_LABEL[field] ?? field}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-md border bg-muted/30 p-2" data-testid={`conflit-${conflict.externalId}-${field}-notre`}>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Votre version</p>
          <FieldValue field={field} snapshot={conflict.ours} />
        </div>
        <div className="rounded-md border bg-muted/30 p-2" data-testid={`conflit-${conflict.externalId}-${field}-claude`}>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Version de Claude</p>
          <FieldValue field={field} snapshot={conflict.theirs} />
        </div>
      </div>
    </div>
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
          {/* Un côte-à-côte par champ CONTESTÉ, et seulement pour eux : `conflict.fields` est aussi
              la liste exacte de ce qu'accepter le conflit appliquera (lib/video/import.ts#applyMerge,
              round de correction final C1). Ce que l'humain voit est donc précisément ce qu'il
              tranche — ni plus, ni moins. */}
          {conflict.fields.map((f) => (
            <FieldComparison key={f} field={f} conflict={conflict} />
          ))}
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

// La règle produit elle-même est dans lib/video/import.ts#defaultAccept (round de correction final,
// I1) : ce composant ne la RÉÉCRIT plus, il la consomme — le canal agent (lib/mcp/tools.ts) consomme
// la même, et un test verrouille l'accord des deux.
function defaultAccepted(diff: Diff): Set<string> {
  return new Set(defaultAccept(diff));
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
