"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Archive, ArchiveRestore, Copy, Loader2, MoreHorizontal, Pencil, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RoleGate } from "@/components/role-gate";
// Imports directs (PAS le barrel @/lib/studio) : ce barrel tire @/db (le pool `pg`) dans le graphe
// de ce module (voir lib/studio/index.ts, qui importe { db } depuis "@/db"). Ce fichier est
// désormais un Client Component (Correctif Critique 1 de la revue finale — création, duplication,
// renommage, archivage) : c'était exactement le risque que ces imports directs anticipaient
// (lib/studio/default-category-color.ts documente la même convention). Même remarque pour
// FORMAT_KEYS, CHANNELS et les actions ci-dessous : tout vient de modules feuilles, jamais du
// barrel.
import { FORMAT_PRESETS, FORMAT_KEYS, type FormatKey } from "@/lib/studio/formats";
import { TEMPLATE_CONTEXTS, CHANNELS, type TemplateContext, type Channel } from "@/lib/studio/tokens";
import type { TemplateRow, CategoryOption } from "@/lib/queries/studio";
import { createTemplate, duplicateTemplate, archiveTemplate, renameTemplate } from "@/lib/actions/studio-actions";

const CONTEXT_LABEL: Record<TemplateContext, string> = {
  article_image: "Image à la une",
  social_post: "Publication sociale",
  quote_card: "Carte citation",
  newsletter_header: "Bandeau newsletter",
  recap_card: "Carte récap",
};

const CHANNEL_LABEL: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
  x: "X",
  tiktok: "TikTok",
};

// Portée affichée : canal, catégorie, les deux, ou « Défaut » si ni l'un ni l'autre — c'est
// littéralement le gabarit appliqué à tout le contexte, sans restriction. Un canal inconnu de
// CHANNEL_LABEL (ex. une valeur "test-*" injectée par une suite de tests) s'affiche tel quel :
// render_templates.channel est du texte libre en base (db/schema.ts), pas un enum.
function scopeLabel(row: TemplateRow): string {
  const channel = row.channel ? (CHANNEL_LABEL[row.channel] ?? row.channel) : null;
  const parts = [channel, row.categoryName].filter((v): v is string => Boolean(v));
  return parts.length > 0 ? parts.join(" · ") : "Défaut";
}

// État affiché : archivé prime sur tout, sinon brouillon (jamais publié) / publié à jour /
// modifications non publiées — exactement le triplet du §1 du design ("brouillon / publié /
// modifications non publiées"), l'archivage s'y ajoutant comme un quatrième état orthogonal.
function StateBadge({ row }: { row: TemplateRow }) {
  if (row.archived) return <Badge variant="outline">Archivé</Badge>;
  if (row.publishedVersion === null) return <Badge variant="secondary">Brouillon</Badge>;
  if (row.hasUnpublishedChanges) return <Badge variant="secondary">Modifications non publiées</Badge>;
  return <Badge>Publié</Badge>;
}

function formatPresetLabel(key: FormatKey): string {
  const preset = FORMAT_PRESETS[key];
  return `${preset.label} (${preset.width}×${preset.height})`;
}

function formatLabel(row: TemplateRow): string {
  const preset = (FORMAT_PRESETS as Record<string, { label: string }>)[row.format];
  const label = preset?.label ?? row.format;
  return `${label} (${row.width}×${row.height})`;
}

const dateFormatter = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });

