"use client";
// components/settings/openrouter-tokens-panel.tsx — Task 7: the OpenRouter token pool manager UI.
// MOUNTED on /settings/integrations by a later task (Task 9) — this component owns only ITS OWN
// Card section (list + add form), not a full page: components/settings/integration-cards.tsx
// already renders that page's <PageHeader title="Intégrations">, so this component starts straight
// at <Card>.
//
// Write-only credential pattern, same as components/settings/social-channel-form.tsx's
// "Identifiants" card: the token INPUT is `type="password" autoComplete="off"`, held in local
// state, and cleared on every successful add — never pre-filled, because there is nothing to
// pre-fill from in the first place. getOpenRouterTokensMasked (lib/queries/openrouter-tokens.ts)
// never SELECTs the ciphertext column, and none of the guarded actions in
// lib/actions/openrouter-token-actions.ts ever return a token value — this component physically
// cannot render or re-send a jeton it once received.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/shell/empty-state";
import { formatDate } from "@/lib/format";
import {
  addOpenRouterToken, deleteOpenRouterToken, setOpenRouterTokenActive, testOpenRouterToken,
} from "@/lib/actions/openrouter-token-actions";
import type { MaskedToken } from "@/lib/queries/openrouter-tokens";

// PURE, exported for tests/openrouter-tokens-panel.test.ts — no React/DOM dependency, so it is unit-
// tested directly without rendering anything (same "no React component testing" constraint as every
// other pure formatter in this repo, e.g. lib/format.ts's statusLabel/pipelineStatusLabel).
// `now` is threaded in as a parameter rather than read via `new Date()` inside the function, so the
// cooldown branch (`cooldownUntil > now`) is deterministic under test instead of racing the clock —
// same idiom lib/format.ts uses for its own now-relative helpers where testability matters.
const LAST_STATUS_LABEL: Record<string, string> = {
  ok: "OK",
  rate_limited: "Quota atteint",
  auth_failed: "Clé refusée",
  flaky: "Réponse faible",
  error: "Erreur",
};

export function tokenStatusLabel(
  t: { active: boolean; lastStatus: string | null; cooldownUntil: Date | null },
  now: Date,
): string {
  if (!t.active) return "Désactivé";
  if (t.cooldownUntil && t.cooldownUntil > now) {
    const hh = String(t.cooldownUntil.getHours()).padStart(2, "0");
    const mm = String(t.cooldownUntil.getMinutes()).padStart(2, "0");
    return `En pause (jusqu'à ${hh}:${mm})`;
  }
  if (t.lastStatus === null) return "—";
  return LAST_STATUS_LABEL[t.lastStatus] ?? "Erreur";
}

// Badge color-coding, keyed off the SAME three-way state tokenStatusLabel resolves (inactive /
// cooling down / lastStatus) — kept as a separate, un-exported helper so tokenStatusLabel itself
// stays exactly the plain string-returning formatter the brief specifies, while the list can still
// color-code rows the way feeds-table.tsx/members-table.tsx color-code their own status badges
// (green --status-approved / amber --status-pending / red --status-error / slate --status-draft).
function tokenBadgeStyle(t: { active: boolean; lastStatus: string | null; cooldownUntil: Date | null }, now: Date): string {
  if (!t.active) return "bg-[var(--status-draft)]/15 text-[var(--status-draft)] border-[var(--status-draft)]/30";
  if (t.cooldownUntil && t.cooldownUntil > now) {
    return "bg-[var(--status-pending)]/15 text-[var(--status-pending)] border-[var(--status-pending)]/30";
  }
  switch (t.lastStatus) {
    case "ok":
      return "bg-[var(--status-approved)]/15 text-[var(--status-approved)] border-[var(--status-approved)]/30";
    case "rate_limited":
    case "flaky":
      return "bg-[var(--status-pending)]/15 text-[var(--status-pending)] border-[var(--status-pending)]/30";
    case "auth_failed":
    case "error":
      return "bg-[var(--status-error)]/15 text-[var(--status-error)] border-[var(--status-error)]/30";
    default:
      return "bg-[var(--status-draft)]/15 text-[var(--status-draft)] border-[var(--status-draft)]/30";
  }
}

