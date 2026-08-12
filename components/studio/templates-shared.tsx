"use client";
// components/studio/templates-shared.tsx — Chantier A, Tâche 5 (spec §4) : les helpers d'affichage
// et le menu d'actions PARTAGÉS entre les deux vues de /studio — templates-table.tsx (vue tableau,
// historique) et templates-gallery.tsx (vue grille, cette tâche). Extraits dans un TROISIÈME fichier
// plutôt que dans l'un des deux : templates-gallery.tsx a besoin de CES MÊMES helpers, et
// templates-table.tsx HÉBERGE désormais templates-gallery.tsx (la bascule grille/tableau vit dans
// templates-table.tsx — voir son commentaire) — si ces helpers restaient définis DANS
// templates-table.tsx, templates-gallery.tsx les importerait DEPUIS templates-table.tsx tout en
// étant lui-même importé PAR templates-table.tsx : un cycle d'imports entre les deux modules, dont
// l'ordre d'évaluation ESM n'est pas garanti (le module qui importe l'autre EN PREMIER peut recevoir
// des exports encore `undefined` selon l'ordre de résolution du bundler). Ce fichier casse le cycle :
// les deux vues importent DEPUIS ICI, jamais l'une depuis l'autre.
import { Archive, ArchiveRestore, Copy, MoreHorizontal, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RoleGate } from "@/components/role-gate";
import { FORMAT_PRESETS } from "@/lib/studio/formats";
import { TEMPLATE_CONTEXTS, type TemplateContext } from "@/lib/studio/tokens";
import type { TemplateRow } from "@/lib/queries/studio";

export const CONTEXT_LABEL: Record<TemplateContext, string> = {
  article_image: "Image à la une",
  social_post: "Publication sociale",
  quote_card: "Carte citation",
  newsletter_header: "Bandeau newsletter",
  recap_card: "Carte récap",
};

// État affiché : archivé prime sur tout, sinon brouillon (jamais publié) / publié à jour /
// modifications non publiées — exactement le triplet du §1 du design ("brouillon / publié /
// modifications non publiées"), l'archivage s'y ajoutant comme un quatrième état orthogonal.
export function StateBadge({ row }: { row: TemplateRow }) {
  if (row.archived) return <Badge variant="outline">Archivé</Badge>;
  if (row.publishedVersion === null) return <Badge variant="secondary">Brouillon</Badge>;
  if (row.hasUnpublishedChanges) return <Badge variant="secondary">Modifications non publiées</Badge>;
  return <Badge>Publié</Badge>;
}

export function formatLabel(row: TemplateRow): string {
  const preset = (FORMAT_PRESETS as Record<string, { label: string }>)[row.format];
  const label = preset?.label ?? row.format;
  return `${label} (${row.width}×${row.height})`;
}

export const dateFormatter = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });

// PURE — regroupe par contexte dans l'ordre canonique de TEMPLATE_CONTEXTS, en omettant tout groupe
// vide. C'est LA même règle de groupement que la vue tableau ET la vue grille doivent partager —
// spec §4 : « Grouped by context as today ». Une seconde implémentation, même triviale, pourrait un
// jour diverger silencieusement (ex. un nouvel ordre de TEMPLATE_CONTEXTS reflété dans une vue mais
// pas l'autre).
export function groupTemplatesByContext(
  templates: readonly TemplateRow[],
): { context: TemplateContext; rows: TemplateRow[] }[] {
  return TEMPLATE_CONTEXTS
    .map((context) => ({ context, rows: templates.filter((t) => t.context === context) }))
    .filter((g) => g.rows.length > 0);
}

// Menu par ligne/carte : dupliquer / renommer / archiver-désarchiver — les trois actions CRUD qui
// n'avaient, avant le correctif d'origine (templates-table.tsx, Correctif Critique 1), aucun point
// d'entrée écran. Gardé par RoleGate(template:manage — admin/éditeur, lib/rbac.ts) : défense en
// profondeur, comme components/queue/row-actions.tsx, même si le RBAC serveur (requirePermission
// dans lib/actions/studio-actions.ts) reste la vraie barrière — un journaliste qui appellerait
// l'action directement se heurterait de toute façon à un rejet, RoleGate n'évite ici que de lui
// montrer un bouton inutile. RÉUTILISÉ TEL QUEL par templates-gallery.tsx (spec §4 : « the same
// actions the table row has (the `Actions pour …` menu) ») — jamais une seconde implémentation.
export function TemplateRowMenu({
  row, isPending, onDuplicate, onArchiveToggle, onRequestRename,
}: {
  row: TemplateRow;
  isPending: boolean;
  onDuplicate: (row: TemplateRow) => void;
  onArchiveToggle: (row: TemplateRow) => void;
  onRequestRename: (row: TemplateRow) => void;
}) {
  return (
    <RoleGate allow={["admin", "editor"]}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label={`Actions pour ${row.name}`} data-action="row-menu" />}
        >
          <MoreHorizontal aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={isPending} onClick={() => onRequestRename(row)} data-action="rename">
            <Pencil aria-hidden />Renommer
          </DropdownMenuItem>
          <DropdownMenuItem disabled={isPending} onClick={() => onDuplicate(row)} data-action="duplicate">
            <Copy aria-hidden />Dupliquer
          </DropdownMenuItem>
          <DropdownMenuItem disabled={isPending} onClick={() => onArchiveToggle(row)} data-action="archive-toggle">
            {row.archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
            {row.archived ? "Désarchiver" : "Archiver"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </RoleGate>
  );
}
