"use client";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { RoleGate } from "@/components/role-gate";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { unpublishArticleAction, republishArticleAction } from "@/lib/actions/publish-actions";
import type { ArticleDetail } from "@/lib/queries/article";

// Rendered in the editor's published read-only banner (article.status === "published").
// Dépublier drafts the WordPress post and moves the article back to 'approved' (a human
// can re-publish it later); Republier pushes the article's current DB content to the
// same WordPress post without leaving the published state.
export function PublishControls({ article }: { article: ArticleDetail }) {
  const [isPending, startTransition] = useTransition();
  const displayTitle = article.title.trim() || "Sans titre";

  function handleUnpublish() {
    startTransition(async () => {
      try {
        const res = await unpublishArticleAction(article.id);
        if (res.ok) toast.success(res.message);
        else toast.error(res.message);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec de la dépublication.");
      }
    });
  }

  function handleRepublish() {
    startTransition(async () => {
      try {
        const res = await republishArticleAction(article.id);
        if (res.ok) toast.success(res.message);
        else toast.error(res.message);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec de la republication.");
      }
    });
  }

  return (
    <RoleGate allow={["admin", "editor"]}>
      <div className="flex items-center gap-2">
        <ConfirmDialog
          trigger={
            <Button type="button" variant="outline" size="sm" disabled={isPending}>
              Dépublier
            </Button>
          }
          title="Dépublier cet article ?"
          description={`« ${displayTitle} » sera retiré du site public (mis en brouillon sur WordPress) et repassera au statut « approuvé ».`}
          confirmLabel="Dépublier"
          destructive
          onConfirm={handleUnpublish}
        />

        <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={handleRepublish}>
          Republier
        </Button>
      </div>
    </RoleGate>
  );
}
