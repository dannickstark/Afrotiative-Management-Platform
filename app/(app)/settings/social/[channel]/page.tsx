import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { getChannelSettings, hasAllCredentials } from "@/lib/diffusion/settings-core";
import { SOCIAL_CHANNELS } from "@/lib/diffusion/channels";
import { getSetupGuide } from "@/lib/diffusion/setup-guide";
import { CHANNELS, type Channel } from "@/lib/studio";
import { SocialChannelForm } from "@/components/settings/social-channel-form";
import { ChannelSetupGuide } from "@/components/settings/channel-setup-guide";

function isChannel(value: string): value is Channel {
  return (CHANNELS as readonly string[]).includes(value);
}

// `params` is a Promise — breaking change in this version of Next.js (see AGENTS.md), same
// canonical shape as app/(app)/studio/[id]/page.tsx / app/(app)/article/[id]/page.tsx: Server
// Component, requireUser() + requirePermission() before any query, then a Client Component fed
// the already-loaded data.
export default async function Page({ params }: { params: Promise<{ channel: string }> }) {
  const { channel: raw } = await params;
  const user = await requireUser();
  requirePermission(user.role, "social", "manage");

  if (!isChannel(raw)) notFound();
  const channel = raw;

  const settings = await getChannelSettings(channel);
  const { label, captionLimits, credentialFields } = SOCIAL_CHANNELS[channel];
  const guide = getSetupGuide(channel);
  // Computed HERE, server-side, and passed down as a plain boolean — never inside
  // SocialChannelForm (D7 review, Important 1): that component is "use client", and importing
  // hasAllCredentials as a VALUE there would pull the whole settings-core.ts graph — including
  // @/db's module-scope `pg` Pool, which has no browser build — into the client bundle for this
  // page. `bun test`/`tsc --noEmit` cannot see that break; only a real build/dev-server load can
  // (next.config.ts records two prior instances of exactly this blind spot). Reused for BOTH the
  // guide's collapse below and the form's initial "Tester la connexion" gate.
  const isConfigured = hasAllCredentials(channel, settings);

  return (
    <div className="max-w-2xl space-y-4">
      {/* Collapsed once EVERY declared credential field is set, expanded otherwise (Task 4 brief,
          corrected by the D7 credential debt fix, spec §5 item 1): a channel with only ONE of its
          two fields saved must still show as unconfigured — credentialsSetAt alone (non-null the
          moment ANY field is saved) can't tell that apart from "fully configured", which is exactly
          the D2+D3 final review bug this closes. */}
      <ChannelSetupGuide guide={guide} credentialFields={credentialFields} defaultOpen={!isConfigured} />
      <SocialChannelForm
        channel={channel} label={label} captionLimits={captionLimits} settings={settings}
        credentialFields={credentialFields} isConfigured={isConfigured}
      />
    </div>
  );
}
