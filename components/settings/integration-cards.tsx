"use client";
import { useTransition } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { testIntegration } from "@/lib/actions/integration-actions";
import { formatDate, pipelineStatusLabel } from "@/lib/format";
import type { getIntegrationStatus } from "@/lib/queries/settings";

type IntegrationStatus = Awaited<ReturnType<typeof getIntegrationStatus>>;
type IntegrationName = "wordpress" | "omniroute" | "openrouter" | "jina" | "firecrawl";

// Same green/slate convention as members-table.tsx's Actif/Désactivé badge and
// feeds-table.tsx's health badge (--status-approved / --status-draft outline badges).
const CONFIGURED_STYLE = "bg-[var(--status-approved)]/15 text-[var(--status-approved)] border-[var(--status-approved)]/30";
const NOT_CONFIGURED_STYLE = "bg-[var(--status-draft)]/15 text-[var(--status-draft)] border-[var(--status-draft)]/30";

const INTEGRATIONS: { name: IntegrationName; label: string; description: string }[] = [
  { name: "wordpress", label: "WordPress", description: "Publication des articles approuvés." },
  { name: "omniroute", label: "OmniRoute", description: "Fournisseur LLM pour la génération d'articles." },
  { name: "openrouter", label: "OpenRouter", description: "Fournisseur LLM pour la génération d'articles." },
  { name: "jina", label: "Jina", description: "Extraction de contenu et embeddings." },
  { name: "firecrawl", label: "Firecrawl", description: "Extraction de contenu (repli)." },
];

const RESERVED = [
  { label: "WhatsApp", description: "Diffusion des articles publiés." },
  { label: "Réseaux sociaux", description: "Publication automatique (X, Facebook, LinkedIn…)." },
];

// Page-level card grid for the integrations admin (SP2 Task 5). Never renders a key value —
// only the "Configuré"/"Non configuré" badge — and "Tester" only ever runs FREE checks
// (see lib/actions/integration-actions.ts): WordPress /users/me, OmniRoute/OpenRouter /models,
// Jina/Firecrawl key-presence. No token-spending LLM completion is ever triggered from here.
export function IntegrationCards({ status }: { status: IntegrationStatus }) {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Intégrations</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {INTEGRATIONS.map((i) => (
          <IntegrationCard key={i.name} name={i.name} label={i.label} description={i.description}
            configured={status[i.name].configured}
            lastSuccessAt={i.name === "wordpress" ? status.wordpress.lastSuccessAt : null}
            lastRun={status.lastRun}
          />
        ))}
        {RESERVED.map((r) => (
          <ReservedCard key={r.label} label={r.label} description={r.description} />
        ))}
      </div>
    </div>
  );
}

function IntegrationCard({
  name, label, description, configured, lastSuccessAt, lastRun,
}: {
  name: IntegrationName;
  label: string;
  description: string;
  configured: boolean;
  lastSuccessAt: Date | string | null;
  lastRun: IntegrationStatus["lastRun"];
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
      <CardContent className="text-xs text-muted-foreground">
        {name === "wordpress"
          ? lastSuccessAt && <p>Dernière publication réussie : {formatDate(lastSuccessAt)}</p>
          : lastRun && <p>Dernière exécution du pipeline : {formatDate(lastRun.at)} ({pipelineStatusLabel(lastRun.status)})</p>}
      </CardContent>
      <CardFooter>
        <Button variant="outline" size="sm" onClick={handleTest} disabled={isPending}>
          {isPending && <Loader2 className="animate-spin" aria-hidden />}
          Tester
        </Button>
      </CardFooter>
    </Card>
  );
}

function ReservedCard({ label, description }: { label: string; description: string }) {
  return (
    <Card className="opacity-70">
      <CardHeader>
        <CardTitle>{label}</CardTitle>
        <CardDescription>{description}</CardDescription>
        <CardAction>
          <Badge variant="outline" className={NOT_CONFIGURED_STYLE}>Bientôt — SP6</Badge>
        </CardAction>
      </CardHeader>
      <CardFooter>
        <Button variant="outline" size="sm" disabled title="Disponible en SP6.">Tester</Button>
      </CardFooter>
    </Card>
  );
}
