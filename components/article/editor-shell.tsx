"use client";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { RichEditor } from "./rich-editor";
import { ActionBar } from "./action-bar";
import { ImproveDialog } from "./improve-dialog";
import { LockBanner } from "./lock-banner";
import { SidePanel } from "./side-panel";
import { PublishControls } from "./publish-controls";
import { acquireLock, refreshLock, releaseLock } from "@/lib/actions/article-actions";
import type { ArticleDetail } from "@/lib/queries/article";
import type { Role } from "@/lib/auth";

const HEARTBEAT_MS = 60_000;

// Two-column editor shell. Owns ALL of the article's editable form state
// (title, body, excerpt, category, tags, image fields) so that the SidePanel
// in the right column can consume/mutate this same state.
export function EditorShell({
  article, lockedByOther, wpTagNames,
}: {
  article: ArticleDetail;
  role: Role; // accepted for prop-contract parity with the page; RoleGate reads the live session client-side instead
  lockedByOther: boolean;
  wpTagNames: string[];
}) {
  const isPublished = article.status === "published";

  const [title, setTitle] = useState(article.title);
  const [bodyHtml, setBodyHtml] = useState(article.bodyHtml);
  const [excerpt, setExcerpt] = useState(article.excerpt ?? ""); // never null — saveDraftSchema.excerpt is optional but not nullable
  const [categoryId, setCategoryId] = useState<string | null>(article.categoryId);
  const [tags, setTags] = useState(article.tags.map((t) => ({ tagName: t.tagName, isNew: t.isNew })));
  const [featuredImageUrl, setFeaturedImageUrl] = useState<string | null>(article.featuredImageUrl);
  const [imageCredit, setImageCredit] = useState<string | null>(article.imageCredit);
  const [imageSourceUrl, setImageSourceUrl] = useState<string | null>(article.imageSourceUrl);

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
          <PublishControls article={article} />
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
            <ImproveDialog articleId={articleId} disabled={readOnly} />
          </div>

          <RichEditor value={bodyHtml} onChange={setBodyHtml} editable={!readOnly} />
        </div>

        <SidePanel
          article={article}
          image={{ featuredImageUrl, imageCredit, imageSourceUrl }}
          onImageChange={(fields) => {
            setFeaturedImageUrl(fields.featuredImageUrl);
            setImageCredit(fields.imageCredit);
            setImageSourceUrl(fields.imageSourceUrl);
          }}
          categoryId={categoryId}
          onCategoryChange={setCategoryId}
          tags={tags}
          onTagsChange={setTags}
          wpTagNames={wpTagNames}
          excerpt={excerpt}
          onExcerptChange={setExcerpt}
          readOnly={readOnly}
        />
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
