import { describe, it, expect, mock } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OauthConnectionRow } from "@/lib/queries/mcp-oauth";

// OAuthConnections appelle useRouter() (next/navigation) via ConfirmDialog/le composant lui-même —
// sans ce mock, renderToStaticMarkup échoue avec « invariant expected app router to be mounted ».
// Même recette que tests/mcp-settings-ui.test.ts : posée AVANT le premier import du composant, donc
// import dynamique et non statique (les imports statiques sont hissés).
const realNavigation = await import("next/navigation");
mock.module("next/navigation", () => ({
  ...realNavigation,
  useRouter: () => ({
    push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, forward: () => {}, prefetch: () => {},
  }),
}));
const { OAuthConnections } = await import("@/components/settings/mcp/oauth-connections");

describe("OAuthConnections", () => {
  const rows: OauthConnectionRow[] = [{
    id: "s1", userId: "u1", ownerName: "Awa", clientId: "c1", clientName: "Claude (web)",
    canWrite: true, canReadArticles: false, createdAt: new Date("2026-08-20"), lastUsedAt: null,
  }];

  it("liste le client, affiche le badge « Sans articles » et le bouton Révoquer", () => {
    const html = renderToStaticMarkup(React.createElement(OAuthConnections, { connections: rows, showOwner: false }));
    expect(html).toContain("Claude (web)");
    expect(html).toContain("Sans articles");
    expect(html).toContain("Révoquer");
  });

  it("état vide", () => {
    const html = renderToStaticMarkup(React.createElement(OAuthConnections, { connections: [], showOwner: false }));
    expect(html).toContain("Aucune connexion");
  });
});
