"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ScheduleField } from "@/components/settings/schedule-field";
import { PageHeader } from "@/components/shell/page-header";
import { updatePipelineSettings } from "@/lib/actions/pipeline-settings-actions";
import { pipelineSettingsSchema } from "@/lib/validation";
import type { PipelineSettings } from "@/lib/queries/settings";

type FormState = {
  maxItemsPerRun: string;
  perOperationTimeoutMs: string;
  clusterThreshold: string;
  scoreThreshold: string;
  autoPublishEnabled: boolean;
  autoPublishMinSources: string;
  webSearchEnabled: boolean;
  scheduleCron: string;
  alertEmailEnabled: boolean;
  alertEmailRecipients: string;
  defaultMaxItemAgeHours: string;
};

function toFormState(settings: PipelineSettings): FormState {
  return {
    maxItemsPerRun: String(settings.maxItemsPerRun),
    perOperationTimeoutMs: String(settings.perOperationTimeoutMs),
    clusterThreshold: String(settings.clusterThreshold),
    scoreThreshold: String(settings.scoreThreshold),
    autoPublishEnabled: settings.autoPublishEnabled,
    autoPublishMinSources: String(settings.autoPublishMinSources),
    webSearchEnabled: settings.webSearchEnabled,
    scheduleCron: settings.scheduleCron ?? "",
    alertEmailEnabled: settings.alertEmailEnabled,
    alertEmailRecipients: settings.alertEmailRecipients ?? "",
    defaultMaxItemAgeHours: settings.defaultMaxItemAgeHours == null ? "" : String(settings.defaultMaxItemAgeHours),
  };
}

