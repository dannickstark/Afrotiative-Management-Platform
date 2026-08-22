"use client";
// Task 3 (SP 014 — UX pass) — bandeau de projet commun aux six onglets de /video/[id]. Remplace le
// PageHeader qui n'affichait que le titre : ce bandeau porte en plus le statut, le bouton
// d'avancement (déplacé depuis TournageView#StatusHeader — même server actions, même garde RBAC),
// la position dans le pipeline, le sélecteur de variante et les mêmes badges d'alerte que l'écran
// de liste (components/video/project-list.tsx, Task 2). "use client" pour porter ce bouton
// d'avancement (useTransition + router.refresh(), même patron que StatusHeader et VariantManager) —
// la page /video/[id] qui le rend reste, elle, un Server Component.
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { VideoStatusBadge } from "@/components/video/video-status-badge";
import { markReadyToShoot, startShooting, finishShooting } from "@/lib/actions/video-actions";
import { PLATFORM_LABEL, VIDEO_STATUS_LABEL } from "@/lib/video/labels";

// Les six étapes affichées en ligne 2 — le pipeline "normal" d'un projet, `archive` exclu : un
// projet archivé n'avance plus, il n'a pas sa place dans une frise de progression.
const PIPELINE_STATUSES = ["brouillon", "en_ecriture", "pret_a_tourner", "tourne", "en_montage", "publie"];

// Mêmes libellés / actions que l'ancien components/video/tournage-view.tsx#StatusHeader, retiré de
// ce fichier au profit de celui-ci (brief Task 3) : même mapping statut → bouton, mêmes server
// actions markReadyToShoot / startShooting / finishShooting (lib/actions/video-actions.ts).
type AdvanceAction = (projectId: string) => Promise<{ ok: true } | { ok: false; message: string }>;

const ADVANCE_BUTTON: Record<string, { label: string; action: AdvanceAction }> = {
  en_ecriture: { label: "Marquer prêt à tourner", action: markReadyToShoot },
  pret_a_tourner: { label: "Démarrer le tournage", action: startShooting },
  tourne: { label: "Tournage terminé", action: finishShooting },
};

