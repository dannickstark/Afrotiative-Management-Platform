"use client";
import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { Loader2, RefreshCw } from "lucide-react";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/shell/page-header";
import { syncTaxonomyFromWordPress, setCategoryColor } from "@/lib/actions/taxonomy-actions";
import type { Taxonomy } from "@/lib/queries/settings";
// Module dédié, sans import de @/db (contrairement à lib/studio/bindings.ts) — importable ici,
// dans un composant "use client", sans tirer le pool `pg` dans le bundle navigateur. Voir ce
// fichier pour le détail.
import { DEFAULT_CATEGORY_COLOR } from "@/lib/studio/default-category-color";

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

// Common shape shared with wpTags rows (only these fields are rendered). Narrowed rather than
// aliased to Taxonomy["categories"][number] directly: the studio's `color` column (db/schema.ts)
// lives only on wp_categories, not wp_tags, so the full categories row type is no longer
// structurally assignable from tags data.
type Row = Pick<Taxonomy["categories"][number], "id" | "wpId" | "name" | "articleCount">;

// Widened for categories ONLY (Task 3) — adds back the one field categories need that tags don't
// have. Deliberately NOT folded into the shared `Row` above: doing so would re-broaden it to a
// shape tags data can no longer structurally satisfy, reintroducing the exact divergence `Row` was
// narrowed to fix in V1. TaxonomyCard stays generic over `Row` so the tags call site is unaffected.
type CategoryRow = Row & { color: string | null };

function TaxonomyCard<R extends Row>({
  title, emptyLabel, rows, extraColumn,
}: {
  title: string;
  emptyLabel: string;
  rows: R[];
  extraColumn?: { header: string; render: (row: R) => ReactNode };
}) {
  const columnCount = extraColumn ? 4 : 3;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <div className="mx-(--card-spacing) rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nom</TableHead>
                <TableHead>ID WordPress</TableHead>
                {extraColumn && <TableHead>{extraColumn.header}</TableHead>}
                <TableHead className="text-right">Articles</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={columnCount} className="h-24 text-center text-muted-foreground">
                    {emptyLabel}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell className="text-muted-foreground">{row.wpId ?? "—"}</TableCell>
                    {extraColumn && <TableCell>{extraColumn.render(row)}</TableCell>}
                    <TableCell className="text-right">{row.articleCount}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

// One editable cell per category row: a swatch previewing the colour actually used at render time
// (the stored colour, or DEFAULT_CATEGORY_COLOR — same fallback lib/studio/bindings.ts applies),
// plus a text input for the strict #RRGGBB value. Saves on blur — no separate "save" button, since
// this is a single-field edit per row, not a multi-field form like FixPopover.
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

  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        className="size-5 shrink-0 rounded border"
        style={{ backgroundColor: value || DEFAULT_CATEGORY_COLOR }}
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
