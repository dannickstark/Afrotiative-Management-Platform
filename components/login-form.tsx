"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { error } = await signIn.email({ email, password });
    setLoading(false);
    if (error) {
      // Verified against Better-Auth 1.6.25's admin plugin (2026-08-03): a banned
      // account throws with body { code: "BANNED_USER", message: "You have been
      // banned…" }. better-fetch spreads that body onto the client error object,
      // so error.code === "BANNED_USER" here. Wrong password AND unknown email
      // both come back as { code: "INVALID_EMAIL_OR_PASSWORD" } — same generic
      // message for both, so we never leak whether an account exists.
      if (error.code === "BANNED_USER" || /ban/i.test(error.message ?? "")) {
        setError("Ce compte a été désactivé. Contactez un administrateur.");
      } else {
        setError("Email ou mot de passe incorrect.");
      }
      return;
    }
    router.push("/dashboard");
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader><CardTitle>Console éditoriale Afrotiative</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Mot de passe</Label>
            <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <p className="text-sm text-[var(--status-rejected)]" role="alert">{error}</p>}
          <Button type="submit" disabled={loading}
            className="w-full bg-[var(--accent-brand)] text-[var(--accent-brand-foreground)]">
            {loading ? "Connexion…" : "Se connecter"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
