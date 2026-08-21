"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, Trash2, ShieldAlert, ShieldCheck } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/shell/empty-state";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { createSpeaker, updateSpeaker, deleteSpeaker } from "@/lib/actions/video-actions";
import type { SpeakerRow } from "@/lib/queries/video";

type FormState = { name: string; role: string; consentGiven: boolean; consentNote: string };

const EMPTY: FormState = { name: "", role: "", consentGiven: false, consentNote: "" };

// Les intervenants d'un projet en mode interview (SP5) : leur consentement conditionne le passage
// en montage (Task 3, garde côté serveur) — d'où le bandeau d'avertissement ici, qui rend la
// contrainte visible AVANT que l'écriture ne la découvre en butant sur le refus. Revalidate-only
// (pas de router.refresh) : même motif que category-manager.tsx, la page projet est déjà rendue
// côté serveur et se recharge via revalidatePath (video-actions.ts#revalidateVideo).
export function SpeakersManager({ projectId, speakers }: { projectId: string; speakers: SpeakerRow[] }) {
  const [editing, setEditing] = useState<SpeakerRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [isToggling, startToggling] = useTransition();
  const [isDeleting, startDeleting] = useTransition();

  function handleDelete(s: SpeakerRow) {
    startDeleting(async () => {
      const res = await deleteSpeaker({ speakerId: s.id });
      if (!res.ok) { toast.error(res.message); return; }
      toast.success("Intervenant supprimé.");
    });
  }

  const missingConsent = speakers.filter((s) => !s.consentGiven).length;

  function handleToggleConsent(s: SpeakerRow) {
    startToggling(async () => {
      const res = await updateSpeaker({ speakerId: s.id, consentGiven: !s.consentGiven });
      if (!res.ok) { toast.error(res.message); return; }
      toast.success(s.consentGiven ? "Consentement retiré." : "Consentement enregistré.");
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Intervenants</CardTitle>
        <CardDescription>
          Les personnes interviewées pour ce projet. Leur consentement est requis avant la mise en
          montage.
        </CardDescription>
        <CardAction>
          <Button onClick={() => setCreating(true)}><Plus aria-hidden /> Nouvel intervenant</Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {missingConsent > 0 && (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {missingConsent} intervenant(s) sans consentement — la mise en montage sera bloquée.
          </p>
        )}
        {speakers.length === 0 ? (
          <EmptyState
            title="Aucun intervenant"
            hint="Ajoutez chaque personne interviewée pour ce projet et suivez son consentement."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nom</TableHead>
                <TableHead>Rôle</TableHead>
                <TableHead>Consentement</TableHead>
                <TableHead>Note</TableHead>
                <TableHead className="w-32" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {speakers.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell className="text-muted-foreground">{s.role ?? "—"}</TableCell>
                  <TableCell>
                    <Button
                      type="button" variant="ghost" size="sm" disabled={isToggling}
                      onClick={() => handleToggleConsent(s)}
                      aria-label={s.consentGiven ? `Retirer le consentement de ${s.name}` : `Enregistrer le consentement de ${s.name}`}
                    >
                      {s.consentGiven ? (
                        <Badge variant="outline" className="bg-[var(--status-approved)]/15 text-[var(--status-approved)] border-[var(--status-approved)]/30">
                          <ShieldCheck aria-hidden /> Consentement OK
                        </Badge>
                      ) : (
                        <Badge variant="destructive">
                          <ShieldAlert aria-hidden /> Sans consentement
                        </Badge>
                      )}
                    </Button>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <span className="block max-w-xs truncate">{s.consentNote ?? "—"}</span>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" aria-label={`Modifier ${s.name}`} onClick={() => setEditing(s)}>
                      <Pencil aria-hidden />
                    </Button>
                    <ConfirmDialog
                      trigger={
                        <Button variant="ghost" size="icon" aria-label={`Supprimer ${s.name}`} disabled={isDeleting}>
                          <Trash2 aria-hidden />
                        </Button>
                      }
                      title={`Supprimer « ${s.name} » ?`}
                      description="Cette action est définitive. Les beats qui lui étaient rattachés perdront leur intervenant mais ne sont pas supprimés."
                      confirmLabel="Supprimer"
                      destructive
                      onConfirm={() => handleDelete(s)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <SpeakerDialog
        open={creating || editing !== null}
        projectId={projectId}
        speaker={editing}
        onClose={() => { setCreating(false); setEditing(null); }}
      />
    </Card>
  );
}

function SpeakerDialog({
  open, projectId, speaker, onClose,
}: { open: boolean; projectId: string; speaker: SpeakerRow | null; onClose: () => void }) {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSaving] = useTransition();
  // Réinitialisé à chaque ouverture — même garde que category-manager.tsx#CategoryDialog : le
  // dialogue sert alternativement à créer et à éditer, un état résiduel afficherait l'intervenant
  // précédemment édité.
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const key = speaker?.id ?? "__new__";
  if (open && openedFor !== key) {
    setOpenedFor(key);
    setForm(speaker
      ? {
          name: speaker.name, role: speaker.role ?? "",
          consentGiven: speaker.consentGiven, consentNote: speaker.consentNote ?? "",
        }
      : EMPTY);
    setError(null);
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      setOpenedFor(null);
      onClose();
    }
  }

  function handleSave() {
    startSaving(async () => {
      try {
        const res = speaker
          ? await updateSpeaker({
              speakerId: speaker.id,
              name: form.name,
              role: form.role.trim() || null,
              consentGiven: form.consentGiven,
              consentNote: form.consentNote.trim() || null,
            })
          : await createSpeaker({ projectId, name: form.name, role: form.role.trim() || null });
        if (!res.ok) { setError(res.message); toast.error(res.message); return; }
        toast.success(speaker ? "Intervenant modifié." : "Intervenant créé.");
        handleOpenChange(false);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Échec de l'enregistrement.";
        setError(message);
        toast.error(message);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{speaker ? "Modifier l'intervenant" : "Nouvel intervenant"}</DialogTitle>
          <DialogDescription>
            Le consentement conditionne le passage en montage : sans lui, le projet reste bloqué.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="sp-name">Nom</Label>
              <Input
                id="sp-name" value={form.name} disabled={isSaving} placeholder="Ex. Awa Koné"
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sp-role">Rôle (optionnel)</Label>
              <Input
                id="sp-role" value={form.role} disabled={isSaving} placeholder="Ex. Témoin"
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
              />
            </div>
          </div>
          {speaker && (
            <>
              <div className="flex items-center gap-2">
                <input
                  id="sp-consent" type="checkbox" checked={form.consentGiven} disabled={isSaving}
                  onChange={(e) => setForm((f) => ({ ...f, consentGiven: e.target.checked }))}
                  className="size-4"
                />
                <Label htmlFor="sp-consent">Consentement donné</Label>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sp-note">Note de consentement (optionnelle)</Label>
                <Textarea
                  id="sp-note" rows={3} value={form.consentNote} disabled={isSaving}
                  placeholder="Ex. Consentement oral recueilli le 12 août, écrit à venir."
                  onChange={(e) => setForm((f) => ({ ...f, consentNote: e.target.value }))}
                />
              </div>
            </>
          )}
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={isSaving}>Annuler</Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving && <Loader2 className="animate-spin" aria-hidden />}
            {isSaving ? "Enregistrement…" : "Enregistrer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

