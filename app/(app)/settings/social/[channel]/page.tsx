import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { getChannelSettings } from "@/lib/diffusion/settings-core";
import { SOCIAL_CHANNELS } from "@/lib/diffusion/channels";
import { CHANNELS, type Channel } from "@/lib/studio";
import { SocialChannelForm } from "@/components/settings/social-channel-form";

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
  const { label, captionLimits } = SOCIAL_CHANNELS[channel];

  return <SocialChannelForm channel={channel} label={label} captionLimits={captionLimits} settings={settings} />;
}
