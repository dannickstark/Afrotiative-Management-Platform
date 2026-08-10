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

  return (
    <div className="max-w-2xl space-y-4">
      {/* Collapsed once EVERY declared credential field is set, expanded otherwise (Task 4 brief,
          corrected by the D7 credential debt fix, spec §5 item 1): a channel with only ONE of its
          two fields saved must still show as unconfigured — credentialsSetAt alone (non-null the
          moment ANY field is saved) can't tell that apart from "fully configured", which is exactly
          the D2+D3 final review bug this closes. */}
      <ChannelSetupGuide guide={guide} credentialFields={credentialFields} defaultOpen={!hasAllCredentials(channel, settings)} />
      <SocialChannelForm
        channel={channel} label={label} captionLimits={captionLimits} settings={settings}
        credentialFields={credentialFields}
      />
    </div>
  );
}
