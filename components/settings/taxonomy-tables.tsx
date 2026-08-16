"use client";
import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { Loader2, RefreshCw } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/ui/data-table";
import { DataTableToolbar } from "@/components/ui/data-table-toolbar";
import { PageHeader } from "@/components/shell/page-header";
import { EmptyState } from "@/components/shell/empty-state";
import { syncTaxonomyFromWordPress, setCategoryColor } from "@/lib/actions/taxonomy-actions";
import type { Taxonomy } from "@/lib/queries/settings";
// Module dédié, sans import de @/db (contrairement à lib/studio/bindings.ts) — importable ici,
// dans un composant "use client", sans tirer le pool `pg` dans le bundle navigateur. Voir ce
// fichier pour le détail.
import { DEFAULT_CATEGORY_COLOR } from "@/lib/studio/default-category-color";
// B7: ONE column factory reused for both the "Catégories" and "Tags" instances of TaxonomyCard
// below — see components/settings/taxonomy-columns.tsx for why Row/CategoryRow live there now
// (moved verbatim, unchanged shapes) instead of being redefined here.
import { taxonomyColumns, type Row, type CategoryRow } from "@/components/settings/taxonomy-columns";

// Page-level view for the taxonomy mirror admin (SP2 Task 4). Owns the "Synchroniser depuis
// WordPress" entry point and both read-only tables — the server page.tsx wrapper stays a thin
// data-fetch + auth gate, matching the FeedsTable/MembersTable structural convention from Tasks 2–3.
export function TaxonomyTables({ data }: { data: Taxonomy }) {
  const [isSyncing, startSync] = useTransition();

  function handleSync() {
    startSync(async () => {
      try {
        const res = await syncTaxonomyFromWordPress();
        if (res.ok) toast.success(`${res.categories} catégories, ${res.tags} tags synchronisés.`);
        else toast.error(res.message);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec de la synchronisation.");
      }
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Catégories & Tags"
        actions={
          <Button onClick={handleSync} disabled={isSyncing}>
            {isSyncing ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
            Synchroniser depuis WordPress
          </Button>
        }
      />

      <TaxonomyCard
        title="Catégories"
        emptyLabel="Aucune catégorie configurée."
        rows={data.categories}
        extraColumn={{ header: "Couleur", render: (row) => <CategoryColorCell id={row.id} color={row.color} /> }}
      />
      <TaxonomyCard title="Tags" emptyLabel="Aucun tag configuré." rows={data.tags} />
    </div>
  );
}

// B7: converted from a hand-rolled <Table> to the shared client-mode DataTable (sortable Nom/ID
// WordPress/Articles + a global search box on Nom) — same recipe as feeds-table.tsx/runs-view.tsx.
// `extraColumn`'s shape (header + render) is unchanged from before; taxonomyColumns (imported
// above) is the ONE column factory reused for both this card's categories AND tags instances, so
// the two tables can never drift into two slightly different column sets.
function TaxonomyCard<R extends Row>({
  title, emptyLabel, rows, extraColumn,
}: {
  title: string;
  emptyLabel: string;
  rows: R[];
  extraColumn?: { header: string; render: (row: R) => ReactNode };
}) {
  const [globalFilter, setGlobalFilter] = useState("");
  const columns = taxonomyColumns<R>(extraColumn ? { id: "extra", ...extraColumn } : undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className={rows.length === 0 ? undefined : "px-0"}>
        {rows.length === 0 ? (
          <EmptyState
            title={emptyLabel}
            hint="Synchronisez depuis WordPress pour les récupérer."
          />
        ) : (
          <div className="mx-(--card-spacing)">
            <DataTable
              columns={columns}
              data={rows}
              globalFilter={globalFilter}
              onGlobalFilterChange={setGlobalFilter}
              emptyMessage="Aucun résultat pour cette recherche."
              toolbar={
                <DataTableToolbar
                  globalValue={globalFilter}
                  onGlobalChange={setGlobalFilter}
                  searchPlaceholder="Rechercher par nom…"
                />
              }
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

// One editable cell per category row: a native colour picker whose swatch previews the colour
// actually used at render time (the stored colour, or DEFAULT_CATEGORY_COLOR — same fallback
// lib/studio/bindings.ts applies), plus a text input for the strict #RRGGBB value. The two edit the
// same state: picking from the swatch fills the text field and vice-versa. Saves on blur — no
// separate "save" button, since this is a single-field edit per row, not a multi-field form like
// FixPopover.
function CategoryColorCell({ id, color }: { id: CategoryRow["id"]; color: CategoryRow["color"] }) {
  const initial = color ?? "";
  const [value, setValue] = useState(initial);
  // Tracks the last value actually persisted, so a blur that didn't change anything (e.g. the user
  // just tabbed through the field) doesn't fire a needless write on every visit to the row.
  const [saved, setSaved] = useState(initial);
  const [isSaving, startSaving] = useTransition();

  function commit() {
    const trimmed = value.trim();
    if (trimmed === saved) return;
    startSaving(async () => {
      try {
        const res = await setCategoryColor(id, trimmed || null);
        if (res.ok) {
          setValue(trimmed);
          setSaved(trimmed);
          toast.success("Couleur enregistrée.");
        } else {
          // Revient à la dernière valeur PERSISTÉE, pas à l'ancienne saisie refusée : sans ce
          // reset, `value` restait sur le texte refusé ("rouge") pendant que `saved` gardait
          // l'ancienne couleur — chaque blur suivant re-déclenchait alors la même action refusée
          // (trimmed !== saved reste vrai indéfiniment) et re-toastait, et le swatch rendait
          // `backgroundColor: "rouge"`, une valeur CSS invalide, donc vide.
          setValue(saved);
          toast.error(res.message);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec de l'enregistrement de la couleur.");
      }
    });
  }

  // `input[type=color]` n'accepte QUE du #rrggbb : une saisie partielle ("#1B7") ou vide le ferait
  // retomber silencieusement sur #000000 et afficherait un swatch noir trompeur pendant la frappe.
  // On lui donne donc la couleur de rendu effective tant que la saisie n'est pas un hex complet.
  const pickerValue = HEX_COLOR_RE.test(value.trim()) ? value.trim() : DEFAULT_CATEGORY_COLOR;

  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={pickerValue}
        onChange={(e) => setValue(e.target.value)}
        // commit() lit `value`, PAS e.target.value : sur une catégorie sans couleur le picker
        // affiche DEFAULT_CATEGORY_COLOR sans que rien ne soit stocké, et un simple passage au
        // clavier persisterait cette valeur par défaut comme si l'utilisateur l'avait choisie.
        onBlur={commit}
        disabled={isSaving}
        title="Choisir la couleur de la catégorie"
        aria-label="Sélecteur de couleur de la catégorie"
        className="size-8 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5 disabled:cursor-not-allowed disabled:opacity-50 [&::-moz-color-swatch]:rounded [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded [&::-webkit-color-swatch]:border-0"
      />
      <Input
        value={value}
        placeholder={DEFAULT_CATEGORY_COLOR}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        disabled={isSaving}
        className="h-8 w-28 font-mono text-sm"
        aria-label="Couleur de la catégorie (format #RRGGBB)"
      />
    </div>
  );
}
