// app/(app)/oauth/authorize/page.tsx — Task 6: écran de consentement OAuth où better-auth
// redirige claude.ai web (auth.ts's oidcConfig.consentPage). Placée sous (app) pour réutiliser
// requireUser() / la session — pas pour la chrome nav/sidebar du groupe, qui n'a pas vraiment sa
// place ici mais que le plan demande explicitement de garder (voir rapport de tâche).
import { eq } from "drizzle-orm";
import { db, oauthApplication } from "@/db";
import { requireUser } from "@/lib/session";
import { ConsentForm } from "@/components/oauth/consent-form";

export default async function OAuthAuthorizePage(
  { searchParams }: { searchParams: Promise<{ client_id?: string; consent_code?: string; scope?: string }> },
) {
  await requireUser(); // redirige vers /login si non connecté
  const { client_id, consent_code } = await searchParams;

  if (!client_id || !consent_code) {
    return <p className="p-8 text-sm text-muted-foreground">Requête d&#39;autorisation incomplète.</p>;
  }
  const [client] = await db
    .select({ name: oauthApplication.name })
    .from(oauthApplication)
    .where(eq(oauthApplication.clientId, client_id))
    .limit(1);

  return (
    <div className="mx-auto max-w-md p-8">
      <h1 className="mb-6 font-serif text-2xl">Autoriser l&#39;accès</h1>
      <ConsentForm
        clientName={client?.name ?? client_id}
        clientId={client_id}
        consentCode={consent_code}
      />
    </div>
  );
}
