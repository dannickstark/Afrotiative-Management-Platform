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
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PageHeader } from "@/components/shell/page-header";
import { IntervalPicker } from "@/components/settings/interval-picker";
import { formatDate } from "@/lib/format";
import {
  updateChannelSettings, updateChannelCredentials, deleteChannelCredentials, testChannelConnection,
} from "@/lib/actions/diffusion-settings-actions";
import type { Channel } from "@/lib/studio";
// TYPE-only import (D7 review, Important 1) — never a value from settings-core.ts here. This file
// is "use client", and settings-core.ts imports @/db, whose module-scope `pg` Pool has no browser
// build; a VALUE import (e.g. hasAllCredentials) would pull that whole graph into the client bundle
// for this page. A `type` import is erased at compile time, so it carries none of that risk.
// app/(app)/settings/social/[channel]/page.tsx (a Server Component) computes `isConfigured`
// server-side instead and passes it down as a plain boolean prop.
import type { SocialChannelSettings } from "@/lib/diffusion/settings-core";

export type CredentialField = { key: string; label: string };

export type CaptionLimits = { min: number; max: number; default: number };

// Local mirror of settings-core.ts's hasAllCredentials — deliberately NOT imported (see the
// type-only import note above). Same one-line rule ("every declared field's key must be present;
// an empty field list is never configured"), just re-derived here from data this component already
// holds (`credentialFields`, a stable prop; `credentialKeys`, local state) so the UI reacts the
// instant a save/delete changes what's stored, without waiting on a full page reload.
function computeIsConfigured(fields: readonly CredentialField[], keys: readonly string[]): boolean {
  return fields.length > 0 && fields.every((f) => keys.includes(f.key));
}

type FormState = {
  enabled: boolean;
  captionMaxChars: string;
  captionPrompt: string;
  autoEnabled: boolean;
  autoIntervalHours: string;
  autoMaxBacklogDays: string;
  autoWindowStartHour: string;
  autoWindowEndHour: string;
  // Task 2 (D7 spec §4) — "YYYY-MM-DD", the native <input type="date"> value shape (same convention
  // as components/published/published-filter-bar.tsx's `ymd`). "" means "unknown" (null), never
  // "never expires" — see handleSave's own parsing of this field below.
  tokenExpiresAt: string;
};

// d.toISOString().slice(0, 10) — same helper shape as published-filter-bar.tsx's `ymd`.
function tokenExpiresAtToInputValue(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "";
}

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
    tokenExpiresAt: tokenExpiresAtToInputValue(settings.tokenExpiresAt),
  };
}