// Admin-only settings form for the pipeline_settings singleton (SP1). Only maxItemsPerRun is
// actually consumed by the pipeline yet (executeRun reads it from getPipelineSettings()) — the
// rest are stored + editable now so later sub-projects (SP2 schedule, SP4 web search/cluster
// cross-check, SP5 timeout, SP6 auto-publish) can wire them without another settings UI pass.
export function PipelineSettingsForm({ settings }: { settings: PipelineSettings }) {
  const [form, setForm] = useState<FormState>(toFormState(settings));
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSaving] = useTransition();

  function handleSave() {
    const payload = {
      maxItemsPerRun: Number(form.maxItemsPerRun),
      perOperationTimeoutMs: Number(form.perOperationTimeoutMs),
      clusterThreshold: Number(form.clusterThreshold),
      scoreThreshold: Number(form.scoreThreshold),
      autoPublishEnabled: form.autoPublishEnabled,
      autoPublishMinSources: Number(form.autoPublishMinSources),
      webSearchEnabled: form.webSearchEnabled,
      scheduleCron: form.scheduleCron,
      alertEmailEnabled: form.alertEmailEnabled,
      alertEmailRecipients: form.alertEmailRecipients,
      defaultMaxItemAgeHours: form.defaultMaxItemAgeHours.trim() === "" ? null : Number(form.defaultMaxItemAgeHours),
    };
    const validated = pipelineSettingsSchema.safeParse(payload);
    if (!validated.success) {
      setError(validated.error.issues[0]?.message ?? "Entrée invalide");
      return;
    }
    setError(null);
    startSaving(async () => {
      try {
        await updatePipelineSettings(validated.data);
        toast.success("Paramètres enregistrés.");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Échec de l'enregistrement.";
        setError(message);
        toast.error(message);
      }
    });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Pipeline" />

      <Card>
        <CardHeader>
          <CardTitle>Exécution</CardTitle>
          <CardDescription>
            Contrôle le volume et le rythme de chaque exécution du pipeline.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="max-items">Nombre max d&apos;éléments par exécution</Label>
            <Input
              id="max-items" type="number" min={1} disabled={isSaving}
              value={form.maxItemsPerRun}
              onChange={(e) => setForm((f) => ({ ...f, maxItemsPerRun: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="default-recency">Récence par défaut (heures)</Label>
            <Input
              id="default-recency" type="number" min={1} max={720} disabled={isSaving}
              value={form.defaultMaxItemAgeHours}
              placeholder="Aucune limite"
              onChange={(e) => setForm((f) => ({ ...f, defaultMaxItemAgeHours: e.target.value }))}
            />
            <p className="text-xs text-muted-foreground">
              Vide = aucune limite. Pré-remplit la fenêtre de récence au lancement d&apos;une exécution ; appliquée aussi aux exécutions planifiées.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="timeout-ms">Délai max par opération (ms)</Label>
            <Input
              id="timeout-ms" type="number" min={1} disabled={isSaving}
              value={form.perOperationTimeoutMs}
              onChange={(e) => setForm((f) => ({ ...f, perOperationTimeoutMs: e.target.value }))}
            />
            <p className="text-xs text-muted-foreground">Chaque opération du pipeline est interrompue si elle dépasse ce délai (minimum 5 s).</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cluster-threshold">Seuil de similarité de cluster</Label>
            <Input
              id="cluster-threshold" type="number" min={0} max={1} step={0.01} disabled={isSaving}
              value={form.clusterThreshold}
              onChange={(e) => setForm((f) => ({ ...f, clusterThreshold: e.target.value }))}
            />
            <p className="text-xs text-muted-foreground">Entre 0 et 1. Plus la valeur est élevée, plus le regroupement des sujets similaires est strict.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Publication automatique</CardTitle>
          <CardDescription>
            Exception contrôlée à la revue humaine, désactivée par défaut. Chaque publication
            automatique est consignée dans l'historique de l'article.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <Label htmlFor="auto-publish">Publication automatique</Label>
            <Switch
              id="auto-publish" checked={form.autoPublishEnabled} disabled={isSaving}
              onCheckedChange={(checked) => setForm((f) => ({ ...f, autoPublishEnabled: checked }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="score-threshold">Seuil de score minimum</Label>
            <Input
              id="score-threshold" type="number" min={0} max={100} disabled={isSaving}
              value={form.scoreThreshold}
              onChange={(e) => setForm((f) => ({ ...f, scoreThreshold: e.target.value }))}
            />
            <p className="text-xs text-muted-foreground">Entre 0 et 100.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="min-sources">Nombre min de sources</Label>
            <Input
              id="min-sources" type="number" min={1} disabled={isSaving}
              value={form.autoPublishMinSources}
              onChange={(e) => setForm((f) => ({ ...f, autoPublishMinSources: e.target.value }))}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recherche web</CardTitle>
          <CardDescription>Enrichit les articles avec des sources web externes corroborantes.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <Label htmlFor="web-search">Recherche web</Label>
            <Switch
              id="web-search" checked={form.webSearchEnabled} disabled={isSaving}
              onCheckedChange={(checked) => setForm((f) => ({ ...f, webSearchEnabled: checked }))}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Planification</CardTitle>
          <CardDescription>Déclenche automatiquement le pipeline selon une planification cron.</CardDescription>
        </CardHeader>
        <CardContent>
          <ScheduleField
            value={form.scheduleCron}
            disabled={isSaving}
            onChange={(cron) => setForm((f) => ({ ...f, scheduleCron: cron }))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Alertes</CardTitle>
          <CardDescription>
            Alerte l'équipe en cas d'échec d'exécution ou de flux muet. Toujours visible dans le
            bandeau de notifications de l'application ; l'e-mail est une option supplémentaire.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <Label htmlFor="alert-email-enabled">Notification par e-mail</Label>
            <Switch
              id="alert-email-enabled" checked={form.alertEmailEnabled} disabled={isSaving}
              onCheckedChange={(checked) => setForm((f) => ({ ...f, alertEmailEnabled: checked }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="alert-email-recipients">Destinataires (séparés par des virgules)</Label>
            <Input
              id="alert-email-recipients" disabled={isSaving}
              value={form.alertEmailRecipients}
              onChange={(e) => setForm((f) => ({ ...f, alertEmailRecipients: e.target.value }))}
              placeholder="admin@afrotiative.com, editeur@afrotiative.com"
            />
            <p className="text-xs text-muted-foreground">
              L'e-mail nécessite RESEND_API_KEY côté serveur.
            </p>
          </div>
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
