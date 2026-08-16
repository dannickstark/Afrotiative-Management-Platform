import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { getVideoSettings } from "@/lib/queries/video-settings";
import { VideoSettingsForm } from "@/components/video/video-settings-form";

export default async function Page() {
  const user = await requireUser();
  requirePermission(user.role, "video", "manage");
  const settings = await getVideoSettings();
  return <VideoSettingsForm settings={settings} />;
}