export function SocialChannelForm({
  channel, label, captionLimits, settings, credentialFields = [], isConfigured: initialIsConfigured = false,
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
  // D7 review, Important 1 — computed server-side by page.tsx (hasAllCredentials(channel,
  // settings)) and handed down as a plain boolean: the ONLY way this "every declared field present"
  // fact reaches this client component, since the function that computes it must never be imported
  // here. Seeds local state below, kept fresh after each save/delete via computeIsConfigured
  // (plain array logic, no import) rather than by re-deriving from this prop again. Optional,
  // defaulting to `false` (the conservative, "not configured" reading) — same convention as
  // `credentialFields` above — so a caller that predates this prop (a test fixture, say) still
  // compiles and renders the safe state rather than a crash or a false "configured".
  isConfigured?: boolean;
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
  // `credentialKeys` (D7 credential debt, spec §5 item 1) — which fields are CURRENTLY stored,
  // updated locally from each guarded action's own return value exactly like `credentialsSetAt`
  // above, so `isConfigured` below reflects the latest save without a full page reload. `?? []`
  // guards a `settings` object that predates this field (still possible from a caller that hasn't
  // been touched to pass it) rather than crashing on `.includes` of `undefined`.
  const [credentialKeys, setCredentialKeys] = useState<string[]>(settings.credentialKeys ?? []);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [isSavingCredentials, startSavingCredentials] = useTransition();

  // "Configured" means EVERY declared field is present, not merely that credentialsSetAt is non-null
  // (D2+D3 final review, M6 — a single saved field used to be enough to claim the channel ready).
  // Drives the setup guide's collapse (page.tsx, using its OWN server-side computation) and, below,
  // whether *Tester la connexion* is reachable — `credentialsSetAt` itself keeps meaning only "last
  // write date" (the « Défini le … » text and *Supprimer*'s availability, since deleting a
  // partial/broken credential set must stay possible precisely when it is NOT fully configured).
  // Seeded from the server-computed prop, then kept in sync via computeIsConfigured (plain array
  // logic on `credentialFields` + the freshest `credentialKeys`) after every save/delete — same
  // prop-seeded-then-locally-updated pattern as `credentialsSetAt`/`credentialKeys` above.
  const [isConfigured, setIsConfigured] = useState<boolean>(initialIsConfigured);

  // Task 5 (D2+D3) — "Tester la connexion" result. Always reflects the credentials currently STORED
  // server-side (testChannelConnection re-reads them itself), never whatever is mid-edit in
  // `credentialValues` above — cleared on every save/delete below so a stale "vérifiée" never
  // outlives the credentials it was actually run against.
  const [connectionTest, setConnectionTest] = useState<{ ok: boolean; detail: string } | null>(null);
  const [isTestingConnection, startTestingConnection] = useTransition();

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

    // Task 2 (D7 spec §4) — "" (cleared by the admin) means "expiry unknown" (null), never "never
    // expires". A non-empty value that still fails to parse (should not happen from a native date
    // input, but never trust client input) is refused rather than silently sent as an Invalid Date.
    let tokenExpiresAt: Date | null = null;
    if (form.tokenExpiresAt.trim() !== "") {
      const parsed = new Date(form.tokenExpiresAt);
      if (Number.isNaN(parsed.getTime())) {
        setError("Date d'expiration du jeton invalide.");
        return;
      }
      tokenExpiresAt = parsed;
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
          tokenExpiresAt,
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
    setConnectionTest(null); // a prior "vérifiée" no longer applies to whatever is being saved now
    startSavingCredentials(async () => {
      try {
        const res = await updateChannelCredentials(channel, values);
        if (!res.ok) {
          setCredentialError(res.message);
          toast.error(res.message);
          return;
        }
        setCredentialsSetAt(res.settings.credentialsSetAt);
        setCredentialKeys(res.settings.credentialKeys);
        setIsConfigured(computeIsConfigured(credentialFields, res.settings.credentialKeys));
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
      setCredentialKeys(res.settings.credentialKeys);
      setIsConfigured(computeIsConfigured(credentialFields, res.settings.credentialKeys));
      setCredentialValues({});
      setConnectionTest(null); // nothing left to have verified
      toast.success(`Identifiants ${label} supprimés.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Échec de la suppression.");
    }
  }

  // Task 5 (D2+D3) — one free Graph read against the credentials currently SAVED for this channel
  // (testChannelConnection re-reads them server-side; see that action's own comment on why it never
  // reads `credentialValues`). setError-style local state, not a toast-only affordance: the brief
  // asks the result to show WHICH channel/account it reached, which needs to persist on-screen, not
  // just flash in a toast.
  function handleTestConnection() {
    setConnectionTest(null);
    startTestingConnection(async () => {
      try {
        const res = await testChannelConnection(channel);
        setConnectionTest(res);
        if (res.ok) toast.success(res.detail);
        else toast.error(res.detail);
      } catch (err) {
        const detail = err instanceof Error ? err.message : "Échec du test de connexion.";
        setConnectionTest({ ok: false, detail });
        toast.error(detail);
      }
    });
  }

  return (
    // Task 4 review, deferred Minor (a): width is constrained ONCE, by the page-level wrapper
    // (app/(app)/settings/social/[channel]/page.tsx, which also wraps <ChannelSetupGuide> in the
    // SAME max-w-2xl) — this root only needs its OWN vertical rhythm between its cards, not a
    // second, redundant max-w-2xl.
    <div className="space-y-6">
      <PageHeader title={label} />

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
                  // PER-FIELD, on whether THIS key is in credentialKeys — never on the channel-wide
                  // credentialsSetAt (D7 review, Important 2). credentialsSetAt goes non-null the
                  // moment ANY one field is saved, so with two fields (Facebook: pageId +
                  // pageAccessToken) it used to make BOTH placeholders claim "already set, leave
                  // blank to keep" the instant only one was — walking an admin who then leaves the
                  // still-unset field blank straight into exactly the partial-credential bug Task 1
                  // otherwise fixes (see tests/diffusion-credentials-presence.test.ts's "saving only
                  // pageId" case).
                  placeholder={credentialKeys.includes(f.key) ? "•••••••• (laisser vide pour ne pas modifier)" : "Non défini"}
                  onChange={(e) => setCredentialValues((v) => ({ ...v, [f.key]: e.target.value }))}
                />
              </div>
            ))}
            {/* Task 2 (D7 spec §4) — tokenExpiresAt is PLAINTEXT, never inside credentialValues: it
                is not a secret and must be visible/editable, unlike the write-only fields above. It
                also rides the OTHER action (updateChannelSettings, the page-level "Enregistrer"
                button below) — not handleSaveCredentials — so the help text says so explicitly to
                avoid an admin typing a date here and clicking "Enregistrer les identifiants",
                expecting it to be included. */}
            <div className="space-y-1.5 border-t border-border pt-4">
              <Label htmlFor="token-expires-at">Date d&apos;expiration du jeton</Label>
              <Input
                id="token-expires-at" type="date" disabled={isSaving}
                value={form.tokenExpiresAt}
                onChange={(e) => setForm((f) => ({ ...f, tokenExpiresAt: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                Ni Meta ni LinkedIn n&apos;expose cette date de façon fiable — elle est estimée à 60
                jours à chaque enregistrement d&apos;identifiant ; corrigez-la ici depuis le générateur
                de jeton de LinkedIn ou le débogueur de jeton d&apos;accès de Meta. Une alerte est
                envoyée avant l&apos;échéance. Enregistrée avec le bouton « Enregistrer » ci-dessous,
                pas avec « Enregistrer les identifiants ».
              </p>
            </div>
          </CardContent>
          <CardFooter className="flex-col items-stretch gap-3">
            {credentialError && <p className="text-sm text-destructive" role="alert">{credentialError}</p>}
            {connectionTest && (
              <p
                className={`flex items-start gap-1.5 text-sm ${connectionTest.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}
                role={connectionTest.ok ? "status" : "alert"}
              >
                {connectionTest.ok ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
                ) : (
                  <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                )}
                {connectionTest.detail}
              </p>
            )}
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
              <div className="flex items-center gap-2">
                <Button
                  type="button" variant="outline" size="sm"
                  onClick={handleTestConnection}
                  disabled={isTestingConnection || isSavingCredentials || !isConfigured}
                >
                  {isTestingConnection && <Loader2 className="animate-spin" aria-hidden />}
                  {isTestingConnection ? "Test en cours…" : "Tester la connexion"}
                </Button>
                <Button onClick={handleSaveCredentials} disabled={isSavingCredentials} size="sm">
                  {isSavingCredentials && <Loader2 className="animate-spin" aria-hidden />}
                  {isSavingCredentials ? "Enregistrement…" : "Enregistrer les identifiants"}
                </Button>
              </div>
            </div>
            {!isConfigured && (
              <p className="text-xs text-muted-foreground">
                Enregistrez TOUS les identifiants ci-dessus avant de tester la connexion.
              </p>
            )}
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
            <IntervalPicker
              id="auto-interval"
              value={Number(form.autoIntervalHours) || 6}
              disabled={isSaving}
              onChange={(hours) => setForm((f) => ({ ...f, autoIntervalHours: String(hours) }))}
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
