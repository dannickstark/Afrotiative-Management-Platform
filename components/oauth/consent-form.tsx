"use client";
// components/oauth/consent-form.tsx — Task 6: formulaire de consentement OAuth, deux axes de
// portée (écriture / lecture des articles), mêmes libellés que components/settings/mcp/token-list.tsx
// pour la cohérence avec le reste de l'UI MCP.
import { useTransition, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { approveOauthConsent, denyOauthConsent } from "@/lib/actions/mcp-oauth-actions";

export function ConsentForm(
  { clientName, clientId, consentCode }: { clientName: string; clientId: string; consentCode: string },
) {
  const [canWrite, setCanWrite] = useState(true);
  const [canReadArticles, setCanReadArticles] = useState(false);
  const [pending, start] = useTransition();

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Autoriser <span className="font-medium text-foreground">{clientName}</span> à accéder à
        votre espace MAIMP ?
      </p>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label htmlFor="canWrite">Écriture (créer / modifier des projets vidéo)</Label>
          <Switch id="canWrite" checked={canWrite} onCheckedChange={setCanWrite} />
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="canReadArticles">Lire les articles éditoriaux</Label>
          <Switch id="canReadArticles" checked={canReadArticles} onCheckedChange={setCanReadArticles} />
        </div>
      </div>
      <div className="flex gap-3">
        <Button
          variant="outline" disabled={pending}
          onClick={() => start(() => { void denyOauthConsent(consentCode); })}
        >
          Refuser
        </Button>
        <Button
          disabled={pending}
          onClick={() => start(() => {
            void approveOauthConsent({ clientId, consentCode, canWrite, canReadArticles });
          })}
        >
          Autoriser
        </Button>
      </div>
    </div>
  );
}
