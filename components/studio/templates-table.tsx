"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  LayoutGrid, List, Loader2, Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { DataTableToolbar } from "@/components/ui/data-table-toolbar";
import { useTemplatesView } from "@/hooks/use-templates-view";
import { TemplatesGallery } from "@/components/studio/templates-gallery";
import { CONTEXT_LABEL } from "@/components/studio/templates-shared";
// B8: the list-view table is now the shared client-mode DataTable (sortable Nom/Contexte/Modifié +
// a global search box on Nom) — same recipe as feeds-table.tsx/runs-view.tsx. The GALLERY view
// (TemplatesGallery, imported above) and the grid/table toggle below are UNCHANGED.
import { templatesColumns } from "@/components/studio/templates-columns";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
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
import { TEMPLATE_CONTEXTS, CHANNELS, CHANNEL_LABELS, type TemplateContext, type Channel } from "@/lib/studio/tokens";
import type { TemplateRow, CategoryOption } from "@/lib/queries/studio";
import { createTemplate, duplicateTemplate, archiveTemplate, renameTemplate } from "@/lib/actions/studio-actions";

// scopeLabel moved to components/studio/templates-columns.tsx (B8) — it's now the "Portée" column
// cell in the list-view DataTable, unit-tested there (tests/templates-columns.test.ts).

