"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/status-badge";
import { loadPreview } from "@/lib/actions/queue-preview-action";
import { MISSING_LABEL } from "@/lib/pipeline/completeness";
import type { QueuePreview, QueueRow } from "@/lib/queries/queue";
import type { ArticleStatus } from "@/lib/format";
import { cn } from "@/lib/utils";

export function PreviewSheet({ row }: { row: QueueRow }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<QueuePreview | null>(null);
  const [isLoading, startLoading] = useTransition();

  function handleOpenChange(next: boolean) {
    setOpen(next);
    // Rechargé à chaque ouverture plutôt que mis en cache : entre deux ouvertures, une
    // correction en ligne a pu changer l'article.
    if (next) startLoading(async () => setData(await loadPreview(row.id)));
    else setData(null);
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger render={<Button variant="ghost" size="sm">Aperçu</Button>} />
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="pr-8 text-left">{row.title}</SheetTitle>
        </SheetHeader>

        {isLoading && <p className="text-sm text-muted-foreground">Chargement…</p>}

        {data && (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={data.status as ArticleStatus} />
              {data.categoryName && <Badge variant="outline">{data.categoryName}</Badge>}
              {data.score !== null && <Badge variant="outline">Score {data.score}</Badge>}
            </div>

            {data.missingFields.length > 0 && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                <p className="font-medium">Informations manquantes</p>
                <ul className="mt-1 list-inside list-disc text-muted-foreground">
                  {data.missingFields.map((m) => <li key={m}>{MISSING_LABEL[m]}</li>)}
                </ul>
              </div>
            )}

            {data.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- URL externes par article ; aucun remotePattern configuré.
              <img src={data.imageUrl} alt="" className="w-full rounded-md object-cover" />
            )}
            {data.imageCredit && (
              <p className="text-xs text-muted-foreground">Crédit : {data.imageCredit}</p>
            )}

            {data.excerpt && <p className="text-muted-foreground">{data.excerpt}</p>}

            {/* Le corps est déjà assaini en base (sanitizeArticleHtml à la génération et à
                chaque enregistrement humain) — aucun second assainissement ici. */}
            <div
              className="prose prose-sm dark:prose-invert max-w-none"
              dangerouslySetInnerHTML={{ __html: data.bodyHtml }}
            />

            {data.sources.length > 0 && (
              <div>
                <p className="font-medium">Sources</p>
                <ul className="mt-1 list-inside list-disc">
                  {data.sources.map((s) => (
                    <li key={s.url}>
                      <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline">
                        {s.mediaName}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <Link
              href={`/article/${row.id}`}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            >
              Ouvrir dans l&apos;éditeur
            </Link>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
