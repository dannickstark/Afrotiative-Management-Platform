import { describe, it, expect, mock } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCatalog } from "@/components/settings/mcp/tool-catalog";
import { ConnectionPanel } from "@/components/settings/mcp/connection-panel";
import { TOOL_REGISTRY } from "@/lib/mcp/registry";
import type { TokenRow } from "@/lib/queries/mcp";

// TokenList appelle useRouter() (next/navigation), qui exige un arbre App Router monté — sans ce
// mock, renderToStaticMarkup échoue avec « invariant expected app router to be mounted ». Même
// recette que tests/studio-editor-shell.test.ts : posée AVANT le premier import du composant, donc
// import dynamique et non statique (les imports statiques sont hissés).
const realNavigation = await import("next/navigation");
mock.module("next/navigation", () => ({
  ...realNavigation,
  useRouter: () => ({
    push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, forward: () => {}, prefetch: () => {},
  }),
}));
const { TokenList } = await import("@/components/settings/mcp/token-list");

describe("ToolCatalog", () => {
  it("affiche TOUS les outils du registre — un outil absent serait un pouvoir accordé en silence", () => {
    const html = renderToStaticMarkup(React.createElement(ToolCatalog));
    for (const t of TOOL_REGISTRY) expect(html).toContain(t.name);
  });

  it("distingue lecture et écriture", () => {
    const html = renderToStaticMarkup(React.createElement(ToolCatalog));
    expect(html).toContain("Lecture");
    expect(html).toContain("Écriture");
  });

  it("dit explicitement que l'annulation n'est pas exposée", () => {
    const html = renderToStaticMarkup(React.createElement(ToolCatalog));
    expect(html).toContain("annuler");
  });
});

describe("ConnectionPanel", () => {
  const props = { serverUrl: "https://exemple.test/api/mcp", enabled: true };

  it("affiche l'adresse du serveur", () => {
    const html = renderToStaticMarkup(React.createElement(ConnectionPanel, props));
    expect(html).toContain("https://exemple.test/api/mcp");
  });

  it("ne contient JAMAIS de jeton réel dans les extraits de configuration", () => {
    const html = renderToStaticMarkup(React.createElement(ConnectionPanel, props));
    expect(html).not.toMatch(/afro_vid_[A-Za-z0-9_-]{10,}/);
    expect(html).toContain("VOTRE_JETON");
  });

  it("dit que claude.ai web attend OAuth", () => {
    const html = renderToStaticMarkup(React.createElement(ConnectionPanel, props));
    expect(html).toContain("OAuth");
  });

  it("signale un serveur désactivé", () => {
    const html = renderToStaticMarkup(React.createElement(ConnectionPanel, { ...props, enabled: false }));
    expect(html).toContain("désactivé");
  });
});

// ── Round de correction final, I2 ────────────────────────────────────────────
// Le spec §6.2 promet « nom, préfixe, PROPRIÉTAIRE, dernière utilisation, date de création ». Le
// porteur n'apparaissait nulle part : la vue « toute l'équipe » — seul intérêt du droit
// video:configure sur ce panneau — montrait à un admin des jetons sans dire à qui ils sont.
describe("TokenList — propriétaire du jeton", () => {
  const base: TokenRow = {
    id: "t-1", userId: "u-moi", name: "Portable", prefix: "afro_vid_abc",
    ownerName: "Awa Diallo", canWrite: true, canReadArticles: true,
    lastUsedAt: null, revokedAt: null, createdAt: new Date("2026-08-01T10:00:00Z"),
  };
  const autre: TokenRow = {
    ...base, id: "t-2", userId: "u-autre", name: "Poste rédaction", prefix: "afro_vid_xyz",
    ownerName: "Moussa Traoré",
  };

  function html(tokens: TokenRow[], seesAll: boolean) {
    return renderToStaticMarkup(React.createElement(TokenList, {
      tokens, currentUserId: "u-moi", seesAll,
    }));
  }

  it("nomme le porteur d'un jeton qui n'est pas le sien", () => {
    expect(html([base, autre], true)).toContain("Moussa Traoré");
  });

  it("ne répète pas son propre nom sur ses propres jetons", () => {
    expect(html([base, autre], true)).not.toContain("Awa Diallo");
  });

  it("ne nomme personne quand la vue est déjà limitée à ses propres jetons", () => {
    const sien = html([base], false);
    expect(sien).not.toContain("Awa Diallo");
  });
});
