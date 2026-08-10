import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { getAllChannelSettings } from "@/lib/diffusion/settings-core";
import { SOCIAL_CHANNELS } from "@/lib/diffusion/channels";
import { CHANNELS } from "@/lib/studio";
import { SocialChannelsList, type SocialChannelSummary } from "@/components/settings/social-channels";

// Task 7 (D1 §6) — admin-only (social:manage), same guard shape as
// app/(app)/settings/pipeline/page.tsx's requirePermission(user.role, "pipeline", "configure").
export default async function Page() {
  const user = await requireUser();
  requirePermission(user.role, "social", "manage");

  const settings = await getAllChannelSettings(); // aligned with CHANNELS order — see that function's own comment
  const items: SocialChannelSummary[] = CHANNELS.map((channel, i) => ({
    channel,
    label: SOCIAL_CHANNELS[channel].label,
    enabled: settings[i].enabled,
    autoEnabled: settings[i].autoEnabled,
    autoIntervalHours: settings[i].autoIntervalHours,
    autoMaxBacklogDays: settings[i].autoMaxBacklogDays,
    autoWindowStartHour: settings[i].autoWindowStartHour,
    autoWindowEndHour: settings[i].autoWindowEndHour,
  }));

  return <SocialChannelsList items={items} />;
}
