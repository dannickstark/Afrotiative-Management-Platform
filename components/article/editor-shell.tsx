"use client";
import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RichEditor } from "./rich-editor";
import { ActionBar } from "./action-bar";
import { LockBanner } from "./lock-banner";
import { acquireLock, refreshLock, releaseLock } from "@/lib/actions/article-actions";
import type { ArticleDetail } from "@/lib/queries/article";
import type { Role } from "@/lib/auth";

const HEARTBEAT_MS = 60_000;

// Two-column editor shell. Owns ALL of the article's editable form state
// (title, body, excerpt, category, tags, image fields) so that Task 13's real
// SidePanel can be dropped into the right column and consume/mutate this same
// state — for now the right column is a read-only placeholder.
export function EditorShell({
  article, lockedByOther,
}: {
  article: ArticleDetail;
  role: Role; // accepted for prop-contract parity with the page; RoleGate reads the live session client-side instead
  lockedByOther: boolean;
}) {
  const isPublished = article.status === "published";

  const [title, setTitle] = useState(article.title);
  const [bodyHtml, setBodyHtml] = useState(article.bodyHtml);
  const [excerpt] = useState(article.excerpt ?? ""); // never null — saveDraftSchema.excerpt is optional but not nullable
  const [categoryId] = useState<string | null>(article.categoryId);
  const [tags] = useState(article.tags.map((t) => ({ tagName: t.tagName, isNew: t.isNew })));
  const [featuredImageUrl] = useState<string | null>(article.featuredImageUrl);
  const [imageCredit] = useState<string | null>(article.imageCredit);
  const [imageSourceUrl] = useState<string | null>(article.imageSourceUrl);

  // Seeded from the server-computed guard for a flash-free first paint;
  // reconciled with the authoritative result of acquireLock() right after mount.
  const [lockedOut, setLockedOut] = useState(lockedByOther);
  const [holderName, setHolderName] = useState(article.lockerName);

  const articleId = article.id;
  useEffect(() => {
    if (isPublished) return; // published articles are inherently read-only; no lock needed
    let cancelled = false;

    acquireLock(articleId).then((res) => {
      if (cancelled) return;
      setLockedOut(!res.ok);
      if (!res.ok) setHolderName((prev) => prev ?? res.heldBy);
    });

    // Heartbeat: no-op server-side if this session doesn't currently hold the
    // lock (the UPDATE's WHERE clause matches zero rows), so it's safe to run
    // unconditionally rather than gating on lock state.
    const interval = setInterval(() => { void refreshLock(articleId); }, HEARTBEAT_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
      void releaseLock(articleId);
    };
  }, [articleId, isPublished]);

  const readOnly = isPublished || lockedOut;

  return (
    <div className="flex h-full flex-col gap-4">
      {isPublished && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-4 py-2 text-sm">
          <span>Cet article est publié. Il est en lecture seule.</span>
          <Button type="button" variant="outline" size="sm" disabled title="Bientôt disponible">
            Dépublier / Republier
          </Button>
        </div>
      )}
      {!isPublished && lockedOut && <LockBanner holder={holderName ?? "un autre utilisateur"} />}

      <div className="flex flex-1 flex-col gap-6 overflow-hidden lg:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto">
          <div className="flex items-start gap-2">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={readOnly}
              placeholder="Titre de l'article"
              aria-label="Titre de l'article"
              className="h-10 flex-1 font-heading text-lg font-semibold"
            />
            <Tooltip>
              {/* Wrap the disabled button in a focusable span: Button's `disabled:`
                  styles set `pointer-events-none`, which would otherwise stop the
                  span-less trigger from ever receiving the hover/focus that opens
                  the tooltip. */}
              <TooltipTrigger
                render={
                  <span tabIndex={0} className="inline-flex shrink-0">
                    <Button type="button" variant="outline" size="sm" disabled>
                      <Sparkles className="size-4" /> Améliorer avec IA
                    </Button>
                  </span>
                }
              />
              <TooltipContent>Bientôt (SP3)</TooltipContent>
            </Tooltip>
          </div>

          <RichEditor value={bodyHtml} onChange={setBodyHtml} editable={!readOnly} />
        </div>

        {/* TEMPORARY placeholder — Task 13 replaces this with the real, editable
            SidePanel (category, tags, image fields) consuming the state above. */}
        <Card className="w-full shrink-0 lg:w-80">
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Panneau latéral (Task 13)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Catégorie</p>
              <p>{article.categoryName ?? "Non définie"}</p>
            </div>
            {featuredImageUrl && (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Image à la une</p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={featuredImageUrl} alt="" className="aspect-video w-full rounded-md border object-cover" />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <ActionBar
        articleId={articleId}
        title={title}
        bodyHtml={bodyHtml}
        excerpt={excerpt}
        categoryId={categoryId}
        tags={tags}
        featuredImageUrl={featuredImageUrl}
        imageCredit={imageCredit}
        imageSourceUrl={imageSourceUrl}
        readOnly={readOnly}
      />
    </div>
  );
}
