import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, verification } from "@/db";
import { findOauthConsentGrant } from "@/lib/queries/mcp-oauth";

// Couvre le correctif "Task 6 review" : approveOauthConsent doit clouer la portée sur le
// userId/clientId AUTORITAIRES du consent_code (la ligne `verification` posée par le plugin OIDC
// de better-auth), jamais sur la session en cours ni sur le clientId soumis par le POST — sinon un
// clientId trafiqué ou un onglet resté ouvert après changement de session écrit la portée sous la
// mauvaise clé. Voir lib/queries/mcp-oauth.ts's findOauthConsentGrant.

const ids = ["consent-grant-valid", "consent-grant-expired", "consent-grant-malformed", "consent-grant-latest"];

afterAll(async () => {
  for (const id of ids) {
    await db.delete(verification).where(eq(verification.identifier, id));
  }
});

function row(identifier: string, value: string, msFromNow: number) {
  return {
    id: `${identifier}-row-${Math.random().toString(36).slice(2)}`,
    identifier,
    value,
    expiresAt: new Date(Date.now() + msFromNow),
  };
}

test("renvoie le userId/clientId authentiques pour un consent_code valide", async () => {
  await db.insert(verification).values(
    row("consent-grant-valid", JSON.stringify({ userId: "u-real", clientId: "c-real" }), 60_000),
  );
  expect(await findOauthConsentGrant("consent-grant-valid")).toEqual({ userId: "u-real", clientId: "c-real" });
});

test("renvoie null quand le consent_code est introuvable — jamais un scope non lié", async () => {
  expect(await findOauthConsentGrant("consent-grant-does-not-exist")).toBeNull();
});

test("renvoie null quand la ligne est expirée", async () => {
  await db.insert(verification).values(
    row("consent-grant-expired", JSON.stringify({ userId: "u-x", clientId: "c-x" }), -60_000),
  );
  expect(await findOauthConsentGrant("consent-grant-expired")).toBeNull();
});

test("renvoie null quand le JSON est malformé ou incomplet — jamais une valeur partielle", async () => {
  await db.insert(verification).values(
    row("consent-grant-malformed", JSON.stringify({ userId: "u-only" }), 60_000),
  );
  expect(await findOauthConsentGrant("consent-grant-malformed")).toBeNull();
});

test("prend la ligne la plus récente en cas de doublon d'identifiant", async () => {
  await db.insert(verification).values(
    row("consent-grant-latest", JSON.stringify({ userId: "u-old", clientId: "c-old" }), 60_000),
  );
  await new Promise((r) => setTimeout(r, 10));
  await db.insert(verification).values(
    row("consent-grant-latest", JSON.stringify({ userId: "u-new", clientId: "c-new" }), 60_000),
  );
  expect(await findOauthConsentGrant("consent-grant-latest")).toEqual({ userId: "u-new", clientId: "c-new" });
});
