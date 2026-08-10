"use client";
// components/settings/social-channel-form.tsx — Task 7 (D1 §6): the /settings/social/[channel]
// detail form. Admin-only (the page itself gates on social:manage before this ever renders).
//
// captionMaxChars's bounds are ALWAYS taken from the `captionLimits` prop (the channel's registry
// entry, lib/diffusion/channels.ts — SOCIAL_CHANNELS[channel].captionLimits), never a literal
// number written here: a different channel has a different ceiling (Facebook 63206 vs X 280), and
// the brief is explicit that the bounds must be SHOWN, not just enforced silently. The actual
// authoritative check still happens server-side (updateChannelSettingsCore) — this form's min/max
// attributes and helper text are a UX nicety, not the source of truth.
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { formatDate } from "@/lib/format";
import { updateChannelSettings, updateChannelCredentials, deleteChannelCredentials } from "@/lib/actions/diffusion-settings-actions";
import type { Channel } from "@/lib/studio";
import type { SocialChannelSettings } from "@/lib/diffusion/settings-core";

export type CredentialField = { key: string; label: string };

export type CaptionLimits = { min: number; max: number; default: number };

type FormState = {
  enabled: boolean;
  captionMaxChars: string;
  captionPrompt: string;
  autoEnabled: boolean;
  autoIntervalHours: string;
  autoMaxBacklogDays: string;
  autoWindowStartHour: string;
  autoWindowEndHour: string;
};

function toFormState(settings: SocialChannelSettings): FormState {
  return {
    enabled: settings.enabled,
    captionMaxChars: String(settings.captionMaxChars),
    captionPrompt: settings.captionPrompt ?? "",
    autoEnabled: settings.autoEnabled,
    autoIntervalHours: String(settings.autoIntervalHours),
    autoMaxBacklogDays: String(settings.autoMaxBacklogDays),
    autoWindowStartHour: String(settings.autoWindowStartHour),
    autoWindowEndHour: String(settings.autoWindowEndHour),
  };
}

