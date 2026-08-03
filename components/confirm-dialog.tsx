"use client";
import { useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

// Note (Base UI, not Radix): the generated DialogTrigger has no `asChild` prop.
// Base UI's equivalent is the `render` prop — pass the trigger element itself
// (instead of children) and Base UI clones it with the open/aria/onClick props
// merged in. Passing `trigger` as `children` here would instead wrap it in an
// extra native <button>, producing invalid nested-button markup when `trigger`
// is itself a <Button>.
export function ConfirmDialog({ trigger, title, description, confirmLabel, destructive, withReason, onConfirm }:
  { trigger: React.ReactElement; title: string; description: string; confirmLabel: string;
    destructive?: boolean; withReason?: boolean; onConfirm: (reason?: string) => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">{description}</p>
        {withReason && <Textarea placeholder="Motif (obligatoire)…" value={reason} onChange={(e) => setReason(e.target.value)} />}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Annuler</Button>
          <Button variant={destructive ? "destructive" : "default"}
            disabled={withReason && reason.trim().length < 3}
            onClick={async () => { await onConfirm(withReason ? reason : undefined); setOpen(false); }}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
