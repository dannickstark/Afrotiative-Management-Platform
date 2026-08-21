"use client";
// components/video/montage-share-panel.tsx — Task 7 : panneau « Accès monteur » de l'onglet
// Montage. Même patron d'écriture que components/settings/mcp/token-list.tsx : useTransition par
// action, toast + router.refresh() sur succès, ConfirmDialog pour la révocation. Même différence
// structurelle délibérée que ce panneau : le lien en clair n'existe qu'une fois, dans la réponse
// de createShareLink (lib/actions/montage-actions.ts) — ce composant le garde en état local
// UNIQUEMENT le temps de l'afficher avec son avertissement, jamais renvoyé au serveur, jamais
// journalisé.
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
import { createShareLink, revokeShareLink } from "@/lib/actions/montage-actions";
import type { ShareRow } from "@/lib/montage/access";

type ShareStatus = "actif" | "expiré" | "révoqué";

function statusOf(share: ShareRow): ShareStatus {
  if (share.revokedAt) return "révoqué";
  if (share.expiresAt && share.expiresAt.getTime() < Date.now()) return "expiré";
  return "actif";
}

export function MontageSharePanel({
  projectId, shares, canManage,
}: {
  projectId: string;
  shares: ShareRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [expiresAt, setExpiresAt] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<string | null>(null);
  const [isCreating, startCreating] = useTransition();

  function handleCreate() {
    setCreateError(null);
    startCreating(async () => {
      try {
        const res = await createShareLink({
          projectId,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        });
        if (!res.ok) {
          setCreateError(res.message);
          toast.error(res.message);
          return;
        }
        setJustCreated(res.url);
        setExpiresAt("");
        toast.success("Lien monteur créé.");
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
        <CardTitle>Accès monteur</CardTitle>
        <CardDescription>
          Liens partageables donnant un accès en lecture au conducteur, sans compte.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {justCreated && (
          <div className="space-y-2 rounded-lg border border-[var(--status-pending)]/30 bg-[var(--status-pending)]/10 px-3 py-3">
            <div className="flex items-center gap-2 text-sm font-medium text-[var(--status-pending)]">
              <TriangleAlert className="size-4" aria-hidden />
              Copiez ce lien — il ne sera plus affiché.
            </div>
            <code className="block overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-xs">
              {justCreated}
            </code>
            <Button variant="ghost" size="sm" onClick={() => setJustCreated(null)}>
              J&#39;ai copié le lien
            </Button>
          </div>
        )}

        {shares.length === 0 ? (
          <EmptyState title="Aucun lien monteur" hint="Créez-en un pour donner un accès en lecture au conducteur." />
        ) : (
          <div className="space-y-2">
            {shares.map((s) => (
              <MontageShareRow key={s.id} share={s} canRevoke={canManage} />
            ))}
          </div>
        )}
      </CardContent>
      {canManage && (
        <CardFooter className="flex-col items-stretch gap-3 border-t border-border pt-4">
          <div className="space-y-1.5">
            <Label htmlFor="new-share-expires">Expiration (facultatif)</Label>
            <Input
              id="new-share-expires" type="date" disabled={isCreating}
              value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)}
            />
          </div>
          {createError && <p className="text-sm text-destructive" role="alert">{createError}</p>}
          <Button onClick={handleCreate} disabled={isCreating} className="self-end">
            {isCreating ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
            {isCreating ? "Création…" : "Créer un lien"}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

function MontageShareRow({ share, canRevoke }: { share: ShareRow; canRevoke: boolean }) {
  const router = useRouter();
  const [isRevoking, startRevoke] = useTransition();
  const status = statusOf(share);

  function handleRevoke() {
    startRevoke(async () => {
      try {
        const res = await revokeShareLink(share.id);
        if (!res.ok) {
          toast.error(res.message ?? "Échec de la révocation.");
          return;
        }
        toast.success("Lien monteur révoqué.");
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
          {status === "actif" && (
            <Badge variant="outline" className="bg-[var(--status-approved)]/15 text-[var(--status-approved)] border-[var(--status-approved)]/30">
              Actif
            </Badge>
          )}
          {status === "expiré" && <Badge variant="secondary">Expiré</Badge>}
          {status === "révoqué" && (
            <Badge variant="outline" className="bg-[var(--status-draft)]/15 text-[var(--status-draft)] border-[var(--status-draft)]/30">
              Révoqué
            </Badge>
          )}
          {share.createdByName && <span className="truncate text-xs text-muted-foreground">{share.createdByName}</span>}
        </div>
        <span className="text-xs text-muted-foreground">
          Créé le {formatDate(share.createdAt)}
          {" · "}Dernier accès : {formatDate(share.lastAccessedAt)}
          {share.expiresAt && ` · Expire le ${formatDate(share.expiresAt)}`}
        </span>
      </div>
      {status !== "révoqué" && canRevoke && (
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
          title="Révoquer ce lien monteur ?"
          description="Ce lien cessera immédiatement de fonctionner. La ligne reste dans l'historique — c'est une révocation, pas une suppression."
          confirmLabel="Révoquer"
          destructive
          onConfirm={handleRevoke}
        />
      )}
    </div>
  );
}