export function SocialChannelForm({
  channel, label, captionLimits, settings, credentialFields = [],
}: {
  channel: Channel;
  label: string;
  captionLimits: CaptionLimits;
  settings: SocialChannelSettings;
  // Task 1 (D2+D3) — which credential inputs to show, driven by SOCIAL_CHANNELS[channel]
  // .credentialFields (lib/diffusion/channels.ts), NOT hard-coded here: a channel with an empty
  // array (WhatsApp today) renders no credentials card at all. Optional/defaulted to `[]` so a
  // caller that hasn't wired credentials for a given channel yet doesn't have to pass anything.
  credentialFields?: readonly CredentialField[];
}) {
  const [form, setForm] = useState<FormState>(toFormState(settings));
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSaving] = useTransition();

  // `credentialValues` holds ONLY what the admin is currently typing — write-only by construction:
  // it is NEVER initialized from `settings` (there is nothing to initialize it from; the decrypted
  // value never reaches this component in the first place, see settings-core.ts's own comment on
  // why), and is reset to `{}` after every successful save/delete so a value that was just typed
  // is never redisplayed. `credentialsSetAt` starts from the settings row and is updated locally
  // from each guarded action's own (sanitized) return value, so the "Défini le …" / "Non défini"
  // status reflects the latest save without a full page reload.
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({});
  const [credentialsSetAt, setCredentialsSetAt] = useState<Date | null>(settings.credentialsSetAt);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [isSavingCredentials, startSavingCredentials] = useTransition();

  function handleSave() {
    const captionMaxChars = Number(form.captionMaxChars);
    const autoIntervalHours = Number(form.autoIntervalHours);
    const autoMaxBacklogDays = Number(form.autoMaxBacklogDays);
    const autoWindowStartHour = Number(form.autoWindowStartHour);
    const autoWindowEndHour = Number(form.autoWindowEndHour);

    if (![captionMaxChars, autoIntervalHours, autoMaxBacklogDays, autoWindowStartHour, autoWindowEndHour].every(Number.isFinite)) {
      setError("Entrée invalide — vérifiez les champs numériques.");
      return;
    }
    if (autoWindowStartHour < 0 || autoWindowStartHour > 23 || autoWindowEndHour < 0 || autoWindowEndHour > 23) {
      setError("La fenêtre horaire doit être comprise entre 0 et 23.");
      return;
    }
    if (autoIntervalHours <= 0 || autoMaxBacklogDays <= 0) {
      setError("L'intervalle et la profondeur de rattrapage doivent être positifs.");
      return;
    }

    setError(null);
    startSaving(async () => {
      try {
        const res = await updateChannelSettings(channel, {
          enabled: form.enabled,
          captionMaxChars,
          captionPrompt: form.captionPrompt.trim() === "" ? null : form.captionPrompt,
          autoEnabled: form.autoEnabled,
          autoIntervalHours,
          autoMaxBacklogDays,
          autoWindowStartHour,
          autoWindowEndHour,
        });
        if (!res.ok) {
          setError(res.message);
          toast.error(res.message);
          return;
        }
        toast.success(`Réglages ${label} enregistrés.`);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Échec de l'enregistrement.";
        setError(message);
        toast.error(message);
      }
    });
  }

  // Only the fields the admin actually TYPED SOMETHING into are sent — an untouched field keeps
  // whatever was already stored server-side (setChannelCredentialsCore's merge semantics,
  // lib/diffusion/settings-core.ts), matching what a write-only, never-pre-filled input can
  // actually mean by "left blank" (there is no way to distinguish "unchanged" from "clear this one
  // field" from an empty input alone — that ambiguity is exactly why "Supprimer" is a separate,
  // explicit, whole-channel action rather than "save an empty field").
  function handleSaveCredentials() {
    const values = Object.fromEntries(
      Object.entries(credentialValues).filter(([, v]) => v.trim() !== ""),
    );
    if (Object.keys(values).length === 0) {
      setCredentialError("Aucun identifiant à enregistrer.");
      return;
    }
    setCredentialError(null);
    startSavingCredentials(async () => {
      try {
        const res = await updateChannelCredentials(channel, values);
        if (!res.ok) {
          setCredentialError(res.message);
          toast.error(res.message);
          return;
        }
        setCredentialsSetAt(res.settings.credentialsSetAt);
        setCredentialValues({}); // write-only: never keep what was just typed, saved or not
        toast.success(`Identifiants ${label} enregistrés.`);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Échec de l'enregistrement.";
        setCredentialError(message);
        toast.error(message);
      }
    });
  }

  async function handleDeleteCredentials() {
    try {
      const res = await deleteChannelCredentials(channel);
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      setCredentialsSetAt(res.settings.credentialsSetAt);
      setCredentialValues({});
      toast.success(`Identifiants ${label} supprimés.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Échec de la suppression.");
    }
  }

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">{label}</h1>

      <Card>
        <CardHeader>
          <CardTitle>Diffusion</CardTitle>
          <CardDescription>Autorise ou coupe la diffusion manuelle et automatique sur ce canal.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <Label htmlFor="channel-enabled">Canal activé</Label>
            <Switch
              id="channel-enabled" checked={form.enabled} disabled={isSaving}
              onCheckedChange={(checked) => setForm((f) => ({ ...f, enabled: checked }))}
            />
          </div>
        </CardContent>
      </Card>

      {credentialFields.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Identifiants</CardTitle>
            <CardDescription>
              {credentialsSetAt ? `Défini le ${formatDate(credentialsSetAt)}.` : "Non défini."}{" "}
              Les champs ci-dessous n&apos;affichent jamais la valeur enregistrée — ils ne servent
              qu&apos;à écrire une nouvelle valeur, qui remplace l&apos;ancienne dès l&apos;enregistrement.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {credentialFields.map((f) => (
              <div key={f.key} className="space-y-1.5">
                <Label htmlFor={`cred-${f.key}`}>{f.label}</Label>
                <Input
                  id={`cred-${f.key}`} type="password" autoComplete="off" disabled={isSavingCredentials}
                  value={credentialValues[f.key] ?? ""}
                  placeholder={credentialsSetAt ? "•••••••• (laisser vide pour ne pas modifier)" : "Non défini"}
                  onChange={(e) => setCredentialValues((v) => ({ ...v, [f.key]: e.target.value }))}
                />
              </div>
            ))}
          </CardContent>
          <CardFooter className="flex-col items-stretch gap-3">
            {credentialError && <p className="text-sm text-destructive" role="alert">{credentialError}</p>}
            <div className="flex items-center justify-between gap-2">
              <ConfirmDialog
                trigger={
                  <Button
                    variant="ghost" size="sm" disabled={isSavingCredentials || !credentialsSetAt}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    Supprimer
                  </Button>
                }
                title={`Supprimer les identifiants ${label} ?`}
                description={`${label} ne pourra plus envoyer tant que de nouveaux identifiants ne sont pas enregistrés.`}
                confirmLabel="Supprimer"
                destructive
                onConfirm={handleDeleteCredentials}
              />
              <Button onClick={handleSaveCredentials} disabled={isSavingCredentials} size="sm">
                {isSavingCredentials && <Loader2 className="animate-spin" aria-hidden />}
                {isSavingCredentials ? "Enregistrement…" : "Enregistrer les identifiants"}
              </Button>
            </div>
          </CardFooter>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Légende</CardTitle>
          <CardDescription>Longueur maximale et consignes pour la légende générée par l'IA.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="caption-max-chars">Limite de caractères</Label>
            <Input
              id="caption-max-chars" type="number" min={captionLimits.min} max={captionLimits.max} disabled={isSaving}
              value={form.captionMaxChars}
              onChange={(e) => setForm((f) => ({ ...f, captionMaxChars: e.target.value }))}
            />
            <p className="text-xs text-muted-foreground">
              Entre {captionLimits.min} et {captionLimits.max} caractères (plafond officiel de {label}).
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="caption-prompt">Consigne personnalisée (optionnel)</Label>
            <Textarea
              id="caption-prompt" disabled={isSaving} rows={3}
              value={form.captionPrompt}
              placeholder="Vide = consigne par défaut."
              onChange={(e) => setForm((f) => ({ ...f, captionPrompt: e.target.value }))}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Publication automatique</CardTitle>
          <CardDescription>
            Désactivée par défaut. Choisit un article publié le jour même, du plus ancien au plus
            récent ; si tout est déjà envoyé, remonte à la veille, et ainsi de suite.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <Label htmlFor="auto-enabled">Publication automatique</Label>
            <Switch
              id="auto-enabled" checked={form.autoEnabled} disabled={isSaving}
              onCheckedChange={(checked) => setForm((f) => ({ ...f, autoEnabled: checked }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="auto-interval">Intervalle (heures)</Label>
            <Input
              id="auto-interval" type="number" min={1} disabled={isSaving}
              value={form.autoIntervalHours}
              onChange={(e) => setForm((f) => ({ ...f, autoIntervalHours: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="auto-backlog">Profondeur de rattrapage (jours)</Label>
            <Input
              id="auto-backlog" type="number" min={1} disabled={isSaving}
              value={form.autoMaxBacklogDays}
              onChange={(e) => setForm((f) => ({ ...f, autoMaxBacklogDays: e.target.value }))}
            />
            <p className="text-xs text-muted-foreground">
              Nombre de jours en arrière que le planificateur regarde s&apos;il n&apos;a plus rien à publier pour aujourd&apos;hui.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="auto-window-start">Début de fenêtre (heure)</Label>
              <Input
                id="auto-window-start" type="number" min={0} max={23} disabled={isSaving}
                value={form.autoWindowStartHour}
                onChange={(e) => setForm((f) => ({ ...f, autoWindowStartHour: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="auto-window-end">Fin de fenêtre (heure)</Label>
              <Input
                id="auto-window-end" type="number" min={0} max={23} disabled={isSaving}
                value={form.autoWindowEndHour}
                onChange={(e) => setForm((f) => ({ ...f, autoWindowEndHour: e.target.value }))}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Entre 0 et 23. Hors de cette fenêtre, aucun envoi automatique n&apos;a lieu — une fenêtre
            où le début est supérieur à la fin (ex. 22 → 6) s&apos;étend sur la nuit.
          </p>
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
