"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Check, Copy, Loader2, Plus } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { addMember } from "@/lib/actions/team-actions";
import { validateMemberInput } from "@/lib/validation";
import { ROLE_LABEL } from "@/lib/rbac";
import type { Role } from "@/lib/auth";

type FormState = { email: string; name: string; role: Role };
const EMPTY: FormState = { email: "", name: "", role: "journalist" };
const ROLES: Role[] = ["journalist", "editor", "admin"];

// Self-contained Dialog (owns its own trigger + open state), mirroring ConfirmDialog's pattern —
// unlike FeedSheet, this component has no "edit" mode to coordinate with a parent, so it doesn't
// need externally-controlled open state.
export function AddMemberDialog() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null); // set once on success, shown once
  const [copied, setCopied] = useState(false);
  const [isSaving, startSaving] = useTransition();

  function reset() {
    setForm(EMPTY);
    setError(null);
    setTempPassword(null);
    setCopied(false);
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    // Closing (either via "Fermer" or the dialog's own close affordances) drops the temp password
    // from component state for good — it is never re-shown after this point, per spec.
    if (!next) reset();
  }

  function handleSave() {
    const validated = validateMemberInput(form);
    if (!validated.ok) {
      setError(validated.message);
      return;
    }
    setError(null);
    startSaving(async () => {
      try {
        const res = await addMember(validated.data);
        if (!res.ok) {
          setError(res.message ?? "Échec de l'ajout du membre.");
          toast.error(res.message ?? "Échec de l'ajout du membre.");
          return;
        }
        setTempPassword(res.tempPassword);
        toast.success("Membre ajouté.");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Échec de l'ajout du membre.";
        setError(message);
        toast.error(message);
      }
    });
  }

  async function handleCopy() {
    if (!tempPassword) return;
    await navigator.clipboard.writeText(tempPassword);
    setCopied(true);
    toast.success("Mot de passe copié.");
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button><Plus aria-hidden /> Ajouter un membre</Button>} />
      <DialogContent className="sm:max-w-md">
        {tempPassword ? (
          <>
            <DialogHeader>
              <DialogTitle>Membre ajouté</DialogTitle>
              <DialogDescription>
                Communiquez ce mot de passe au membre — il ne sera plus affiché après la fermeture de cette fenêtre.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="temp-password">Mot de passe temporaire</Label>
              <div className="flex gap-2">
                <Input id="temp-password" readOnly value={tempPassword} className="font-mono" onFocus={(e) => e.currentTarget.select()} />
                <Button type="button" variant="outline" size="icon" onClick={handleCopy} aria-label="Copier le mot de passe">
                  {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                </Button>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => handleOpenChange(false)}>Fermer</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Ajouter un membre</DialogTitle>
              <DialogDescription>Un mot de passe temporaire sera généré ; vous devrez le communiquer vous-même au membre.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="member-name">Nom</Label>
                <Input
                  id="member-name" value={form.name} disabled={isSaving}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Ex. Awa Diallo"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="member-email">Email</Label>
                <Input
                  id="member-email" type="email" value={form.email} disabled={isSaving}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="prenom.nom@afrotiative.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="member-role">Rôle</Label>
                <Select value={form.role} onValueChange={(v) => setForm((f) => ({ ...f, role: v as Role }))} disabled={isSaving}>
                  <SelectTrigger id="member-role" className="w-full">
                    <SelectValue placeholder="Rôle">{(v: Role) => ROLE_LABEL[v]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.map((r) => (
                      <SelectItem key={r} value={r}>{ROLE_LABEL[r]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={isSaving}>Annuler</Button>
              <Button onClick={handleSave} disabled={isSaving}>
                {isSaving && <Loader2 className="animate-spin" aria-hidden />}
                {isSaving ? "Ajout…" : "Ajouter"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
