import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCatalog } from "@/components/settings/mcp/tool-catalog";
import { ConnectionPanel } from "@/components/settings/mcp/connection-panel";
import { TOOL_REGISTRY } from "@/lib/mcp/registry";

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
