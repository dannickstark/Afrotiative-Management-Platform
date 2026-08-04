"use client";
import { useTransition } from "react";
import { toast } from "sonner";
import { Loader2, RefreshCw } from "lucide-react";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { syncTaxonomyFromWordPress } from "@/lib/actions/taxonomy-actions";
import type { Taxonomy } from "@/lib/queries/settings";

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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Catégories & Tags</h1>
        <Button onClick={handleSync} disabled={isSyncing}>
          {isSyncing ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
          Synchroniser depuis WordPress
        </Button>
      </div>

      <TaxonomyCard title="Catégories" emptyLabel="Aucune catégorie configurée." rows={data.categories} />
      <TaxonomyCard title="Tags" emptyLabel="Aucun tag configuré." rows={data.tags} />
    </div>
  );
}

type Row = Taxonomy["categories"][number];

function TaxonomyCard({ title, emptyLabel, rows }: { title: string; emptyLabel: string; rows: Row[] }) {
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
                <TableHead className="text-right">Articles</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                    {emptyLabel}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell className="text-muted-foreground">{row.wpId ?? "—"}</TableCell>
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