const NO_CHANNEL = "__aucun__";
const NO_CATEGORY = "__aucune__";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers PURS, exportés pour rester testables SANS simuler de clic sur un élément rendu côté
// serveur — bun:test n'a pas de DOM (voir la remarque équivalente dans
// tests/studio-manual.test.ts). tests/studio-templates-table.test.ts les compose avec les VRAIES
// actions (createTemplate/archiveTemplate, session RBAC mockée — même recette que
// tests/studio-template-actions.test.ts) pour prouver, contrat par contrat : que la soumission du
// dialogue appelle bien createTemplate avec le format et la portée choisis (buildCreateTemplateInput
// est l'identité EXACTE utilisée par handleSubmit ci-dessous, pas une copie qui pourrait diverger) ;
// et que le bouton archiver/désarchiver envoie bien l'INVERSE de l'état courant, jamais une valeur
// figée.
export function buildCreateTemplateInput(form: {
  name: string;
  context: TemplateContext;
  // string, PAS Channel : createTemplateCore (lib/studio/template-core.ts) accepte du texte libre
  // pour la même raison que render_templates.channel est une colonne text() sans contrainte — le
  // <Select> du dialogue, lui, ne propose que CHANNELS (Channel est assignable à string), mais
  // tests/studio-templates-table.test.ts compose ce helper avec des canaux synthétiques "test-*"
  // (tests/studio-fixtures.ts, règle 3) qu'un typage Channel refuserait à la compilation.
  channel: string | null;
  categoryId: string | null;
  format: FormatKey;
}) {
  return {
    name: form.name, context: form.context, channel: form.channel,
    categoryId: form.categoryId, format: form.format,
  };
}

export function nextArchivedState(row: Pick<TemplateRow, "archived">): boolean {
  return !row.archived;
}

