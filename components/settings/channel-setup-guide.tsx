// components/settings/channel-setup-guide.tsx — Task 4 (D2+D3): renders a channel's structured
// connection guide (lib/diffusion/setup-guide.ts) on /settings/social/[channel], as its own card
// next to the "Identifiants" card (social-channel-form.tsx) whose fields each step walks the admin
// through filling.
//
// Server Component on purpose: nothing here needs client state of its own — Collapsible
// (components/ui/collapsible.tsx) is the ONLY interactive piece, and per Next.js's Server/Client
// Components model (node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-
// components.md — read before writing this file, per AGENTS.md) a Server Component may render a
// Client Component directly without itself becoming one; the page (app/(app)/settings/social/
// [channel]/page.tsx) already does exactly this for <SocialChannelForm>.
import { ChevronDown, ExternalLink } from "lucide-react";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { SetupGuideStep } from "@/lib/diffusion/setup-guide";
import type { CredentialField } from "@/components/settings/social-channel-form";

export function ChannelSetupGuide({
  guide,
  credentialFields,
  defaultOpen,
}: {
  guide: readonly SetupGuideStep[];
  // Only used to resolve a step's fieldHint (a credential KEY, e.g. "pageId") to its French display
  // label — same prop shape/source (SOCIAL_CHANNELS[channel].credentialFields) social-channel-form.tsx
  // already takes, so the guide's "→ Renseignez : …" pointer always names the exact same label the
  // credentials card shows for that field, never a hand-typed duplicate that could drift.
  credentialFields: readonly CredentialField[];
  // Collapsed once EVERY declared credential field is set, expanded otherwise (brief's contract,
  // corrected by the D7 credential debt fix, spec §5 item 1) — the caller (page.tsx) computes this
  // with hasAllCredentials(channel, settings) (lib/diffusion/settings-core.ts), NOT from
  // settings.credentialsSetAt alone: that field goes non-null the moment ANY one field is saved,
  // which used to make this guide collapse — and offer *Tester la connexion* — while a two-field
  // channel (e.g. a future LinkedIn) still had only one of its two credentials on file.
  defaultOpen: boolean;
}) {
  function fieldLabel(key: string): string {
    return credentialFields.find((f) => f.key === key)?.label ?? key;
  }

  return (
    <Card>
      <Collapsible defaultOpen={defaultOpen}>
        <CardHeader>
          <CollapsibleTrigger className="group flex w-full items-start justify-between gap-2 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <div className="space-y-1">
              <CardTitle>Guide de connexion</CardTitle>
              <CardDescription>
                Quoi créer, où, avec quelles permissions — {guide.length} étape{guide.length > 1 ? "s" : ""}.
              </CardDescription>
            </div>
            <ChevronDown
              className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-panel-open:rotate-180"
              aria-hidden
            />
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <CardContent>
            <ol className="space-y-4">
              {guide.map((step, i) => (
                <li key={i} className="space-y-1 border-l-2 border-border pl-3">
                  <p className="text-sm font-medium text-foreground">
                    <span className="text-muted-foreground">{i + 1}. </span>
                    {step.title}
                  </p>
                  <p className="text-sm text-muted-foreground">{step.body}</p>
                  {(step.href || step.fieldHint) && (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {step.href && (
                        <a
                          href={step.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                          <ExternalLink className="size-3" aria-hidden />
                          Documentation
                        </a>
                      )}
                      {step.fieldHint && (
                        <Badge variant="outline">→ Renseignez : {fieldLabel(step.fieldHint)}</Badge>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
