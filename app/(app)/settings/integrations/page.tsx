import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { getIntegrationStatus } from "@/lib/queries/settings";
import { getOpenRouterTokensMasked } from "@/lib/queries/openrouter-tokens";
import { getCryptoConfig } from "@/lib/diffusion/crypto";
import { IntegrationCards } from "@/components/settings/integration-cards";

// Task 9: VIEW access widened from admin-only (pipeline:configure) to admin+editor, gated on the
// SAME permission the OpenRouter token pool actions already use (llmTokens:manage — lib/rbac.ts's
// MATRIX gives both admin and editor "manage", journalist gets nothing). This page only ever
// renders STATUS booleans (configured/not, masked token metadata) and never a secret value, so
// there is nothing here an editor shouldn't see. testIntegration (the env-provider "Tester"
// button, lib/actions/integration-actions.ts) stays admin-only via its own separate
// pipeline:configure check — deliberately NOT relaxed by this change.
export default async function Page() {
  const user = await requireUser();
  requirePermission(user.role, "llmTokens", "manage");
  const [status, tokens] = await Promise.all([getIntegrationStatus(), getOpenRouterTokensMasked()]);
  const cryptoConfigured = getCryptoConfig() !== null;
  return <IntegrationCards status={status} tokens={tokens} cryptoConfigured={cryptoConfigured} />;
}
