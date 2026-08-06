import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";
import type { PublishedRow } from "@/lib/queries/published";

export function PublishedTable({ rows, filtered }: { rows: PublishedRow[]; filtered: boolean }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border py-10 text-center text-sm text-muted-foreground">
        {filtered ? "Aucun résultat pour ces filtres." : "Aucun article publié pour l'instant."}
      </p>
    );
  }
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Article</TableHead>
            <TableHead>Catégorie</TableHead>
            <TableHead>Publié le</TableHead>
            <TableHead>Auteur</TableHead>
            <TableHead className="text-right">WordPress</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell>
                <Link href={`/article/${r.id}`} className="flex items-center gap-3 hover:underline">
                  {r.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.imageUrl} alt="" className="size-10 shrink-0 rounded object-cover" />
                  ) : (
                    <div className="size-10 shrink-0 rounded bg-muted" />
                  )}
                  <span className="line-clamp-2 font-medium">{r.title}</span>
                </Link>
              </TableCell>
              <TableCell>{r.categoryName ?? "—"}</TableCell>
              <TableCell className="whitespace-nowrap">{formatDate(r.publishedAt)}</TableCell>
              <TableCell><Badge variant="outline">{r.aiAuthor ? "IA" : "Humain"}</Badge></TableCell>
              <TableCell className="text-right">
                {r.wpUrl ? (
                  <a href={r.wpUrl} target="_blank" rel="noopener noreferrer"
                     className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
                    Voir <ExternalLink className="size-3.5" />
                  </a>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
