import Link from "next/link";
import { Film } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/shell/empty-state";
import { PLATFORM_LABEL } from "@/lib/video/labels";

// Task 10 (écran de liste vidéo) — ligne minimale consommée par ProjectList ; produite par
// listVideoProjects (lib/queries/video.ts).
export type ProjectRow = {
  id: string;
  title: string;
  status: string;
  platforms: string[];
  estimatedSec: number;
  articleTitle: string | null;
  updatedAt: Date;
};

// Le statut est déjà un mot français en base (enum video_project_status) — seul le tiret bas est
// cosmétique, d'où ce simple remplacement plutôt qu'une table de correspondance dédiée.
function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

// `X min SS s` — la seconde est toujours affichée sur deux chiffres même sous la barre des dix,
// pour que la colonne ne « saute » pas visuellement d'une ligne à l'autre.
function formatDuration(totalSec: number): string {
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes} min ${String(seconds).padStart(2, "0")} s`;
}

// Server Component — table shadcn, sans état interne. L'état vide utilise l'EmptyState partagé du
// shell (components/shell/empty-state.tsx) plutôt qu'un texte ad hoc.
export function ProjectList({ projects }: { projects: ProjectRow[] }) {
  if (projects.length === 0) {
    return <EmptyState icon={<Film className="size-8 text-muted-foreground" aria-hidden />} title="Aucune vidéo pour l'instant" hint="Créez un premier projet pour démarrer un script." />;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Titre</TableHead>
          <TableHead>Statut</TableHead>
          <TableHead>Plateformes</TableHead>
          <TableHead>Durée</TableHead>
          <TableHead>Article source</TableHead>
          <TableHead>Mis à jour</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {projects.map((p) => (
          <TableRow key={p.id}>
            <TableCell className="font-medium">
              <Link href={`/video/${p.id}`} className="hover:underline">{p.title}</Link>
            </TableCell>
            <TableCell className="capitalize">{statusLabel(p.status)}</TableCell>
            <TableCell>{p.platforms.map((pl) => PLATFORM_LABEL[pl] ?? pl).join(", ")}</TableCell>
            <TableCell>{formatDuration(p.estimatedSec)}</TableCell>
            <TableCell className="text-muted-foreground">{p.articleTitle ?? "—"}</TableCell>
            <TableCell className="text-muted-foreground">{p.updatedAt.toLocaleDateString("fr-FR")}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
