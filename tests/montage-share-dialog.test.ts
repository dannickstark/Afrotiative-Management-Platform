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
const { MontageShareDialog } = await import("@/components/video/montage-share-dialog");

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
