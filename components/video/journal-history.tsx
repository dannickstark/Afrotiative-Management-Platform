"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { IssueList } from "./import-panel";
import { revertJournalEntry } from "@/lib/actions/video-actions";
import type { Issue } from "@/lib/video/import";

const SOURCE_LABEL: Record<string, string> = {
  copier_coller: "Copier-coller",
  mcp: "MCP",
  manuel: "Manuel",
};

const OUTCOME_LABEL: Record<string, string> = {
  rejete: "Rejeté",
  en_attente: "En attente",
  applique: "Appliqué",
  annule: "Annulé",
};

const OUTCOME_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  rejete: "destructive",
  en_attente: "outline",
  applique: "secondary",
  annule: "outline",
};

// Task 13 — la forme consommée par ce composant, tirée de `project.journal`
// (lib/queries/video.ts#getVideoProject, colonnes de db/schema.ts#scriptJournal). `rawPayload` reste
// `unknown` : le journal le stocke BRUT, avant toute normalisation (voir son commentaire en base) —
// c'est la seule façon de comprendre après coup ce que le modèle avait réellement produit.
export type JournalEntryView = {
  id: string;
  createdAt: string;
  source: string;
  outcome: string;
  errorReport: Issue[];
  rawPayload: unknown;
  revertedAt: string | null;
  // Task 8 — `null` tant qu'aucun humain n'a ouvert le projet depuis cette écriture d'agent. Seules
  // les entrées `source: "mcp"` en portent une signification : le marquage
  // (lib/video/persist.ts#markProjectReviewedCore) ne touche jamais les entrées "copier_coller" ou
  // "manuel", posées par un humain qui n'a rien à relire.
  reviewedAt: string | null;
};

function JournalRow({ entry }: { entry: JournalEntryView }) {
  const router = useRouter();
  const [showRaw, setShowRaw] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleRevert() {
    startTransition(async () => {
      const res = await revertJournalEntry({ journalId: entry.id });
      if (!res.ok) {
        // Le message du serveur est affiché TEL QUEL — revertJournalEntryCore
        // (lib/video/persist.ts) refuse pour plusieurs raisons distinctes (entrée trop ancienne pour
        // porter l'état d'avant, import postérieur touchant les mêmes beats, édition manuelle
        // postérieure) et chacune se lit différemment ; les avaler dans un texte générique cacherait
        // laquelle s'applique (contrainte du brief Task 13).
        toast.error(res.message);
        return;
      }
      toast.success("Import annulé — état précédent restauré.");
      // router.refresh() plutôt qu'une mise à jour optimiste locale : l'annulation touche des beats
      // affichés dans l'onglet Écriture (autre partie de l'arbre serveur), pas seulement cette ligne
      // de journal — seul un nouveau rendu serveur les remet en cohérence.
      router.refresh();
    });
  }

  const canRevert = entry.outcome === "applique" && !entry.revertedAt;

  return (
    <li className="space-y-2 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">{new Date(entry.createdAt).toLocaleString("fr-FR")}</span>
          <Badge variant="outline">{SOURCE_LABEL[entry.source] ?? entry.source}</Badge>
          <Badge variant={OUTCOME_VARIANT[entry.outcome] ?? "outline"}>{OUTCOME_LABEL[entry.outcome] ?? entry.outcome}</Badge>
          {/* Même vocabulaire/aspect que components/settings/mcp/agent-activity.tsx (Task 7) —
              une seule façon de dire « non relue » dans toute l'app, pas une seconde inventée ici. */}
          {entry.source === "mcp" && entry.reviewedAt === null && (
            <Badge variant="outline" className="bg-[var(--status-pending)]/15 text-[var(--status-pending)] border-[var(--status-pending)]/30">
              Non relue
            </Badge>
          )}
        </div>
        {canRevert && (
          <Button type="button" variant="outline" size="sm" onClick={handleRevert} disabled={isPending}>
            {isPending && <Loader2 className="animate-spin" aria-hidden />}
            Annuler
          </Button>
        )}
      </div>

      {entry.errorReport.length > 0 && <IssueList issues={entry.errorReport} />}

      <button
        type="button"
        onClick={() => setShowRaw((v) => !v)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {showRaw ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
        Payload brut
      </button>
      {/* Accès au payload BRUT (contrainte du brief) : c'est ce qui rend un import diagnosticable
          après coup, y compris pour une entrée « applique » ou « annule » longtemps après le fait. */}
      {showRaw && (
        <pre className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-xs">
          {JSON.stringify(entry.rawPayload, null, 2)}
        </pre>
      )}
    </li>
  );
}

// Task 13 — historique du journal d'import (script_journal, lib/queries/video.ts#getVideoProject) :
// date, source, issues éventuelles, et pour chaque entrée « applique » non encore annulée, un
// bouton « Annuler » qui appelle revertJournalEntry.
export function JournalHistory({ entries }: { entries: JournalEntryView[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">Aucun import pour ce projet.</p>;
  }

  return (
    <ul className="space-y-2">
      {entries.map((entry) => (
        <JournalRow key={entry.id} entry={entry} />
      ))}
    </ul>
  );
}
