"use client";
// components/article/diffusion-panel.tsx — D1 §4's Diffusion panel: one card per ENABLED social
// channel, below the image tabs (SidePanel composes this after ImagePanel's section). Every piece
// of DECISION logic (which reason blocks the button, what the status line says, what the button is
// labeled) is a pure function/component, exported and unit-tested without a DOM
// (tests/diffusion-panel.test.ts) — same discipline as image-panel.tsx's handleTabOpen/
// PreviewTabContent/friendlyPreviewMessage.
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { sendToChannel, generateCaptionForArticle } from "@/lib/actions/diffusion-actions";
import { CHANNEL_AVAILABLE } from "@/lib/diffusion/channel-availability";
import type { ChannelDiffusionState } from "@/lib/queries/diffusion";

export type DiffusionDistributionView = {
  status: string;
  caption: string | null;
  sentAt: Date | null;
  lastError: string | null;
  externalId: string | null;
  attempts: number;
  renderId: string | null;
  imageUrl: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// computeSendDisabledReason — Task 6: "the button is disabled — with the reason visible, not a
// click-time error — when: the article is not published; the channel is disabled; R2 is
// unconfigured; or the user lacks social:send." PURE, so all four cases are independently testable.
//
// Order matters only for WHICH single reason is shown when several gates fail at once — chosen as
// permission first (the most fundamental gate: an unauthorized user shouldn't be told about
// publish-state at all), then the article's own state (published), then the channel's own state
// (enabled), then infrastructure (R2). Today's query (getEnabledChannelsForArticle) only ever
// renders a card for an ALREADY-enabled channel, so `channelEnabled: false` is a defensive
// re-validation path (a channel disabled by another admin between page load and this click,
// notably) rather than something normally reachable from the live card list — it is still a real,
// independently testable gate, not a case this function may skip.
// ─────────────────────────────────────────────────────────────────────────────
export function computeSendDisabledReason(input: {
  isPublished: boolean;
  channelEnabled: boolean;
  r2Configured: boolean;
  canSend: boolean;
  channelLabel: string;
  // Found live (not by a unit test) while verifying Task 6 in a browser: without this check, a
  // successful send left the "Publier sur {canal}" button fully clickable — sendToChannelCore
  // itself refuses the resulting second send (send-core.ts's `existing?.status === "sent"` guard),
  // but the UI showed no reason beforehand, exactly the "click-time error" Task 6 explicitly rules
  // out for every OTHER gate. Defaults to false so every existing call site (and the four
  // originally-required cases) keeps behaving exactly as before.
  alreadySent?: boolean;
  // Plan 001: whatsapp/x/tiktok still route to StubChannel (no real adapter) — this refuses the
  // send instead of reporting a fake "sent". Placed after alreadySent/canSend so an unauthorized
  // editor still sees the permission reason first, before this file's other, article/channel-state
  // reasons.
  channelAvailable: boolean;
}): string | null {
  if (input.alreadySent) return `Déjà diffusé sur ${input.channelLabel}.`;
  if (!input.canSend) return "Vous n'avez pas la permission de diffuser sur les réseaux sociaux.";
  if (!input.channelAvailable) return `La diffusion automatique sur ${input.channelLabel} n'est pas encore disponible.`;
  if (!input.isPublished) return "L'article doit d'abord être publié sur WordPress avant d'être diffusé.";
  if (!input.channelEnabled) return `Le canal ${input.channelLabel} est désactivé dans les réglages de diffusion.`;
  if (!input.r2Configured) return "Stockage R2 non configuré : la génération de l'image de diffusion est indisponible.";
  return null;
}

export type DistributionStateView =
  | { kind: "never_sent" }
  | { kind: "sent"; sentAtLabel: string; externalId: string | null }
  | { kind: "failed"; message: string; attempts: number }
  | { kind: "pending" };

export function formatSentAt(d: Date): string {
  return d.toLocaleString("fr-FR", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// PURE — maps a raw distribution row (or its absence) to the panel's four displayable states
// (spec §4: "jamais envoyé / envoyé le … / échec"), plus 'pending' for the rare stuck-in-flight row
// (lib/diffusion/send-core.ts's own documented known limitation).
export function distributionStateView(d: DiffusionDistributionView | null): DistributionStateView {
  if (!d) return { kind: "never_sent" };
  if (d.status === "sent") return { kind: "sent", sentAtLabel: d.sentAt ? formatSentAt(d.sentAt) : "", externalId: d.externalId };
  if (d.status === "failed") return { kind: "failed", message: d.lastError ?? "Échec inconnu.", attempts: d.attempts };
  return { kind: "pending" };
}

export function sendButtonLabel(view: DistributionStateView, channelLabel: string): string {
  return view.kind === "failed" ? `Réessayer sur ${channelLabel}` : `Publier sur ${channelLabel}`;
}

// Pure, DOM-free-testable status line — the état required by spec §4, rendered directly from
// distributionStateView's output.
export function DiffusionStatusLine({ view }: { view: DistributionStateView }) {
  if (view.kind === "never_sent") return <p className="text-xs text-muted-foreground">Jamais envoyé.</p>;
  if (view.kind === "pending") return <p className="text-xs text-muted-foreground">Envoi en cours…</p>;
  if (view.kind === "sent") {
    return <p className="text-xs text-[var(--status-approved,theme(colors.green.600))]">Envoyé le {view.sentAtLabel}.</p>;
  }
  return (
    <p className="text-xs text-[var(--status-pending)]">
      Échec{view.attempts > 1 ? ` (${view.attempts} tentatives)` : ""} : {view.message}
    </p>
  );
}

// Live character counter against the channel's configured limit (spec §4). A visual-only warning
// past the limit — it does not itself block sending (Task 6's four disable reasons don't include
// caption length; a human who typed past the limit is still "AI proposes, human disposes").
export function CaptionCounter({ length, max }: { length: number; max: number }) {
  const over = length > max;
  return (
    <span className={`text-xs tabular-nums ${over ? "text-destructive font-medium" : "text-muted-foreground"}`}>
      {length} / {max}
    </span>
  );
}

// The action row: the reason (when blocked) is ALWAYS rendered alongside the button, never only
// discoverable by clicking — Task 6's explicit "not a click-time error" requirement.
export function SendAction({
  reason, label, pending, onClick,
}: { reason: string | null; label: string; pending: boolean; onClick: () => void }) {
  return (
    <div className="space-y-1">
      {reason && <p className="text-xs text-[var(--status-pending)]">{reason}</p>}
      <Button type="button" size="sm" className="w-full" disabled={!!reason || pending} onClick={onClick}>
        {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Send className="size-3.5" aria-hidden />}
        {pending ? "Envoi…" : label}
      </Button>
    </div>
  );
}

// One channel's full card — owns its own caption draft + two independent pending states (caption
// generation vs. send), so one card's activity never disables another's controls.
function DiffusionChannelCard({
  articleId, data, isPublished, r2Configured, canSend,
}: {
  articleId: string;
  data: ChannelDiffusionState;
  isPublished: boolean;
  r2Configured: boolean;
  canSend: boolean;
}) {
  const { channel, label, captionMaxChars, distribution } = data;
  const [caption, setCaption] = useState(distribution?.caption ?? "");
  const [isSending, startSend] = useTransition();
  const [isGenerating, startGenerate] = useTransition();

  const view = distributionStateView(distribution as DiffusionDistributionView | null);
  const reason = computeSendDisabledReason({
    isPublished, channelEnabled: true, r2Configured, canSend, channelLabel: label,
    alreadySent: view.kind === "sent",
    channelAvailable: CHANNEL_AVAILABLE[channel],
  });

  function handleSend() {
    startSend(async () => {
      try {
        const res = await sendToChannel({ articleId, channel, caption });
        if (res.ok) toast.success(res.message); else toast.error(res.message);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : `Échec de la diffusion sur ${label}.`);
      }
    });
  }

  function handleGenerate() {
    startGenerate(async () => {
      try {
        const res = await generateCaptionForArticle({ articleId, channel });
        if (res.ok) setCaption(res.caption); else toast.error(res.message);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec de la génération de la légende.");
      }
    });
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-sm">
          <span>{label}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {distribution?.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- rendu R2 (lib/studio), même choix que image-panel.tsx.
          <img src={distribution.imageUrl} alt="" className="aspect-video w-full rounded-md border object-cover" />
        ) : (
          <div className="flex aspect-video w-full items-center justify-center rounded-md border border-dashed text-center text-xs text-muted-foreground">
            L&apos;image sera générée au moment de l&apos;envoi.
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-muted-foreground">Légende</p>
          <div className="flex items-center gap-2">
            <CaptionCounter length={caption.length} max={captionMaxChars} />
            <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5" disabled={isGenerating || !canSend} onClick={handleGenerate}>
              {isGenerating ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Sparkles className="size-3.5" aria-hidden />}
            </Button>
          </div>
        </div>
        <Textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder="Légende (générée par IA, toujours modifiable avant envoi)"
          aria-label={`Légende ${label}`}
          className="min-h-20 text-sm"
        />

        <DiffusionStatusLine view={view} />
        <SendAction reason={reason} label={sendButtonLabel(view, label)} pending={isSending} onClick={handleSend} />
      </CardContent>
    </Card>
  );
}

// Top-level panel — one card per enabled channel (spec §4). Renders nothing (not even a header)
// when no channel is enabled, matching this codebase's convention of leaving optional sections out
// entirely rather than showing an empty state for a socle-level absence (SourcesList/HistoryPanel
// both do the same for an article with no sources/revisions yet).
export function DiffusionPanel({
  articleId, isPublished, r2Configured, canSend, channels,
}: {
  articleId: string;
  isPublished: boolean;
  r2Configured: boolean;
  canSend: boolean;
  channels: ChannelDiffusionState[];
}) {
  if (channels.length === 0) return null;
  return (
    <div className="space-y-3">
      {channels.map((data) => (
        <DiffusionChannelCard
          key={data.channel}
          articleId={articleId}
          data={data}
          isPublished={isPublished}
          r2Configured={r2Configured}
          canSend={canSend}
        />
      ))}
    </div>
  );
}