export function OpenRouterTokensPanel({
  tokens, cryptoConfigured,
}: {
  tokens: MaskedToken[];
  // Whether CREDENTIALS_ENCRYPTION_KEY is set — computed server-side by the page (getCryptoConfig,
  // lib/diffusion/crypto.ts) and handed down as a plain boolean, same "server computes, client only
  // renders" split as social-channel-form.tsx's `isConfigured` prop. addOpenRouterToken already
  // refuses server-side when the key is missing (NO_KEY_MESSAGE), so this prop is purely a UX
  // nicety — disabling the form up front instead of letting an admin fill it in and only then learn
  // it can never be saved.
  cryptoConfigured: boolean;
}) {
  const router = useRouter();

  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [isAdding, startAdding] = useTransition();

  function handleAdd() {
    if (!label.trim() || !token.trim()) {
      setAddError("Le libellé et le jeton sont requis.");
      return;
    }
    setAddError(null);
    startAdding(async () => {
      try {
        const res = await addOpenRouterToken({ label: label.trim(), token: token.trim() });
        if (!res.ok) {
          setAddError(res.error ?? "Échec de l'ajout.");
          toast.error(res.error ?? "Échec de l'ajout.");
          return;
        }
        setLabel("");
        setToken(""); // write-only: never keep what was just typed, saved or not
        toast.success("Jeton ajouté.");
        router.refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Échec de l'ajout.";
        setAddError(message);
        toast.error(message);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Jetons OpenRouter</CardTitle>
        <CardDescription>
          Bassin de jetons OpenRouter utilisés en rotation pour la génération d&apos;articles. Un
          jeton désactivé ou en pause est ignoré par la rotation jusqu&apos;à ce qu&apos;il
          redevienne disponible.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {tokens.length === 0 ? (
          <EmptyState
            title="Aucun jeton enregistré"
            hint="Seul le jeton OpenRouter défini dans l'environnement (OPENROUTER_API_KEY) est utilisé pour l'instant."
          />
        ) : (
          <div className="space-y-2">
            {tokens.map((t) => (
              <TokenRow key={t.id} token={t} />
            ))}
          </div>
        )}
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-3 border-t border-border pt-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="new-token-label">Nom du compte / libellé</Label>
            <Input
              id="new-token-label" disabled={isAdding || !cryptoConfigured}
              value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder="ex. Compte principal"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-token-value">Jeton</Label>
            <Input
              id="new-token-value" type="password" autoComplete="off" disabled={isAdding || !cryptoConfigured}
              value={token} onChange={(e) => setToken(e.target.value)}
              placeholder="sk-or-…"
            />
          </div>
        </div>
        {addError && <p className="text-sm text-destructive" role="alert">{addError}</p>}
        {!cryptoConfigured && (
          <p className="text-xs text-muted-foreground">
            Le chiffrement des jetons n&apos;est pas configuré (CREDENTIALS_ENCRYPTION_KEY).
          </p>
        )}
        <Button onClick={handleAdd} disabled={isAdding || !cryptoConfigured} className="self-end">
          {isAdding ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
          {isAdding ? "Ajout…" : "Ajouter"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function TokenRow({ token }: { token: MaskedToken }) {
  const router = useRouter();
  const now = new Date();

  const [isToggling, startToggle] = useTransition();
  const [isTesting, startTest] = useTransition();
  const [isDeleting, startDelete] = useTransition();
  const busy = isToggling || isTesting || isDeleting;

  function handleToggle() {
    startToggle(async () => {
      try {
        const res = await setOpenRouterTokenActive(token.id, !token.active);
        if (!res.ok) {
          toast.error(res.error ?? "Échec de la mise à jour.");
          return;
        }
        toast.success(token.active ? `« ${token.label} » désactivé.` : `« ${token.label} » activé.`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec de la mise à jour.");
      }
    });
  }

  function handleTest() {
    startTest(async () => {
      try {
        const res = await testOpenRouterToken(token.id);
        if (res.ok) toast.success(`« ${token.label} » : connexion vérifiée.`);
        else toast.error(res.error ?? "Échec du test.");
        // testOpenRouterToken writes lastStatus/lastUsedAt server-side on EVERY outcome, ok or not
        // (see its own comment in lib/actions/openrouter-token-actions.ts) — so the row is resynced
        // unconditionally here, unlike handleToggle/handleDelete below which only refresh on ok.
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec du test.");
      }
    });
  }

  function handleDelete() {
    startDelete(async () => {
      try {
        const res = await deleteOpenRouterToken(token.id);
        if (!res.ok) {
          toast.error(res.error ?? "Échec de la suppression.");
          return;
        }
        toast.success(`« ${token.label} » supprimé.`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec de la suppression.");
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{token.label}</span>
          <Badge variant="outline" className={tokenBadgeStyle(token, now)}>
            {tokenStatusLabel(token, now)}
          </Badge>
        </div>
        <span className="text-xs text-muted-foreground">
          Dernière utilisation : {formatDate(token.lastUsedAt)}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" onClick={handleToggle} disabled={busy}>
          {isToggling && <Loader2 className="animate-spin" aria-hidden />}
          {token.active ? "Désactiver" : "Activer"}
        </Button>
        <Button variant="ghost" size="sm" onClick={handleTest} disabled={busy}>
          {isTesting && <Loader2 className="animate-spin" aria-hidden />}
          Tester
        </Button>
        <ConfirmDialog
          trigger={
            <Button
              variant="ghost" size="sm" disabled={busy}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              Supprimer
            </Button>
          }
          title={`Supprimer « ${token.label} » ?`}
          description="Ce jeton sera retiré du bassin de rotation. Cette action est irréversible."
          confirmLabel="Supprimer"
          destructive
          onConfirm={handleDelete}
        />
      </div>
    </div>
  );
}
