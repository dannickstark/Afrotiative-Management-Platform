"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { prepareImport, applyImport } from "@/lib/actions/video-actions";
import { DiffReview } from "./diff-review";
import type { Diff, Issue } from "@/lib/video/import";

// Task 13 — chaque `Issue` (lib/video/import.ts) avec son chemin exact en police à chasse fixe, son
// message, et la valeur reçue quand elle existe : c'est ce qui rend un import refusé diagnosticable
// sans devoir relire le payload brut à la main (brief, contraintes globales du plan).
export function IssueList({ issues }: { issues: Issue[] }) {
  return (
    <ul className="space-y-2">
      {issues.map((issue, i) => (
        <li key={`${issue.path}-${i}`} className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">
          <p className="font-mono text-xs text-destructive">{issue.path || "(racine du payload)"}</p>
          <p>{issue.message}</p>
          {"received" in issue && issue.received !== undefined && (
            <p className="mt-1 text-xs text-muted-foreground">
              Valeur reçue : <span className="font-mono">{JSON.stringify(issue.received)}</span>
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

// Panneau Importer (troisième onglet, app/(app)/video/[id]/page.tsx) — zone de collage + dépôt de
// fichier `.json`, appel de `prepareImport`, puis IssueList (rejet) OU DiffReview (diff calculé).
// `variantUpdatedAt` : capturé au chargement de la page (l'état serveur au moment où l'utilisateur
// a ouvert l'onglet), transmis tel quel à `applyImport` — c'est ce qui permet au garde de
// péremption du serveur (lib/video/persist.ts#applyImportCore) de détecter une édition faite entre
// la préparation du diff et son application, plutôt que de faire confiance à l'affichage client.
export function ImportPanel({
  projectId, variantId, variantUpdatedAt,
}: {
  projectId: string;
  variantId: string;
  variantUpdatedAt: string;
}) {
  const router = useRouter();
  const [raw, setRaw] = useState("");
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [prepared, setPrepared] = useState<{ journalId: string; diff: Diff } | null>(null);
  const [isPending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);

  function loadFile(file: File) {
    file.text().then((text) => setRaw(text)).catch(() => toast.error("Impossible de lire ce fichier."));
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) loadFile(file);
  }

  function handleAnalyze() {
    if (!raw.trim()) {
      toast.error("Collez ou déposez d'abord la réponse JSON du chat.");
      return;
    }
    startTransition(async () => {
      const res = await prepareImport({ projectId, variantId, raw, source: "copier_coller" });
      if (!res.ok) {
        setIssues(res.issues);
        setPrepared(null);
        return;
      }
      setIssues(null);
      setPrepared({ journalId: res.journalId, diff: res.diff });
    });
  }

  function handleApply(accept: string[]) {
    if (!prepared) return;
    startTransition(async () => {
      const res = await applyImport({
        journalId: prepared.journalId, variantId, accept, variantUpdatedAt,
      });
      if (!res.ok) {
        // Le message du serveur (RefusalError, lib/video/persist.ts) est affiché tel quel — en
        // particulier « L'aperçu est périmé — recalculez le diff avant d'appliquer. », le garde qui
        // protège une édition faite entre la préparation et l'application. Ne pas l'avaler dans un
        // texte générique (contrainte du brief Task 13).
        toast.error(res.message);
        return;
      }
      toast.success(`${res.applied} beat${res.applied > 1 ? "s" : ""} mis à jour.`);
      setPrepared(null);
      setIssues(null);
      setRaw("");
      // Les beats appliqués vivent dans l'onglet Écriture (autre partie de l'arbre serveur) : seul
      // un nouveau rendu serveur les fait apparaître là-bas sans rechargement manuel de page.
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        className="space-y-2"
      >
        <Textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="Collez ici la réponse JSON du chat, ou déposez un fichier .json…"
          rows={12}
          className="font-mono text-xs"
          aria-label="Réponse JSON à importer"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) loadFile(file);
              e.target.value = "";
            }}
          />
          <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()}>
            <UploadCloud aria-hidden />
            Déposer un fichier .json
          </Button>
          <Button type="button" onClick={handleAnalyze} disabled={isPending}>
            {isPending && <Loader2 className="animate-spin" aria-hidden />}
            Analyser
          </Button>
        </div>
      </div>

      {issues && issues.length > 0 && <IssueList issues={issues} />}
      {prepared && <DiffReview diff={prepared.diff} onApply={handleApply} />}
    </div>
  );
}
