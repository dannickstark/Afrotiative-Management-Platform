import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { getPipelineSettings } from "@/lib/queries/settings";
import { PipelineSettingsForm } from "@/components/settings/pipeline-settings-form";

export default async function Page() {
  const user = await requireUser();
  requirePermission(user.role, "pipeline", "configure");
  const settings = await getPipelineSettings();
  return <PipelineSettingsForm settings={settings} />;
}
