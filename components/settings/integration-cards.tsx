"use client";
import { useTransition } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shell/page-header";
import { testIntegration } from "@/lib/actions/integration-actions";
import { formatDate, pipelineStatusLabel } from "@/lib/format";
import type { getIntegrationStatus } from "@/lib/queries/settings";
import type { IntegrationName, IntegrationManagement } from "@/lib/config/integration-config";
import { OpenRouterTokensPanel } from "@/components/settings/openrouter-tokens-panel";
import type { MaskedToken } from "@/lib/queries/openrouter-tokens";

type IntegrationStatus = Awaited<ReturnType<typeof getIntegrationStatus>>;
export type { IntegrationName };

// Same green/slate convention as members-table.tsx's Actif/Désactivé badge and
// feeds-table.tsx's health badge (--status-approved / --status-draft outline badges).
const CONFIGURED_STYLE = "bg-[var(--status-approved)]/15 text-[var(--status-approved)] border-[var(--status-approved)]/30";
const NOT_CONFIGURED_STYLE = "bg-[var(--status-draft)]/15 text-[var(--status-draft)] border-[var(--status-draft)]/30";

// Task 8 — the full registry (5 → 13), everything wired into lib/config/pipeline-config.ts's
// provider creds plus the search/storage/email singletons. `kind`/`management` come from
// getIntegrationStatus() (lib/config/integration-config.ts's INTEGRATION_META is the single
// source of truth for those two), so this list only carries display copy. Deliberately excludes
// crawl4ai — not wired into config on this branch.
const INTEGRATIONS: { name: IntegrationName; label: string; description: string }[] = [
  { name: "wordpress", label: "WordPress", description: "Publication des articles approuvés." },
  { name: "omniroute", label: "OmniRoute", description: "Fournisseur LLM pour la génération d'articles." },
  { name: "openrouter", label: "OpenRouter", description: "Fournisseur LLM pour la génération d'articles." },
  { name: "anthropic", label: "Anthropic", description: "Fournisseur LLM de repli (Claude)." },
  { name: "openai", label: "OpenAI", description: "Fournisseur LLM de repli (GPT)." },
  { name: "google", label: "Google", description: "Fournisseur LLM de repli (Gemini)." },
  { name: "jina", label: "Jina", description: "Extraction de contenu et embeddings." },
  { name: "firecrawl", label: "Firecrawl", description: "Extraction de contenu (repli)." },
  { name: "brave", label: "Brave Search", description: "Recherche web pour enrichir le contexte des articles." },
  { name: "exa", label: "Exa", description: "Recherche web (repli)." },
  { name: "embeddings", label: "Embeddings", description: "Génération d'embeddings pour la déduplication et le clustering." },
  { name: "r2", label: "Cloudflare R2", description: "Stockage des assets du studio." },
  { name: "resend", label: "Resend", description: "Envoi des emails d'alerte." },
];

// D1 shipped the "Réseaux sociaux" / "WhatsApp" reserved placeholders that used to live here
// ("Bientôt — SP6") as a real admin surface at /settings/social — see components/settings/
// social-channels.tsx. Nothing left to reserve a slot for.

// Page-level card grid for the integrations admin (SP2 Task 5, extended to the full registry by
// Task 8). Never renders a key value — only the "Configuré"/"Non configuré" badge — and "Tester"
// only ever runs FREE checks (see lib/actions/integration-actions.ts): WordPress /users/me,
// OmniRoute/OpenRouter /models, every other provider key/config-presence. No token-spending LLM
// completion is ever triggered from here. The openrouter card's token-pool panel (management:
// "tokens") is mounted below (Task 9) directly under that card's own status/Tester header —
// `tokens`/`cryptoConfigured` are computed server-side by the page (getOpenRouterTokensMasked,
// getCryptoConfig) and threaded through here untouched, same "server computes, client only
// renders" split as social-channel-form.tsx's `isConfigured` prop.
export function IntegrationCards({
  status, tokens, cryptoConfigured, canTest,
}: {
  status: IntegrationStatus;
  tokens: MaskedToken[];
  cryptoConfigured: boolean;
  canTest: boolean;
}) {
  return (
    <div className="space-y-6">
      <PageHeader title="Intégrations" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {INTEGRATIONS.map((i) => (
          <IntegrationCard key={i.name} name={i.name} label={i.label} description={i.description}
            configured={status[i.name].configured}
            management={status[i.name].management}
            lastSuccessAt={i.name === "wordpress" ? status.wordpress.lastSuccessAt : null}
            lastRun={status.lastRun}
            canTest={canTest}
          />
        ))}
      </div>
      <OpenRouterTokensPanel tokens={tokens} cryptoConfigured={cryptoConfigured} />
    </div>
  );
}

function IntegrationCard({
  name, label, description, configured, management, lastSuccessAt, lastRun, canTest,
}: {
  name: IntegrationName;
  label: string;
  description: string;
  configured: boolean;
  management: IntegrationManagement;
  lastSuccessAt: Date | string | null;
  lastRun: IntegrationStatus["lastRun"];
  canTest: boolean;
}) {
  const [isPending, startTransition] = useTransition();

  function handleTest() {
    startTransition(async () => {
      try {
        const res = await testIntegration(name);
        if (res.ok) toast.success(res.detail);
        else toast.error(res.detail);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec du test.");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{label}</CardTitle>
        <CardDescription>{description}</CardDescription>
        <CardAction>
          <Badge variant="outline" className={configured ? CONFIGURED_STYLE : NOT_CONFIGURED_STYLE}>
            {configured ? "Configuré" : "Non configuré"}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground space-y-1">
        {management === "env" && <p>Défini via l&apos;environnement.</p>}
        {name === "wordpress"
          ? lastSuccessAt && <p>Dernière publication réussie : {formatDate(lastSuccessAt)}</p>
          : lastRun && <p>Dernière exécution du pipeline : {formatDate(lastRun.at)} ({pipelineStatusLabel(lastRun.status)})</p>}
      </CardContent>
      {canTest && (
        <CardFooter>
          <Button variant="outline" size="sm" onClick={handleTest} disabled={isPending}>
            {isPending && <Loader2 className="animate-spin" aria-hidden />}
            Tester
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