function formatPresetLabel(key: FormatKey): string {
  const preset = FORMAT_PRESETS[key];
  return `${preset.label} (${preset.width}×${preset.height})`;
}

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
//
// EXPORTÉ (Tâche 2, U1 spec §3) : components/studio/panels/modeles-panel.tsx réutilise ce MÊME
// composant comme action primaire du panneau « Modèles » (« Nouveau gabarit vierge »), plutôt que
// de reconstruire un second formulaire de création — exactement le chemin d'écriture que la règle
// de réutilisation (spec §3) interdit de dupliquer.
export function CreateTemplateDialog({ categories }: { categories: CategoryOption[] }) {
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
      <DialogTrigger render={<Button data-action="create-template"><Plus aria-hidden />Nouveau gabarit vierge</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nouveau gabarit vierge</DialogTitle>
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
                    {(v: string | null) => (v && v !== NO_CHANNEL ? (CHANNEL_LABELS[v as Channel] ?? v) : "Aucun")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CHANNEL}>Aucun</SelectItem>
                  {CHANNELS.map((c) => <SelectItem key={c} value={c}>{CHANNEL_LABELS[c]}</SelectItem>)}
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
// TemplateRowMenu (menu par ligne : dupliquer / renommer / archiver-désarchiver) vit désormais dans
// components/studio/templates-shared.tsx (Chantier A, Tâche 5), importé plus haut — voir le
// commentaire d'en-tête de ce fichier pour pourquoi (templates-gallery.tsx pose CE MÊME menu sur
// chaque carte, spec §4 : « the same actions the table row has »).

// ─────────────────────────────────────────────────────────────────────────────
// `showHeader` (Tâche 2, U1 spec §3) : par défaut `true`, comportement inchangé pour /studio
// (app/(app)/studio/page.tsx, seul appelant historique). `components/studio/panels/modeles-panel.tsx`
// passe `false` — il affiche déjà SA PROPRE instance de `CreateTemplateDialog` en action primaire du
// panneau (skeleton commun de panel-host.tsx), donc masque ce titre + ce bouton internes plutôt que
// d'en faire naître un second qui ferait doublon dès qu'un vrai rôle admin/éditeur serait présent
// (RoleGate ne bloque rien en test — voir le fichier de test — mais bloquerait le second bouton en
// production tout autant que le premier). Les groupes par contexte, eux, restent identiques dans les
// deux cas : c'est la liste « gabarits existants à dupliquer » que le panneau vient héberger.
export function TemplatesTable({
  templates, categories, showHeader = true,
}: { templates: TemplateRow[]; categories: CategoryOption[]; showHeader?: boolean }) {
  const router = useRouter();
  const [renameTarget, setRenameTarget] = useState<TemplateRow | null>(null);
  const [isPending, startTransition] = useTransition();
  // Chantier A, Tâche 5 (spec §4) — bascule grille/tableau, RÉSERVÉE à la page complète /studio
  // (`showHeader === true`, voir le commentaire ci-dessus). Le panneau Modèles du rail
  // (`showHeader === false`, components/studio/panels/modeles-panel.tsx) reste TOUJOURS le tableau,
  // sans bascule visible : ~212-360px de large (panel-host.tsx) est trop étroit pour une grille de
  // vignettes rendues, et la préférence persistée ci-dessous est PARTAGÉE par navigateur (comme
  // EditorPrefs) — le panneau n'a donc aucune raison d'en lire ni d'en écrire une valeur qu'il ne
  // sait pas afficher.
  const [view, setView] = useTemplatesView();
  // B8: global search state for the list-view DataTable below — same pattern as
  // feeds-table.tsx/runs-view.tsx. Only ever read while `view === "table"`; the gallery view
  // (TemplatesGallery) has no search box of its own, unchanged from before this conversion.
  const [globalFilter, setGlobalFilter] = useState("");

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

  const columns = templatesColumns({
    isPending, onDuplicate: handleDuplicate, onArchiveToggle: handleArchiveToggle, onRequestRename: setRenameTarget,
  });

  return (
    // testid EXPORTÉ (Tâche 2) : tests/studio-templates-table.test.ts l'utilise pour prouver que
    // components/studio/panels/modeles-panel.tsx HÉBERGE cette table plutôt que d'en reconstruire
    // une seconde — seul CE fichier pose cet attribut.
    <div className="space-y-4" data-testid="templates-table">
      {showHeader && (
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">Gabarits</h1>
          <div className="flex items-center gap-2">
            {/* Deux boutons distincts (pas un seul bouton bascule) : chacun pose une valeur EXPLICITE
                (setView("grid") / setView("table")), jamais un XOR aveugle sur l'état courant — l'état
                actif (aria-pressed + variant "secondary") reste lisible sans avoir à connaître l'état
                précédent. data-testid EXPORTÉS (Chantier A, Tâche 5) : tests/studio-templates-gallery.
                test.ts prouve, via lib/studio/templates-view-pref.ts, que la valeur choisie persiste
                réellement (parseTemplatesView(serializeTemplatesView(v)) === v). */}
            <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Affichage des gabarits">
              <Button
                type="button" size="icon-sm" variant={view === "grid" ? "secondary" : "ghost"}
                aria-pressed={view === "grid"} title="Vue grille" data-testid="templates-view-grid"
                onClick={() => setView("grid")}
              >
                <LayoutGrid aria-hidden />
              </Button>
              <Button
                type="button" size="icon-sm" variant={view === "table" ? "secondary" : "ghost"}
                aria-pressed={view === "table"} title="Vue tableau" data-testid="templates-view-table"
                onClick={() => setView("table")}
              >
                <List aria-hidden />
              </Button>
            </div>
            <RoleGate allow={["admin", "editor"]}>
              <CreateTemplateDialog categories={categories} />
            </RoleGate>
          </div>
        </div>
      )}

      {templates.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            Aucun gabarit pour l&rsquo;instant.
          </CardContent>
        </Card>
      ) : showHeader && view === "grid" ? (
        <TemplatesGallery
          templates={templates} isPending={isPending}
          onDuplicate={handleDuplicate} onArchiveToggle={handleArchiveToggle}
          onRequestRename={setRenameTarget}
        />
      ) : (
        // B8: single flat DataTable across every context (previously one <Table> PER context,
        // grouped in its own Card) — "Contexte" is now a sortable column instead of a section
        // header, so the whole list-view table shares ONE search box and ONE sort state, same
        // recipe as feeds-table.tsx/runs-view.tsx. The gallery view above still groups by context
        // (TemplatesGallery, unchanged) — that grouping isn't lost, just no longer duplicated here.
        <DataTable
          columns={columns}
          data={templates}
          globalFilter={globalFilter}
          onGlobalFilterChange={setGlobalFilter}
          emptyMessage="Aucun gabarit ne correspond à cette recherche."
          toolbar={
            <DataTableToolbar
              globalValue={globalFilter}
              onGlobalChange={setGlobalFilter}
              searchPlaceholder="Rechercher un gabarit…"
            />
          }
        />
      )}

      <RenameTemplateDialog
        target={renameTarget}
        onOpenChange={(open) => !open && setRenameTarget(null)}
        onRenamed={() => router.refresh()}
      />
    </div>
  );
}
