import { Badge } from "@/components/ui/badge";
import { VIDEO_STATUS_LABEL } from "@/lib/video/labels";

// Task 2 (SP 014 — UX pass) — pastille de statut pour le module vidéo, sur le même patron que
// components/status-badge.tsx (l'équivalent article) : fond `/15` + texte plein + bordure `/30` des
// variables `--status-*` (DESIGN.md). On n'étend PAS status-badge.tsx : il est typé à `ArticleStatus`
// et le statut vidéo (enum `video_project_status`, db/schema.ts) a un vocabulaire différent
// (brouillon/en_ecriture/pret_a_tourner/tourne/en_montage/publie/archive). Correspondance visuelle
// demandée par le brief : brouillon → draft, en_ecriture → pending, pret_a_tourner/tourne/en_montage →
// in-review, publie → approved, archive → draft (un projet archivé reste visuellement neutre, pas
// "publié").
const STYLE: Record<string, string> = {
  brouillon: "bg-[var(--status-draft)]/15 text-[var(--status-draft)] border-[var(--status-draft)]/30",
  en_ecriture: "bg-[var(--status-pending)]/15 text-[var(--status-pending)] border-[var(--status-pending)]/30",
  pret_a_tourner: "bg-[var(--status-in-review)]/15 text-[var(--status-in-review)] border-[var(--status-in-review)]/30",
  tourne: "bg-[var(--status-in-review)]/15 text-[var(--status-in-review)] border-[var(--status-in-review)]/30",
  en_montage: "bg-[var(--status-in-review)]/15 text-[var(--status-in-review)] border-[var(--status-in-review)]/30",
  publie: "bg-[var(--status-approved)]/15 text-[var(--status-approved)] border-[var(--status-approved)]/30",
  archive: "bg-[var(--status-draft)]/15 text-[var(--status-draft)] border-[var(--status-draft)]/30",
};

// Props réduites à `status: string` (pas `VideoProjectRow` entier) : la Task 3 (en-tête de projet)
// réutilise ce composant depuis un contexte qui n'a pas forcément la même forme de ligne.
export function VideoStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={STYLE[status] ?? STYLE.brouillon}>
      {VIDEO_STATUS_LABEL[status] ?? status}
    </Badge>
  );
}
