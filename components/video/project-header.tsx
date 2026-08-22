"use client";
// Task 3 (SP 014 — UX pass) — bandeau de projet commun aux six onglets de /video/[id]. Remplace le
// PageHeader qui n'affichait que le titre : ce bandeau porte en plus le statut, le bouton
// d'avancement (déplacé depuis TournageView#StatusHeader — même server actions, même garde RBAC),
// la position dans le pipeline, le sélecteur de variante et les mêmes badges d'alerte que l'écran
// de liste (components/video/project-list.tsx, Task 2). "use client" pour porter ce bouton
// d'avancement (useTransition + router.refresh(), même patron que StatusHeader et VariantManager) —
// la page /video/[id] qui le rend reste, elle, un Server Component.
import { useTransition } from "react";
import Link from "next/link";
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
  projectId, title, subject, status, variants, activeVariantId, currentTab, journal, speakers, canManage,
}: {
  projectId: string;
  title: string;
  // « Sujet / angle », saisi à la création (components/video/new-project-dialog.tsx) — c'était la
  // description du PageHeader remplacé par ce bandeau ; il se relit ici sous le titre.
  subject: string | null;
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
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-heading text-2xl font-semibold tracking-tight">{title}</h1>
              <VideoStatusBadge status={status} />
            </div>
            {subject && <p className="text-sm text-muted-foreground">{subject}</p>}
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
                  // <Link> et non <a> : un changement de variante est une navigation interne, elle
                  // doit garder l'état client des onglets (filtres/dépliage du Journal, Task 6) —
                  // même choix que components/video/project-list.tsx.
                  <Link key={v.id} href={`/video/${projectId}?tab=${currentTab}&variant=${v.id}`}>
                    {/* La variante active est un ÉTAT DE SÉLECTION, pas une action primaire : pas de
                        terracotta pleine (DESIGN.md, règle « Actions Only »). Secondary + anneau,
                        et `aria-current` porte l'information pour les lecteurs d'écran. */}
                    <Badge
                      variant={isActive ? "secondary" : "outline"}
                      className={isActive ? "ring-1 ring-foreground/25" : undefined}
                      aria-current={isActive ? "true" : undefined}
                    >
                      {PLATFORM_LABEL[v.platform] ?? v.platform} · {v.aspectRatio}
                    </Badge>
                  </Link>
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
              // « sur le projet » : ce compte couvre TOUTES les variantes, alors que la ligne de
              // totaux du conducteur (components/video/conducteur-view.tsx), rendue quelques pixels
              // plus bas dans l'onglet Montage, compte les liens morts de la SEULE variante active.
              // Sans cette précision, deux nombres différents portaient le même libellé.
              <Badge variant="destructive">{deadLinkCount} lien(s) mort(s) sur le projet</Badge>
            )}
            {missingConsentCount > 0 && (
              <Badge variant="destructive">{missingConsentCount} consentement(s)</Badge>
            )}
          </div>
        </div>
      </div>

      {/* Consentement manquant + projet tourné : la mise en montage sera refusée côté serveur
          (lib/video/persist.ts, RefusalError) — ce bandeau ne fait qu'annoncer le blocage avant que
          l'écriture ne le découvre en s'y heurtant. UNE seule région `role="alert"` qui énumère les
          intervenants concernés : une alerte par personne faisait annoncer quatre fois la même
          chose par les lecteurs d'écran, et répétait quatre fois le même lien (revue finale, F7).
          components/video/speakers-manager.tsx énonce déjà le même fait en une phrase. */}
      {status === "tourne" && missingConsentCount > 0 && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {missingConsentSpeakers.map((s) => s.name).join(", ")}{" "}
          {missingConsentCount > 1 ? "n'ont pas donné leur consentement" : "n'a pas donné son consentement"}
          {" — la mise en montage est bloquée."}{" "}
          <Link href={`/video/${projectId}?tab=intervenants`} className="underline">
            Voir les intervenants
          </Link>
        </p>
      )}
    </div>
  );
}