// `m:ss` — même rendu que components/video/conducteur-view.tsx#fmt et project-list.tsx#fmt.
function fmt(totalSec: number): string {
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// Une durée de beat = `durationOverrideSec ?? estimatedDurationSec`, jamais recalculée côté client
// — même règle que components/video/beat-list.tsx#storedSeconds et lib/queries/video.ts.
function storedSeconds(beat: { durationOverrideSec: number | null; estimatedDurationSec: number }): number {
  return beat.durationOverrideSec ?? beat.estimatedDurationSec;
}

export type ProjectHeaderBeat = {
  durationOverrideSec: number | null;
  estimatedDurationSec: number;
  inserts: { linkStatus: string }[];
};

export type ProjectHeaderVariant = {
  id: string;
  platform: string;
  aspectRatio: string;
  targetDurationSec: number | null;
  beats: ProjectHeaderBeat[];
};

export type ProjectHeaderJournalEntry = { source: string; reviewedAt: string | null };

export type ProjectHeaderSpeaker = { id: string; name: string; consentGiven: boolean };

export function ProjectHeader({
  projectId, title, status, variants, activeVariantId, currentTab, journal, speakers, canManage,
}: {
  projectId: string;
  title: string;
  status: string;
  variants: ProjectHeaderVariant[];
  activeVariantId: string | null;
  currentTab: string;
  journal: ProjectHeaderJournalEntry[];
  speakers: ProjectHeaderSpeaker[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const activeVariant = variants.find((v) => v.id === activeVariantId) ?? variants[0] ?? null;
  const durationSec = activeVariant ? activeVariant.beats.reduce((sum, b) => sum + storedSeconds(b), 0) : 0;
  const beatCount = activeVariant ? activeVariant.beats.length : 0;
  const insertCount = activeVariant ? activeVariant.beats.reduce((sum, b) => sum + b.inserts.length, 0) : 0;

  // Badges d'alerte : mêmes libellés/variantes que components/video/project-list.tsx, mais comptés
  // sur TOUT le projet (toutes variantes confondues, comme listVideoProjects) — pas seulement la
  // variante active : un lien mort sur une variante que l'utilisateur ne regarde pas en ce moment
  // réclame quand même son attention.
  const deadLinkCount = variants.reduce(
    (sum, v) => sum + v.beats.reduce(
      (s, b) => s + b.inserts.filter((i) => i.linkStatus === "mort" || i.linkStatus === "interdit").length,
      0,
    ),
    0,
  );
  const unreviewedCount = journal.filter((j) => j.source === "mcp" && j.reviewedAt === null).length;
  const missingConsentSpeakers = speakers.filter((s) => !s.consentGiven);
  const missingConsentCount = missingConsentSpeakers.length;

  const advance = ADVANCE_BUTTON[status];

  function handleAdvance() {
    if (!advance) return;
    startTransition(async () => {
      const res = await advance.action(projectId);
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success("Statut mis à jour.");
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="space-y-3 rounded-xl p-4 ring-1 ring-foreground/10">
        {/* Ligne 1 : titre, pastille de statut, bouton d'avancement. */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-heading text-2xl font-semibold tracking-tight">{title}</h1>
            <VideoStatusBadge status={status} />
          </div>
          {canManage && advance && (
            <Button type="button" disabled={isPending} onClick={handleAdvance}>
              {isPending && <Loader2 className="animate-spin" aria-hidden />}
              {advance.label}
            </Button>
          )}
        </div>

        {/* Ligne 2 : les six étapes du pipeline — décoratif, pas de lien, pas de terracotta. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {PIPELINE_STATUSES.map((s, i) => (
            <span key={s} className="flex items-center gap-2">
              {i > 0 && <span className="text-muted-foreground" aria-hidden>→</span>}
              <span className={s === status ? "font-semibold text-foreground" : "text-muted-foreground"}>
                {VIDEO_STATUS_LABEL[s] ?? s}
              </span>
            </span>
          ))}
        </div>

        {/* Ligne 3 : sélecteur de variante, durée / cible, compteurs, badges d'alerte. */}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {variants.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {variants.map((v) => {
                const isActive = v.id === activeVariant?.id;
                return (
                  <a key={v.id} href={`/video/${projectId}?tab=${currentTab}&variant=${v.id}`}>
                    <Badge
                      variant={isActive ? "default" : "outline"}
                      className={isActive ? "active" : undefined}
                      aria-current={isActive ? "true" : undefined}
                    >
                      {PLATFORM_LABEL[v.platform] ?? v.platform} · {v.aspectRatio}
                    </Badge>
                  </a>
                );
              })}
            </div>
          )}
          {activeVariant && (
            <span className="text-muted-foreground">
              {fmt(durationSec)}{" "}
              <span>/ {activeVariant.targetDurationSec != null ? fmt(activeVariant.targetDurationSec) : "—"}</span>
              {" · "}{beatCount} beat{beatCount > 1 ? "s" : ""}
              {" · "}{insertCount} insert{insertCount > 1 ? "s" : ""}
            </span>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {unreviewedCount > 0 && (
              <Badge variant="outline" className="bg-[var(--status-pending)]/15 text-[var(--status-pending)] border-[var(--status-pending)]/30">
                {unreviewedCount} non relue{unreviewedCount > 1 ? "s" : ""}
              </Badge>
            )}
            {deadLinkCount > 0 && (
              <Badge variant="destructive">{deadLinkCount} lien(s) mort(s)</Badge>
            )}
            {missingConsentCount > 0 && (
              <Badge variant="destructive">{missingConsentCount} consentement(s)</Badge>
            )}
          </div>
        </div>
      </div>

      {/* Consentement manquant + projet tourné : la mise en montage sera refusée côté serveur
          (lib/video/persist.ts, RefusalError) — ce bandeau ne fait qu'annoncer le blocage avant que
          l'écriture ne le découvre en s'y heurtant. Une ligne par intervenant sans consentement,
          plutôt qu'une seule phrase agrégée : la formulation au singulier (« … n'a pas donné son
          consentement ») reste correcte quel que soit le nombre de personnes concernées. */}
      {status === "tourne" && missingConsentCount > 0 && (
        <div className="space-y-1.5">
          {missingConsentSpeakers.map((s) => (
            <p
              key={s.id}
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {s.name} n&apos;a pas donné son consentement — la mise en montage est bloquée.{" "}
              <a href={`/video/${projectId}?tab=intervenants`} className="underline">
                Voir les intervenants
              </a>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
