"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CalendarClock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RoleGate } from "@/components/role-gate";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { RegenerateDialog } from "@/components/article/regenerate-dialog";
import { saveDraft, rejectArticle, approveAndPublish, schedule } from "@/lib/actions/article-actions";

// Persistent action bar for the article editor. "Enregistrer" is available to
// any role that can reach this screen (journalist/editor/admin all have
// article:edit); the rest are gated to admin/editor via RoleGate — journalists
// must not see Rejeter / Renvoyer à l'IA / Approuver & publier / Planifier.
export function ActionBar({
  articleId, title, bodyHtml, excerpt, categoryId, tags, featuredImageUrl, imageCredit, imageSourceUrl, readOnly,
  defaultImageMode,
}: {
  articleId: string;
  title: string;
  bodyHtml: string;
  excerpt: string;
  categoryId: string | null;
  tags: { tagName: string; isNew: boolean }[];
  featuredImageUrl: string | null;
  imageCredit: string | null;
  imageSourceUrl: string | null;
  readOnly: boolean;
  defaultImageMode: "auto" | "manual";
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");

  const disabled = readOnly || isPending;
  const displayTitle = title.trim() || "Sans titre";

  // Shared with Approve/Schedule below so they always act on the live form
  // state rather than the last-persisted DB row (see handleApprovePublish /
  // handleSchedule).
  function saveCurrent() {
    return saveDraft({
      id: articleId, title, bodyHtml, excerpt, categoryId, tags,
      featuredImageUrl, imageCredit, imageSourceUrl,
    });
  }

  function handleSave() {
    startTransition(async () => {
      try {
        await saveCurrent();
        toast.success(`« ${displayTitle} » enregistré.`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec de l'enregistrement.");
      }
    });
  }

  function handleReject(reason?: string) {
    startTransition(async () => {
      try {
        await rejectArticle({ id: articleId, reason: reason ?? "" });
        toast.success(`« ${displayTitle} » rejeté.`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec du rejet.");
      }
    });
  }

  function handleApprovePublish() {
    startTransition(async () => {
      try {
        // Persist the side panel's in-memory edits first: approveAndPublish
        // re-reads the DB row for its category/image-credit checks, so an
        // unsaved category pick would otherwise still fail validation.
        await saveCurrent();
        const res = await approveAndPublish(articleId);
        toast.success(res.message);
        router.push("/queue");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec de la publication.");
      }
    });
  }

  function handleSchedule() {
    if (!scheduleAt) return;
    startTransition(async () => {
      try {
        // Same reasoning as handleApprovePublish: save the live form state
        // before scheduling so it acts on what's on screen, not the last save.
        await saveCurrent();
        await schedule({ id: articleId, at: new Date(scheduleAt) });
        toast.success(`« ${displayTitle} » planifié pour le ${new Date(scheduleAt).toLocaleString("fr-FR")}.`);
        setScheduleOpen(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec de la planification.");
      }
    });
  }

  return (
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur supports-backdrop-filter:bg-background/80">
      {isPending && <Loader2 className="mr-auto size-4 animate-spin text-muted-foreground" />}

      <Button type="button" variant="outline" disabled={disabled} onClick={handleSave}>
        Enregistrer
      </Button>

      <RoleGate allow={["admin", "editor"]}>
        <ConfirmDialog
          trigger={
            <Button
              type="button"
              variant="ghost"
              disabled={disabled}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              Rejeter
            </Button>
          }
          title="Rejeter cet article ?"
          description={`« ${displayTitle} » sera marqué comme rejeté et retiré de la file de publication.`}
          confirmLabel="Rejeter"
          destructive
          withReason
          onConfirm={handleReject}
        />

        <RegenerateDialog articleId={articleId} disabled={disabled} defaultImageMode={defaultImageMode} />

        <Popover open={scheduleOpen} onOpenChange={setScheduleOpen}>
          <PopoverTrigger
            render={
              <Button type="button" variant="outline" disabled={disabled}>
                <CalendarClock className="size-4" /> Planifier
              </Button>
            }
          />
          <PopoverContent className="w-64">
            <div className="flex flex-col gap-2">
              <label htmlFor="schedule-at" className="text-xs font-medium text-muted-foreground">
                Date et heure de publication
              </label>
              <Input
                id="schedule-at"
                type="datetime-local"
                value={scheduleAt}
                onChange={(e) => setScheduleAt(e.target.value)}
              />
              <Button type="button" size="sm" disabled={!scheduleAt || isPending} onClick={handleSchedule}>
                Confirmer la planification
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        <Button type="button" disabled={disabled} onClick={handleApprovePublish}>
          Approuver & publier
        </Button>
      </RoleGate>
    </div>
  );
}
