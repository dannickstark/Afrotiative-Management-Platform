"use client";
// components/settings/mcp/oauth-connections.tsx — Task 7: « Connexions OAuth », le panneau qui
// liste les clients OAuth (claude.ai web) autorisés et permet de les révoquer. Miroir de
// components/settings/mcp/token-list.tsx : useTransition par action, toast + router.refresh() sur
// succès, ConfirmDialog destructif pour la révocation. Différence structurelle : pas de formulaire
// de création ici — la ligne n'existe qu'après le passage par /oauth/authorize (Task 6).
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/shell/empty-state";
import { formatDate } from "@/lib/format";
import { revokeOauthConnection } from "@/lib/actions/mcp-oauth-actions";
import type { OauthConnectionRow } from "@/lib/queries/mcp-oauth";

export function OAuthConnections({
  connections,
  showOwner,
}: {
  connections: OauthConnectionRow[];
  // "video:configure" — même paire de droits que TokenList's seesAll (components/settings/mcp/
  // token-list.tsx) : détermine à la fois quelles connexions sont déjà dans `connections`
  // (calculé par la page) et qui peut révoquer LAQUELLE ici.
  showOwner: boolean;
}) {
  if (connections.length === 0) {
    return <EmptyState title="Aucune connexion" hint="Aucune connexion OAuth active pour l'instant." />;
  }

  return (
    <div className="space-y-2">
      {connections.map((c) => (
        <OAuthConnectionRowItem key={c.id} connection={c} showOwner={showOwner} />
      ))}
    </div>
  );
}

function OAuthConnectionRowItem({
  connection,
  showOwner,
}: {
  connection: OauthConnectionRow;
  showOwner: boolean;
}) {
  const router = useRouter();
  const [isRevoking, startRevoke] = useTransition();

  function handleRevoke() {
    startRevoke(async () => {
      try {
        const res = await revokeOauthConnection(connection.id);
        if (!res.ok) {
          toast.error(res.message ?? "Échec de la révocation.");
          return;
        }
        toast.success("Connexion révoquée.");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec de la révocation.");
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{connection.clientName ?? connection.clientId}</span>
          {showOwner && connection.ownerName && (
            <span className="truncate text-xs text-muted-foreground">{connection.ownerName}</span>
          )}
          {!connection.canWrite && <Badge variant="secondary">Lecture seule</Badge>}
          {!connection.canReadArticles && <Badge variant="secondary">Sans articles</Badge>}
        </div>
        <span className="text-xs text-muted-foreground">
          Créée le {formatDate(connection.createdAt)} · Dernière utilisation : {formatDate(connection.lastUsedAt)}
        </span>
      </div>
      <ConfirmDialog
        trigger={
          <Button
            variant="ghost" size="sm" disabled={isRevoking}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            {isRevoking && <Loader2 className="animate-spin" aria-hidden />}
            Révoquer
          </Button>
        }
        title="Révoquer cette connexion ?"
        description="Le client OAuth perdra immédiatement l'accès. Il devra être ré-autorisé."
        confirmLabel="Révoquer"
        destructive
        onConfirm={handleRevoke}
      />
    </div>
  );
}
