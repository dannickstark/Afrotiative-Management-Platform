import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { getIntegrationStatus } from "@/lib/queries/settings";
import { IntegrationCards } from "@/components/settings/integration-cards";

export default async function Page() {
  const user = await requireUser();
  requirePermission(user.role, "pipeline", "configure");
  const status = await getIntegrationStatus();
  return <IntegrationCards status={status} />;
}
