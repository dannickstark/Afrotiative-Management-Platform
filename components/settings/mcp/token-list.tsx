"use client";
// components/settings/mcp/token-list.tsx — Task 7: « Jetons », le deuxième panneau de
// /settings/mcp (spec §6). Même patron d'écriture que
// components/settings/openrouter-tokens-panel.tsx : useTransition par action, toast +
// router.refresh() sur succès, ConfirmDialog pour la révocation. Différence structurelle
// délibérée : le jeton en clair n'existe qu'une fois, dans la réponse de createApiToken
// (lib/actions/mcp-actions.ts) — ce composant le garde en état local UNIQUEMENT le temps de
// l'afficher avec son avertissement, jamais renvoyé au serveur, jamais journalisé.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Plus, TriangleAlert } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/shell/empty-state";
import { formatDate } from "@/lib/format";
import { createApiToken, revokeApiToken } from "@/lib/actions/mcp-actions";
import type { TokenRow } from "@/lib/queries/mcp";

export function TokenList({
  tokens,
  currentUserId,
  seesAll,
}: {
  tokens: TokenRow[];
  currentUserId: string;
  // "video:configure" — voir components/settings/mcp/connection-panel.tsx. Détermine à la fois
  // quels jetons sont déjà dans `tokens` (calculé par la page) et qui peut révoquer LEQUEL ici :
  // sans ce droit, révoquer reste réservé à ses propres jetons (lib/actions/mcp-actions.ts's
  // revokeApiToken refait le même contrôle côté serveur).
  seesAll: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<{ name: string; token: string } | null>(null);
  const [isCreating, startCreating] = useTransition();

  function handleCreate() {
    if (!name.trim()) {
      setCreateError("Le nom du jeton est requis.");
      return;
    }
    setCreateError(null);
    startCreating(async () => {
      try {
        const res = await createApiToken(name.trim());
        if (!res.ok) {
          setCreateError(res.message);
          toast.error(res.message);
          return;
        }
        setJustCreated({ name: name.trim(), token: res.token });
        setName("");
        toast.success("Jeton créé.");
        router.refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Échec de la création.";
        setCreateError(message);
        toast.error(message);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Jetons</CardTitle>
        <CardDescription>
          {seesAll
            ? "Vos jetons et ceux du reste de l'équipe — chacun n'authentifie que le rôle de la personne qui l'a créé."
            : "Vos jetons d'accès au serveur MCP."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {justCreated && (
          <div className="space-y-2 rounded-lg border border-[var(--status-pending)]/30 bg-[var(--status-pending)]/10 px-3 py-3">
            <div className="flex items-center gap-2 text-sm font-medium text-[var(--status-pending)]">
              <TriangleAlert className="size-4" aria-hidden />
              Notez ce jeton maintenant — il ne sera plus jamais affiché.
            </div>
            <code className="block overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-xs">
              {justCreated.token}
            </code>
            <Button variant="ghost" size="sm" onClick={() => setJustCreated(null)}>
              J&#39;ai noté le jeton
            </Button>
          </div>
        )}

        {tokens.length === 0 ? (
          <EmptyState title="Aucun jeton" hint="Créez-en un pour connecter un agent au module vidéo." />
        ) : (
          <div className="space-y-2">
            {tokens.map((t) => (
              <TokenListRow key={t.id} token={t} canRevoke={seesAll || t.userId === currentUserId} />
            ))}
          </div>
        )}
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-3 border-t border-border pt-4">
        <div className="space-y-1.5">
          <Label htmlFor="new-token-name">Nom du jeton</Label>
          <Input
            id="new-token-name" disabled={isCreating}
            value={name} onChange={(e) => setName(e.target.value)}
            placeholder="ex. Claude Desktop, portable"
          />
        </div>
        {createError && <p className="text-sm text-destructive" role="alert">{createError}</p>}
        <Button onClick={handleCreate} disabled={isCreating} className="self-end">
          {isCreating ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
          {isCreating ? "Création…" : "Créer un jeton"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function TokenListRow({ token, canRevoke }: { token: TokenRow; canRevoke: boolean }) {
  const router = useRouter();
  const [isRevoking, startRevoke] = useTransition();
  const revoked = token.revokedAt !== null;

  function handleRevoke() {
    startRevoke(async () => {
      try {
        const res = await revokeApiToken(token.id);
        if (!res.ok) {
          toast.error(res.message ?? "Échec de la révocation.");
          return;
        }
        toast.success(`« ${token.name} » révoqué.`);
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
          <span className="truncate font-medium">{token.name}</span>
          <code className="text-xs text-muted-foreground">{token.prefix}…</code>
          {revoked && (
            <Badge variant="outline" className="bg-[var(--status-draft)]/15 text-[var(--status-draft)] border-[var(--status-draft)]/30">
              Révoqué
            </Badge>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          Créé le {formatDate(token.createdAt)} · Dernière utilisation : {formatDate(token.lastUsedAt)}
          {revoked && ` · Révoqué le ${formatDate(token.revokedAt)}`}
        </span>
      </div>
      {!revoked && canRevoke && (
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
          title={`Révoquer « ${token.name} » ?`}
          description="Ce jeton cessera immédiatement de fonctionner. La ligne reste dans l'historique — c'est une révocation, pas une suppression."
          confirmLabel="Révoquer"
          destructive
          onConfirm={handleRevoke}
        />
      )}
    </div>
  );
}
