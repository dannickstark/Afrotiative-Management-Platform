import { describe, it, expect, mock } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ShareRow } from "@/lib/montage/access";

// MontageShareDialog forwards straight into base-ui's Dialog, which (correctly) doesn't render
// DialogContent's children into static markup while closed — confirmed by hand: only the trigger
// button shows up in renderToStaticMarkup output when the dialog starts closed. That's the right
// behavior for the real component, but it means a plain render can't see what's forwarded to
// MontageSharePanel. So this test stubs both the real Dialog primitives (unconditional render of
// children, ignoring open state — the open/close mechanics themselves are base-ui's concern, not
// ours) and MontageSharePanel (a passthrough that prints the exact `canManage` value it receives),
// to verify MontageShareDialog's own job: render the trigger, and forward `canManage` unchanged.
//
// `mock.module` est PROCESS-GLOBAL sous Bun : ce remplacement fuiterait vers tout autre fichier de
// test partageant le processus. C'est sans danger uniquement parce que la voie pure lance
// `bun test --isolate` (scripts/test-fast.ts) — un `globalThis` neuf par fichier. Ne pas retirer
// `--isolate` de cette voie sans revoir ce fichier.
mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
  DialogTrigger: ({ render }: { render: React.ReactElement }) => render,
  DialogContent: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}));
mock.module("@/components/video/montage-share-panel", () => ({
  MontageSharePanel: ({ canManage }: { canManage: boolean }) =>
    React.createElement("span", { "data-testid": "panel-can-manage" }, String(canManage)),
}));
const { MontageShareDialog, mayCloseShareDialog } = await import("@/components/video/montage-share-dialog");

describe("MontageShareDialog", () => {
  const shares: ShareRow[] = [];

  it("rend le bouton déclencheur « Accès monteur »", () => {
    const html = renderToStaticMarkup(
      React.createElement(MontageShareDialog, { projectId: "p-1", shares, canManage: true }),
    );
    expect(html).toContain("Accès monteur");
  });

  it("transmet canManage=true tel quel à MontageSharePanel", () => {
    const html = renderToStaticMarkup(
      React.createElement(MontageShareDialog, { projectId: "p-1", shares, canManage: true }),
    );
    expect(html).toContain('data-testid="panel-can-manage">true');
  });

  it("transmet canManage=false tel quel à MontageSharePanel", () => {
    const html = renderToStaticMarkup(
      React.createElement(MontageShareDialog, { projectId: "p-1", shares, canManage: false }),
    );
    expect(html).toContain('data-testid="panel-can-manage">false');
  });
});

// La règle « ce dialogue peut-il se fermer ? » est extraite en prédicat pur (même patron que
// resolveExpandedId, components/video/tournage-progress.tsx) : les trois tests de rendu ci-dessus
// passent par des primitives Dialog moquées et ne peuvent donc rien prouver de la garde elle-même.
describe("mayCloseShareDialog", () => {
  it("laisse toujours ouvrir le dialogue", () => {
    expect(mayCloseShareDialog(true, true)).toBe(true);
    expect(mayCloseShareDialog(true, false)).toBe(true);
  });

  it("laisse fermer quand aucun lien fraîchement créé n'attend d'être copié", () => {
    expect(mayCloseShareDialog(false, false)).toBe(true);
  });

  it("refuse la fermeture tant qu'un lien fraîchement créé n'a pas été acquitté", () => {
    expect(mayCloseShareDialog(false, true)).toBe(false);
  });
});
