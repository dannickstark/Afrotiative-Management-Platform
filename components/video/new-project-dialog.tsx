"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createVideoProject } from "@/lib/actions/video-actions";
import { PLATFORM_LABEL } from "@/components/video/project-list";

const PLATFORMS = ["youtube_long", "youtube_short", "tiktok", "reel", "interview"] as const;
const RATIOS = ["16:9", "9:16", "1:1"] as const;

type FormState = {
  title: string;
  subject: string;
  platform: (typeof PLATFORMS)[number];
  targetDurationMin: string;
  aspectRatio: (typeof RATIOS)[number];
  articleId: string;
};

const EMPTY: FormState = {
  title: "", subject: "", platform: "youtube_long", targetDurationMin: "",
  aspectRatio: "16:9", articleId: "",
};

const NO_ARTICLE = "__none__";

// Client Component — porte son propre déclencheur (motif AddMemberDialog). `articles` : les
// articles `approved`/`published` proposés comme source optionnelle du projet (Task 10).
export function NewProjectDialog({ articles }: { articles: { id: string; title: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSaving] = useTransition();

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setForm(EMPTY);
      setError(null);
    }
  }

  function handleCreate() {
    if (!form.title.trim()) {
      setError("Titre requis.");
      return;
    }
    setError(null);
    const targetDurationSec = form.targetDurationMin.trim()
      ? Math.round(Number(form.targetDurationMin) * 60)
      : null;

    startSaving(async () => {
      try {
        const res = await createVideoProject({
          title: form.title,
          subject: form.subject.trim() || null,
          platform: form.platform,
          targetDurationSec,
          aspectRatio: form.aspectRatio,
          articleId: form.articleId && form.articleId !== NO_ARTICLE ? form.articleId : null,
        });
        if (!res.ok) {
          setError(res.message ?? "Échec de la création du projet.");
          toast.error(res.message ?? "Échec de la création du projet.");
          return;
        }
        toast.success("Projet créé.");
        setOpen(false);
        router.push(`/video/${res.id}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Échec de la création du projet.";
        setError(message);
        toast.error(message);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button><Plus aria-hidden /> Nouvelle vidéo</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nouveau projet vidéo</DialogTitle>
          <DialogDescription>
            Le brief se construira à partir de ces informations — vous pourrez tout ajuster ensuite.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="project-title">Titre</Label>
            <Input
              id="project-title" value={form.title} disabled={isSaving}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="Ex. La success story de Babadampulu"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-subject">Sujet / angle</Label>
            <Textarea
              id="project-subject" value={form.subject} disabled={isSaving}
              onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
              placeholder="Ce que la vidéo doit démontrer ou raconter"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="project-platform">Plateforme</Label>
              <Select
                value={form.platform}
                onValueChange={(v) => setForm((f) => ({ ...f, platform: v as FormState["platform"] }))}
                disabled={isSaving}
              >
                <SelectTrigger id="project-platform" className="w-full">
                  <SelectValue placeholder="Plateforme" />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map((p) => (
                    <SelectItem key={p} value={p}>{PLATFORM_LABEL[p]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="project-ratio">Cadrage</Label>
              <Select
                value={form.aspectRatio}
                onValueChange={(v) => setForm((f) => ({ ...f, aspectRatio: v as FormState["aspectRatio"] }))}
                disabled={isSaving}
              >
                <SelectTrigger id="project-ratio" className="w-full">
                  <SelectValue placeholder="Cadrage" />
                </SelectTrigger>
                <SelectContent>
                  {RATIOS.map((r) => (
                    <SelectItem key={r} value={r}>{r}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-duration">Durée cible (minutes)</Label>
            <Input
              id="project-duration" type="number" min={0} step={0.5} value={form.targetDurationMin} disabled={isSaving}
              onChange={(e) => setForm((f) => ({ ...f, targetDurationMin: e.target.value }))}
              placeholder="Ex. 12"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-article">Article source (optionnel)</Label>
            <Select
              value={form.articleId || NO_ARTICLE}
              onValueChange={(v) => setForm((f) => ({ ...f, articleId: !v || v === NO_ARTICLE ? "" : v }))}
              disabled={isSaving}
            >
              <SelectTrigger id="project-article" className="w-full">
                <SelectValue placeholder="Aucun article" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_ARTICLE}>Aucun article</SelectItem>
                {articles.map((a) => (
                  <SelectItem key={a.id} value={a.id}>{a.title}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={isSaving}>Annuler</Button>
          <Button onClick={handleCreate} disabled={isSaving}>
            {isSaving && <Loader2 className="animate-spin" aria-hidden />}
            {isSaving ? "Création…" : "Créer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
