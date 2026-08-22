"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { deriveVariant, deleteVariant } from "@/lib/actions/video-actions";
import { PLATFORM_LABEL } from "@/lib/video/labels";
import { PLATFORMS } from "@/lib/video/schema";

type VariantRow = { id: string; platform: string; aspectRatio: string; derivedFromId: string | null; position: number };

const ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;

type FormState = { platform: string; aspectRatio: string; targetDurationSec: string };

const EMPTY: FormState = { platform: PLATFORMS[0], aspectRatio: ASPECT_RATIOS[0], targetDurationSec: "" };

// Gestionnaire de variantes dérivées (SP6, Task 2) — motif de speakers-manager.tsx (Card + Dialog +
// ConfirmDialog + useTransition + toast), MAIS avec navigation : dériver amène l'utilisateur sur la
// nouvelle variante, et supprimer la variante ACTIVE le ramène sur l'origine (le lien `?variant=`
// qu'il avait sous les yeux ne pointerait plus vers rien sinon). S'affiche même avec une seule
// variante : c'est le seul point d'entrée pour « Dériver une variante ».
export function VariantManager({ projectId, variants, activeVariantId }: {
  projectId: string; variants: VariantRow[]; activeVariantId: string | null;
}) {
  const router = useRouter();
  const [deriving, setDeriving] = useState(false);
  const [isDeleting, startDeleting] = useTransition();

  function handleDelete(v: VariantRow) {
    startDeleting(async () => {
      const res = await deleteVariant({ variantId: v.id });
      if (!res.ok) { toast.error(res.message); return; }
      toast.success("Variante supprimée.");
      if (v.id === activeVariantId) {
        router.push(`/video/${projectId}?tab=ecriture`);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Variantes</CardTitle>
        <CardDescription>
          Les déclinaisons de ce projet par plateforme et format. Une variante dérivée copie
          l&apos;intégralité du contenu de sa source.
        </CardDescription>
        <CardAction>
          <Button onClick={() => setDeriving(true)}><Plus aria-hidden /> Dériver une variante</Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        {variants.map((v) => (
          <span key={v.id} className="inline-flex items-center gap-1.5">
            <a href={`/video/${projectId}?tab=ecriture&variant=${v.id}`}>
              <Badge variant={v.id === activeVariantId ? "default" : "outline"}>
                {PLATFORM_LABEL[v.platform] ?? v.platform} · {v.aspectRatio}
              </Badge>
            </a>
            {v.derivedFromId !== null && (
              <Badge variant="secondary" className="text-xs">dérivée</Badge>
            )}
            {v.derivedFromId !== null && (
              <ConfirmDialog
                trigger={
                  <Button variant="ghost" size="sm" disabled={isDeleting}>
                    Supprimer
                  </Button>
                }
                title={`Supprimer la variante ${PLATFORM_LABEL[v.platform] ?? v.platform} ?`}
                description="Cette action est définitive et supprime tout le contenu propre à cette variante (beats, inserts)."
                confirmLabel="Supprimer"
                destructive
                onConfirm={() => handleDelete(v)}
              />
            )}
          </span>
        ))}
      </CardContent>

      <DeriveDialog
        open={deriving}
        projectId={projectId}
        sourceVariantId={activeVariantId}
        onClose={() => setDeriving(false)}
      />
    </Card>
  );
}

function DeriveDialog({
  open, projectId, sourceVariantId, onClose,
}: { open: boolean; projectId: string; sourceVariantId: string | null; onClose: () => void }) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSaving] = useTransition();
  // Réinitialisé à chaque ouverture — même garde que speakers-manager.tsx#SpeakerDialog.
  const [openedFor, setOpenedFor] = useState(false);
  if (open && !openedFor) {
    setOpenedFor(true);
    setForm(EMPTY);
    setError(null);
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      setOpenedFor(false);
      onClose();
    }
  }

  function handleSave() {
    if (!sourceVariantId) {
      setError("Aucune variante active à dériver.");
      toast.error("Aucune variante active à dériver.");
      return;
    }
    startSaving(async () => {
      const targetDurationSec = form.targetDurationSec.trim() === "" ? null : Number(form.targetDurationSec);
      const res = await deriveVariant({
        sourceVariantId,
        platform: form.platform,
        aspectRatio: form.aspectRatio,
        targetDurationSec,
      });
      if (!res.ok) { setError(res.message); toast.error(res.message); return; }
      toast.success("Variante dérivée.");
      handleOpenChange(false);
      router.push(`/video/${projectId}?tab=ecriture&variant=${res.variantId}`);
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Dériver une variante</DialogTitle>
          <DialogDescription>
            Copie le contenu de la variante active vers une nouvelle plateforme et un nouveau
            format.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="dv-platform">Plateforme</Label>
              <select
                id="dv-platform" value={form.platform} disabled={isSaving}
                onChange={(e) => setForm((f) => ({ ...f, platform: e.target.value }))}
                className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm"
              >
                {PLATFORMS.map((p) => (
                  <option key={p} value={p}>{PLATFORM_LABEL[p] ?? p}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dv-ratio">Format</Label>
              <select
                id="dv-ratio" value={form.aspectRatio} disabled={isSaving}
                onChange={(e) => setForm((f) => ({ ...f, aspectRatio: e.target.value }))}
                className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm"
              >
                {ASPECT_RATIOS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dv-duration">Durée cible en secondes (optionnelle)</Label>
            <Input
              id="dv-duration" type="number" min={5} max={14400} value={form.targetDurationSec}
              disabled={isSaving} placeholder="Ex. 60"
              onChange={(e) => setForm((f) => ({ ...f, targetDurationSec: e.target.value }))}
            />
          </div>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={isSaving}>Annuler</Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving && <Loader2 className="animate-spin" aria-hidden />}
            {isSaving ? "Dérivation…" : "Dériver"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