// ─────────────────────────────────────────────────────────────────────────────
// Correctif Critique 1 (revue finale V2) : /studio n'avait AUCUNE UI de création — six des sept
// actions CRUD de gabarit (créer, dupliquer, archiver, renommer) n'avaient aucun appelant hors de
// leurs propres tests. Ce dialogue est la SEULE surface où contexte/canal/catégorie/format se
// choisissent : createTemplateCore fige largeur/hauteur depuis FORMAT_PRESETS[format] à la
// création (lib/studio/template-core.ts) et l'éditeur n'expose aucun de ces quatre champs — sans ce
// dialogue, la portée « un gabarit par canal, la couleur venant de la taxonomie » (spec §Objectif)
// est structurellement inatteignable.
function CreateTemplateDialog({ categories }: { categories: CategoryOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [context, setContext] = useState<TemplateContext>(TEMPLATE_CONTEXTS[0]);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [format, setFormat] = useState<FormatKey>(FORMAT_KEYS[0]);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function reset() {
    setName("");
    setContext(TEMPLATE_CONTEXTS[0]);
    setChannel(null);
    setCategoryId(null);
    setFormat(FORMAT_KEYS[0]);
    setError(null);
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) reset();
  }

  function handleSubmit() {
    setError(null);
    startTransition(async () => {
      const res = await createTemplate(buildCreateTemplateInput({ name, context, channel, categoryId, format }));
      if (!res.ok) {
        // Le conflit de portée (spec §8 : « message nommant le gabarit existant ») remonte tel
        // quel — c'est le message français exact que la revue a demandé de surfacer plutôt que
        // d'avaler.
        setError(res.message);
        toast.error(res.message);
        return;
      }
      toast.success(`Gabarit « ${name.trim()} » créé.`);
      handleOpenChange(false);
      // Enchaîne directement sur l'éditeur : créer un gabarit sans y accéder ensuite laisserait
      // l'utilisateur devant la même liste, sans indication de ce qui vient de se passer.
      router.push(`/studio/${res.id}`);
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button data-action="create-template"><Plus aria-hidden />Nouveau gabarit</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nouveau gabarit</DialogTitle>
          <DialogDescription>
            Le format choisi fige la largeur et la hauteur du gabarit — il ne pourra plus être
            modifié une fois créé.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="template-name">Nom</Label>
            <Input
              id="template-name" value={name} disabled={isPending}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex. Carte citation — Facebook"
              data-testid="template-name-input"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Contexte</Label>
            <Select value={context} onValueChange={(v) => v && setContext(v as TemplateContext)} disabled={isPending}>
              <SelectTrigger className="w-full" data-action="create-context-select">
                <SelectValue placeholder="Choisir…">
                  {(v: string | null) => CONTEXT_LABEL[(v ?? context) as TemplateContext]}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {TEMPLATE_CONTEXTS.map((c) => <SelectItem key={c} value={c}>{CONTEXT_LABEL[c]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Canal (optionnel)</Label>
              <Select
                value={channel ?? NO_CHANNEL}
                onValueChange={(v) => setChannel(v && v !== NO_CHANNEL ? (v as Channel) : null)}
                disabled={isPending}
              >
                <SelectTrigger className="w-full" data-action="create-channel-select">
                  <SelectValue placeholder="Aucun">
                    {(v: string | null) => (v && v !== NO_CHANNEL ? CHANNEL_LABEL[v] : "Aucun")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CHANNEL}>Aucun</SelectItem>
                  {CHANNELS.map((c) => <SelectItem key={c} value={c}>{CHANNEL_LABEL[c]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Catégorie (optionnelle)</Label>
              <Select
                value={categoryId ?? NO_CATEGORY}
                onValueChange={(v) => setCategoryId(v && v !== NO_CATEGORY ? v : null)}
                disabled={isPending}
              >
                <SelectTrigger className="w-full" data-action="create-category-select">
                  <SelectValue placeholder="Aucune">
                    {(v: string | null) => (v && v !== NO_CATEGORY ? (categories.find((c) => c.id === v)?.name ?? v) : "Aucune")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CATEGORY}>Aucune</SelectItem>
                  {categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Format</Label>
            <Select value={format} onValueChange={(v) => v && setFormat(v as FormatKey)} disabled={isPending}>
              <SelectTrigger className="w-full" data-action="create-format-select">
                <SelectValue placeholder="Choisir…">
                  {(v: string | null) => formatPresetLabel((v ?? format) as FormatKey)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {FORMAT_KEYS.map((k) => <SelectItem key={k} value={k}>{formatPresetLabel(k)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {error && <p className="text-sm text-destructive" role="alert" data-testid="create-template-error">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={isPending}>Annuler</Button>
          <Button onClick={handleSubmit} disabled={isPending || !name.trim()} data-action="submit-create-template">
            {isPending && <Loader2 className="animate-spin" aria-hidden />}
            {isPending ? "Création…" : "Créer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Formulaire de renommage, remonté à chaque changement de cible (`key={target.id}` posé par
// RenameTemplateDialog ci-dessous) — même motif que CardContent `key={context}` dans
// components/studio/manual-generate.tsx : sans lui, l'état local `name` resterait celui de la
// PREMIÈRE ligne ouverte, jamais réinitialisé pour la suivante.
function RenameTemplateForm({
  target, onOpenChange, onRenamed,
}: { target: TemplateRow; onOpenChange: (open: boolean) => void; onRenamed: () => void }) {
  const [name, setName] = useState(target.name);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit() {
    setError(null);
    startTransition(async () => {
      const res = await renameTemplate(target.id, name);
      if (!res.ok) {
        setError(res.message);
        toast.error(res.message);
        return;
      }
      toast.success("Gabarit renommé.");
      onOpenChange(false);
      onRenamed();
    });
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Renommer « {target.name} »</DialogTitle>
      </DialogHeader>
      <div className="space-y-1.5">
        <Label htmlFor="rename-template-input">Nom</Label>
        <Input
          id="rename-template-input" value={name} disabled={isPending}
          onChange={(e) => setName(e.target.value)}
          data-testid="rename-template-input"
        />
        {error && <p className="text-sm text-destructive" role="alert" data-testid="rename-template-error">{error}</p>}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>Annuler</Button>
        <Button onClick={handleSubmit} disabled={isPending || !name.trim()} data-action="submit-rename-template">
          {isPending && <Loader2 className="animate-spin" aria-hidden />}
          {isPending ? "Enregistrement…" : "Renommer"}
        </Button>
      </DialogFooter>
    </>
  );
}

// Dialogue partagé, UNIQUE pour toute la table (pas une instance par ligne) : `target` porte à la
// fois l'état ouvert/fermé (`open={!!target}`) et la ligne visée — même schéma que
// components/queue/preview-sheet.tsx pour une sélection ligne-par-ligne dans une table.
function RenameTemplateDialog({
  target, onOpenChange, onRenamed,
}: { target: TemplateRow | null; onOpenChange: (open: boolean) => void; onRenamed: () => void }) {
  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        {target && <RenameTemplateForm key={target.id} target={target} onOpenChange={onOpenChange} onRenamed={onRenamed} />}
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Menu par ligne : dupliquer / renommer / archiver-désarchiver — les trois actions CRUD qui
// n'avaient, avant ce correctif, aucun point d'entrée écran. Gardé par RoleGate(template:manage —
// admin/éditeur, lib/rbac.ts) : défense en profondeur, comme components/queue/row-actions.tsx,
// même si le RBAC serveur (requirePermission dans lib/actions/studio-actions.ts) reste la vraie
// barrière — un journaliste qui appellerait l'action directement se heurterait de toute façon à un
// rejet, RoleGate n'évite ici que de lui montrer un bouton inutile.
function TemplateRowMenu({
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

// ─────────────────────────────────────────────────────────────────────────────
export function TemplatesTable({ templates, categories }: { templates: TemplateRow[]; categories: CategoryOption[] }) {
  const router = useRouter();
  const [renameTarget, setRenameTarget] = useState<TemplateRow | null>(null);
  const [isPending, startTransition] = useTransition();

  const groups = TEMPLATE_CONTEXTS
    .map((context) => ({ context, rows: templates.filter((t) => t.context === context) }))
    .filter((g) => g.rows.length > 0);

  function handleDuplicate(row: TemplateRow) {
    startTransition(async () => {
      const res = await duplicateTemplate(row.id);
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      // duplicateTemplateCore renvoie ok:true avec un message quand elle a dû replier la portée
      // (voire archiver la copie faute de portée libre, lib/studio/template-core.ts) — un succès
      // à surfacer, pas une erreur, mais pas un simple "dupliqué" silencieux non plus.
      if (res.message) toast.info(res.message);
      else toast.success(`« ${row.name} » dupliqué.`);
      router.refresh();
    });
  }

  function handleArchiveToggle(row: TemplateRow) {
    startTransition(async () => {
      const res = await archiveTemplate(row.id, nextArchivedState(row));
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success(row.archived ? `« ${row.name} » désarchivé.` : `« ${row.name} » archivé.`);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Gabarits</h1>
        <RoleGate allow={["admin", "editor"]}>
          <CreateTemplateDialog categories={categories} />
        </RoleGate>
      </div>

      {groups.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            Aucun gabarit pour l&rsquo;instant.
          </CardContent>
        </Card>
      ) : (
        groups.map((group) => (
          <Card key={group.context}>
            <CardHeader>
              <CardTitle>{CONTEXT_LABEL[group.context]}</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <div className="mx-(--card-spacing) rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nom</TableHead>
                      <TableHead>Portée</TableHead>
                      <TableHead>Format</TableHead>
                      <TableHead>État</TableHead>
                      <TableHead className="text-right">Modifié</TableHead>
                      <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {group.rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium">
                          <Link href={`/studio/${row.id}`} className="hover:underline">{row.name}</Link>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{scopeLabel(row)}</TableCell>
                        <TableCell className="text-muted-foreground">{formatLabel(row)}</TableCell>
                        <TableCell>
                          <StateBadge row={row} />
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {dateFormatter.format(row.updatedAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          <TemplateRowMenu
                            row={row} isPending={isPending}
                            onDuplicate={handleDuplicate} onArchiveToggle={handleArchiveToggle}
                            onRequestRename={setRenameTarget}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        ))
      )}

      <RenameTemplateDialog
        target={renameTarget}
        onOpenChange={(open) => !open && setRenameTarget(null)}
        onRenamed={() => router.refresh()}
      />
    </div>
  );
}
