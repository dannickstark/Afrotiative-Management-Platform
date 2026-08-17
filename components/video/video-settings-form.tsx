"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { saveVideoSettings } from "@/lib/actions/video-settings-actions";
import { videoSettingsSchema } from "@/lib/validation";

type VideoSettings = { briefTemplate: string; wordsPerMinute: number };

type FormState = { briefTemplate: string; wordsPerMinute: string };

function toFormState(settings: VideoSettings): FormState {
  return { briefTemplate: settings.briefTemplate, wordsPerMinute: String(settings.wordsPerMinute) };
}

// Les variables reconnues par lib/video/brief.ts's BriefVars — listées ici comme simple aide
// mémoire, pas comme validation (une variable oubliée n'empêche pas d'enregistrer le modèle).
const BRIEF_VARS = [
  "{{titre}}", "{{sujet}}", "{{plateforme}}", "{{duree_cible}}", "{{ratio}}",
  "{{article_titre}}", "{{article_url}}", "{{article_extrait}}",
];

export function VideoSettingsForm({ settings }: { settings: VideoSettings }) {
  const [form, setForm] = useState<FormState>(toFormState(settings));
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSaving] = useTransition();

  function handleSave() {
    const payload = {
      briefTemplate: form.briefTemplate,
      wordsPerMinute: Number(form.wordsPerMinute),
    };
    const validated = videoSettingsSchema.safeParse(payload);
    if (!validated.success) {
      setError(validated.error.issues[0]?.message ?? "Entrée invalide");
      return;
    }
    setError(null);
    startSaving(async () => {
      try {
        const result = await saveVideoSettings(validated.data);
        if (!result.ok) {
          setError(result.message);
          toast.error(result.message);
          return;
        }
        toast.success("Paramètres enregistrés.");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Échec de l'enregistrement.";
        setError(message);
        toast.error(message);
      }
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Modèle de brief</CardTitle>
          <CardDescription>
            Le style maison collé en tête du brief envoyé au chat. Les instructions de recherche et
            le contrat de sortie sont ajoutés automatiquement, non modifiables ici.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1.5">
          <Label htmlFor="brief-template">Modèle</Label>
          <Textarea
            id="brief-template" rows={16} disabled={isSaving}
            value={form.briefTemplate}
            onChange={(e) => setForm((f) => ({ ...f, briefTemplate: e.target.value }))}
          />
          <p className="text-xs text-muted-foreground">
            Variables disponibles : {BRIEF_VARS.join(", ")}.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cadence de lecture</CardTitle>
          <CardDescription>
            Utilisée pour estimer la durée parlée d&apos;un beat à partir de son nombre de mots.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1.5">
          <Label htmlFor="wpm">Mots par minute</Label>
          <Input
            id="wpm" type="number" min={60} max={400} disabled={isSaving}
            value={form.wordsPerMinute}
            onChange={(e) => setForm((f) => ({ ...f, wordsPerMinute: e.target.value }))}
          />
        </CardContent>
        <CardFooter className="flex-col items-stretch gap-3">
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <Button onClick={handleSave} disabled={isSaving} className="self-end">
            {isSaving && <Loader2 className="animate-spin" aria-hidden />}
            {isSaving ? "Enregistrement…" : "Enregistrer"}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
