"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Sparkles } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { improveWithAi } from "@/lib/actions/article-actions";

// Self-contained Dialog (owns its own trigger + open state), mirroring AddMemberDialog's pattern.
// Renders its own "Améliorer avec IA" trigger so callers (EditorShell) can drop it in place of
// the old disabled button without threading open state through props.
export function ImproveDialog({ articleId, disabled: triggerDisabled }: { articleId: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [isPending, startTransition] = useTransition();

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next && !isPending) setInstruction(""); // reset for next open
  }

  function handleConfirm() {
    startTransition(async () => {
      try {
        const trimmed = instruction.trim();
        const r = await improveWithAi(articleId, { instruction: trimmed || undefined });
        if (r.ok) {
          toast.success(r.message);
          setOpen(false);
          setInstruction("");
        } else {
          toast.error(r.message);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec de l'amélioration.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button type="button" variant="outline" size="sm" disabled={triggerDisabled}><Sparkles className="size-4" /> Améliorer avec IA</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Améliorer avec IA</DialogTitle>
          <DialogDescription>
            L&apos;IA réécrit le corps de l&apos;article. Ajoutez une instruction optionnelle pour guider la
            réécriture (ton, longueur, style…).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="improve-instruction">Instruction (optionnelle)</Label>
          <Textarea
            id="improve-instruction"
            value={instruction}
            disabled={isPending}
            maxLength={500}
            placeholder="ex : raccourcir, ton plus formel…"
            onChange={(e) => setInstruction(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)} disabled={isPending}>Annuler</Button>
          <Button type="button" onClick={handleConfirm} disabled={isPending}>
            {isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />}
            {isPending ? "Amélioration…" : "Améliorer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
