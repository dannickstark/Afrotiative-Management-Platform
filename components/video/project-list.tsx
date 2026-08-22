"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Film } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/shell/empty-state";
import { VideoStatusBadge } from "@/components/video/video-status-badge";
import { PLATFORM_LABEL, VIDEO_STATUS_LABEL } from "@/lib/video/labels";
import { PLATFORMS } from "@/lib/video/schema";

// Task 10 (écran de liste vidéo) — ligne minimale consommée par ProjectList ; produite par
// listVideoProjects (lib/queries/video.ts). Élargie Task 2 (SP 014 — UX pass) des trois champs
// « à traiter » (targetSec/deadLinkCount/missingConsentCount, cf. VideoProjectListRow) — même forme
// que le type de requête, recopiée ici plutôt qu'importée pour garder ce composant de rendu
// indépendant de la couche requête (patron d'origine, Task 10).
export type ProjectRow = {
  id: string;
  title: string;
  status: string;
  platforms: string[];
  estimatedSec: number;
  articleTitle: string | null;
  updatedAt: Date;
  // Task 8 — nombre d'écritures d'agent non relues (lib/video/persist.ts#markProjectReviewedCore).
  unreviewedCount: number;
  // Task 2 (SP 014) — alimente la colonne « Durée / cible » et la colonne « À traiter ».
  targetSec: number | null;
  deadLinkCount: number;
  missingConsentCount: number;
};

// `m:ss` — même rendu que components/video/conducteur-view.tsx#fmt (le conducteur affiche déjà les
// durées sous cette forme courte ; la liste utilisait jusqu'ici `formatDuration` en toutes lettres,
// devenu inutile une fois la colonne renommée « Durée / cible » — trop de largeur pour deux valeurs
// côte à côte).
function fmt(totalSec: number): string {
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function needsAction(p: ProjectRow): boolean {
  return p.unreviewedCount > 0 || p.deadLinkCount > 0 || p.missingConsentCount > 0;
}

// Composant de rendu pur — table shadcn, sans état de filtrage. Reçoit des lignes déjà filtrées par
// ProjectListFilters ci-dessous ; `filtered` distingue le vide "aucun projet du tout" (état initial,
// Task 10) du vide "aucun résultat pour ces filtres" (Task 2) sans dupliquer la logique de comptage.
export function ProjectList({ projects, filtered = false }: { projects: ProjectRow[]; filtered?: boolean }) {
  if (projects.length === 0) {
    return filtered ? (
      <EmptyState
        icon={<Film className="size-8 text-muted-foreground" aria-hidden />}
        title="Aucun résultat pour ces filtres"
        hint="Modifiez ou réinitialisez la recherche, le statut ou la plateforme."
      />
    ) : (
      <EmptyState
        icon={<Film className="size-8 text-muted-foreground" aria-hidden />}
        title="Aucune vidéo pour l'instant"
        hint="Créez un premier projet pour démarrer un script."
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Titre</TableHead>
          <TableHead>Statut</TableHead>
          <TableHead>Plateformes</TableHead>
          <TableHead>Durée / cible</TableHead>
          <TableHead>À traiter</TableHead>
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
            <TableCell><VideoStatusBadge status={p.status} /></TableCell>
            <TableCell>{p.platforms.map((pl) => PLATFORM_LABEL[pl] ?? pl).join(", ")}</TableCell>
            <TableCell>
              {fmt(p.estimatedSec)}{" "}
              <span className="text-muted-foreground">/ {p.targetSec != null ? fmt(p.targetSec) : "—"}</span>
            </TableCell>
            <TableCell>
              {needsAction(p) ? (
                <div className="flex flex-wrap items-center gap-2">
                  {/* Compteur « non relue » (brief Task 8) — déplacé Task 2 de la colonne Titre vers
                      cette colonne dédiée. Même vocabulaire/aspect que
                      components/settings/mcp/agent-activity.tsx (Task 7). */}
                  {p.unreviewedCount > 0 && (
                    <Badge variant="outline" className="bg-[var(--status-pending)]/15 text-[var(--status-pending)] border-[var(--status-pending)]/30">
                      {p.unreviewedCount} non relue{p.unreviewedCount > 1 ? "s" : ""}
                    </Badge>
                  )}
                  {/* "lien(s) mort(s)" sans accord conditionnel : même formulation littérale que
                      components/video/conducteur-view.tsx (bandeau de totaux du conducteur). */}
                  {p.deadLinkCount > 0 && (
                    <Badge variant="destructive">{p.deadLinkCount} lien(s) mort(s)</Badge>
                  )}
                  {p.missingConsentCount > 0 && (
                    <Badge variant="destructive">{p.missingConsentCount} consentement(s)</Badge>
                  )}
                </div>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell className="text-muted-foreground">{p.articleTitle ?? "—"}</TableCell>
            <TableCell className="text-muted-foreground">{p.updatedAt.toLocaleDateString("fr-FR")}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const STATUS_OPTIONS = Object.keys(VIDEO_STATUS_LABEL);

// Composant client — porte l'état de filtrage (recherche titre + statut + plateforme, tout côté
// client : la liste des projets vidéo reste de taille modeste, pas besoin d'aller-retour serveur
// comme components/published/published-table.tsx). `<select>` natif plutôt que le `<Select>`
// shadcn/Radix : même contrainte que components/video/beat-inspector.tsx — le second ne rend pas ses
// options sous `renderToStaticMarkup`, or tests/video-project-list.test.ts lit les libellés dans le
// HTML statique.
export function ProjectListFilters({ projects }: { projects: ProjectRow[] }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [platform, setPlatform] = useState("");

  const isFilterActive = search.trim() !== "" || status !== "" || platform !== "";

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects.filter((p) => {
      if (q !== "" && !p.title.toLowerCase().includes(q)) return false;
      if (status !== "" && p.status !== status) return false;
      if (platform !== "" && !p.platforms.includes(platform)) return false;
      return true;
    });
  }, [projects, search, status, platform]);

  const actionCount = useMemo(() => filtered.filter(needsAction).length, [filtered]);

  // Aucun projet du tout (pas un résultat de filtre) : garder l'état vide d'origine (Task 10) seul,
  // sans barre de filtres — rien à en filtrer, elle ne ferait qu'encombrer l'écran. Après les hooks
  // ci-dessus : un retour anticipé plus tôt violerait les règles des Hooks (nombre de hooks appelés
  // qui doit rester stable d'un rendu à l'autre).
  if (projects.length === 0) {
    return <ProjectList projects={[]} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1 space-y-1">
          <Label htmlFor="video-search">Recherche</Label>
          <Input
            id="video-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Titre du projet…"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="video-status-filter">Statut</Label>
          <select
            id="video-status-filter"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            <option value="">Tous les statuts</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{VIDEO_STATUS_LABEL[s]}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="video-platform-filter">Plateforme</Label>
          <select
            id="video-platform-filter"
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            <option value="">Toutes les plateformes</option>
            {PLATFORMS.map((pl) => (
              <option key={pl} value={pl}>{PLATFORM_LABEL[pl] ?? pl}</option>
            ))}
          </select>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        {filtered.length} projet{filtered.length > 1 ? "s" : ""} · {actionCount} demande{actionCount > 1 ? "nt" : ""} une action
      </p>
      <ProjectList projects={filtered} filtered={isFilterActive} />
    </div>
  );
}
