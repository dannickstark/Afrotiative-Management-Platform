"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/shell/empty-state";
import {
  createVideoCategory, updateVideoCategory, deleteVideoCategory,
} from "@/lib/actions/video-category-actions";
import type { VideoCategoryRow } from "@/lib/queries/video-categories";

type FormState = { name: string; description: string; instructions: string; position: string };

const EMPTY: FormState = { name: "", description: "", instructions: "", position: "0" };

// Les catégories de vidéo : le savoir d'un expert, écrit une fois, injecté dans le brief de chaque
// projet rattaché. Édité ici parce que c'est un acte de configuration (permission video/configure),
// pas de rédaction.
export function CategoryManager({ categories }: { categories: VideoCategoryRow[] }) {
  const [editing, setEditing] = useState<VideoCategoryRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<VideoCategoryRow | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Catégories de vidéo</CardTitle>
        <CardDescription>
          Les instructions propres à un type de vidéo — storytelling, interview, investigation…
          Elles sont ajoutées automatiquement au brief de chaque projet rattaché.
        </CardDescription>
        <CardAction>
          <Button onClick={() => setCreating(true)}><Plus aria-hidden /> Nouvelle catégorie</Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {categories.length === 0 ? (
          <EmptyState
            title="Aucune catégorie"
            hint="Créez une catégorie par type de vidéo et confiez ses instructions à la personne qui maîtrise ce format. Les rédacteurs n'auront plus qu'à choisir la catégorie."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nom</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Instructions</TableHead>
                <TableHead className="text-right">Projets</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {categories.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="text-muted-foreground">{c.description ?? "—"}</TableCell>
                  <TableCell className="max-w-md truncate text-muted-foreground">{c.instructions}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.projectCount}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" aria-label={`Modifier ${c.name}`} onClick={() => setEditing(c)}>
                      <Pencil aria-hidden />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={`Supprimer ${c.name}`} onClick={() => setDeleting(c)}>
                      <Trash2 aria-hidden />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <CategoryDialog
        open={creating || editing !== null}
        category={editing}
        onClose={() => { setCreating(false); setEditing(null); }}
      />
      <DeleteDialog category={deleting} onClose={() => setDeleting(null)} />
    </Card>
  );
}

function CategoryDialog({
  open, category, onClose,
}: { open: boolean; category: VideoCategoryRow | null; onClose: () => void }) {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSaving] = useTransition();
  // Réinitialisé à chaque ouverture : le dialogue sert alternativement à créer et à éditer, et un
  // état résiduel afficherait les instructions de la catégorie précédente.
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const key = category?.id ?? "__new__";
  if (open && openedFor !== key) {
    setOpenedFor(key);
    setForm(category
      ? {
          name: category.name, description: category.description ?? "",
          instructions: category.instructions, position: String(category.position),
        }
      : EMPTY);
    setError(null);
  }

  // Point de sortie UNIQUE du dialogue — le bouton « Annuler » passe par ici plutôt que d'appeler
  // `onClose` directement, pour ne jamais court-circuiter la remise à zéro de `openedFor` : sans
  // cela, ré-ouvrir la même catégorie après un « Annuler » sauterait la garde de réinitialisation
  // (`openedFor === key`) et réafficherait le brouillon annulé au lieu des données réelles. Même
  // motif que `handleOpenChange` dans components/settings/add-member-dialog.tsx.
  function handleOpenChange(next: boolean) {
    if (!next) {
      setOpenedFor(null);
      onClose();
    }
  }

  function handleSave() {
    const payload = {
      name: form.name,
      description: form.description.trim() || null,
      instructions: form.instructions,
      position: Number(form.position) || 0,
    };
    startSaving(async () => {
      try {
        const res = category
          ? await updateVideoCategory({ ...payload, id: category.id })
          : await createVideoCategory(payload);
        if (!res.ok) { setError(res.message); toast.error(res.message); return; }
        toast.success(category ? "Catégorie modifiée." : "Catégorie créée.");
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
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{category ? "Modifier la catégorie" : "Nouvelle catégorie"}</DialogTitle>
          <DialogDescription>
            Les instructions sont reprises telles quelles dans le brief, sous le titre
            « Instructions de la catégorie ».
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="cat-name">Nom</Label>
              <Input
                id="cat-name" value={form.name} disabled={isSaving} placeholder="Ex. Investigation"
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cat-position">Ordre</Label>
              <Input
                id="cat-position" type="number" min={0} max={999} value={form.position} disabled={isSaving}
                onChange={(e) => setForm((f) => ({ ...f, position: e.target.value }))}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cat-description">Description (optionnelle)</Label>
            <Input
              id="cat-description" value={form.description} disabled={isSaving}
              placeholder="Ce qui aide un rédacteur à choisir cette catégorie"
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cat-instructions">Instructions</Label>
            <Textarea
              id="cat-instructions" rows={14} value={form.instructions} disabled={isSaving}
              placeholder="Les consignes que le modèle doit suivre pour ce type de vidéo."
              onChange={(e) => setForm((f) => ({ ...f, instructions: e.target.value }))}
            />
          </div>
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

function DeleteDialog({ category, onClose }: { category: VideoCategoryRow | null; onClose: () => void }) {
  const [isDeleting, startDeleting] = useTransition();

  function handleDelete() {
    if (!category) return;
    startDeleting(async () => {
      const res = await deleteVideoCategory({ id: category.id });
      if (!res.ok) { toast.error(res.message); return; }
      toast.success("Catégorie supprimée.");
      onClose();
    });
  }

  return (
    <Dialog open={category !== null} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Supprimer « {category?.name} » ?</DialogTitle>
          <DialogDescription>
            {category && category.projectCount > 0
              ? `${category.projectCount} projet${category.projectCount > 1 ? "s" : ""} retombera${category.projectCount > 1 ? "ont" : ""} sur « aucune catégorie ». Aucun projet n'est supprimé.`
              : "Aucun projet n'utilise cette catégorie."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={isDeleting}>Annuler</Button>
          <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
            {isDeleting && <Loader2 className="animate-spin" aria-hidden />}
            Supprimer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
