import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { installDom, mount, click, flush } from "./dom-harness";
import * as React from "react";
import { DiffReview } from "@/components/video/diff-review";
import { IssueList } from "@/components/video/import-panel";
import type { Diff } from "@/lib/video/import";

let teardown: () => void;
beforeAll(() => { teardown = installDom(); });
afterAll(() => { teardown(); });

const snap = {
  kind: "narration" as const, spokenText: "<p>texte</p>", directionNote: null, screenText: null,
  transitionIn: null, transitionOut: null, sources: [], inserts: [],
};

const diff: Diff = {
  added: [{ externalId: "b-03", kind: "ajout", fields: ["spokenText"], next: snap, position: 2 }],
  modified: [{ externalId: "b-01", kind: "modification", fields: ["spokenText"], next: snap, position: 0 }],
  conflicts: [{ externalId: "b-02", fields: ["spokenText"], base: snap, ours: { ...snap, spokenText: "<p>ma version</p>" }, theirs: { ...snap, spokenText: "<p>sa version</p>" }, position: 1 }],
  removed: [{ externalId: "b-09" }],
  order: ["b-01", "b-02", "b-03"],
};

describe("DiffReview", () => {
  it("coche par défaut les ajouts et les modifications, pas les suppressions ni les conflits", async () => {
    let accepted: string[] | null = null;
    const { container, unmount } = await mount(
      React.createElement(DiffReview, { diff, onApply: (a: string[]) => { accepted = a; } }),
    );
    click(container.querySelector("[data-testid=apply]") as HTMLElement);
    await flush();
    expect(accepted!.sort()).toEqual(["b-01", "b-03"]);
    unmount();
  });

  it("un conflit coché applique la version de Claude", async () => {
    let accepted: string[] | null = null;
    const { container, unmount } = await mount(
      React.createElement(DiffReview, { diff, onApply: (a: string[]) => { accepted = a; } }),
    );
    click(container.querySelector("[data-testid=accept-b-02]") as HTMLElement);
    click(container.querySelector("[data-testid=apply]") as HTMLElement);
    await flush();
    expect(accepted!).toContain("b-02");
    unmount();
  });

  it("montre les deux versions d'un conflit", async () => {
    const { container, unmount } = await mount(React.createElement(DiffReview, { diff, onApply: () => {} }));
    expect(container.textContent).toContain("ma version");
    expect(container.textContent).toContain("sa version");
    unmount();
  });

  it("annonce une suppression comme proposée, non appliquée", async () => {
    const { container, unmount } = await mount(React.createElement(DiffReview, { diff, onApply: () => {} }));
    expect(container.textContent).toContain("b-09");
    expect(container.textContent).toContain("Suppression proposée");
    unmount();
  });

  // Round de correction 1, C1 — verrouille le chemin exact d'ImportPanel : coller, échouer, corriger,
  // ré-analyser AVEC SUCCÈS. `prepared` (donc `diff`) est remplacé sans démonter DiffReview — même
  // composant, même position, React conserve `accepted` entre les deux rendus. `rerender` (pas un
  // second `mount`) reproduit exactement ça : un même `externalId` coché parce qu'il était un AJOUT
  // dans le premier diff ne doit PLUS être coché s'il devient une SUPPRESSION dans le second.
  it("ne garde pas une case cochée d'un diff précédent quand le même externalId change de nature", async () => {
    const diffA: Diff = {
      added: [{ externalId: "b-01", kind: "ajout", fields: ["spokenText"], next: snap, position: 0 }],
      modified: [], conflicts: [], removed: [], order: ["b-01"],
    };
    const diffB: Diff = {
      added: [], modified: [], conflicts: [],
      removed: [{ externalId: "b-01" }],
      order: [],
    };
    let accepted: string[] | null = null;
    const { container, rerender, unmount } = await mount(
      React.createElement(DiffReview, { diff: diffA, onApply: (a: string[]) => { accepted = a; } }),
    );
    // b-01 est bien coché dans le premier diff (ajout, cochée par défaut).
    expect((container.querySelector("[data-testid=accept-b-01]") as HTMLElement).getAttribute("aria-checked")).toBe("true");

    await rerender(React.createElement(DiffReview, { diff: diffB, onApply: (a: string[]) => { accepted = a; } }));

    expect((container.querySelector("[data-testid=accept-b-01]") as HTMLElement).getAttribute("aria-checked")).toBe("false");
    click(container.querySelector("[data-testid=apply]") as HTMLElement);
    await flush();
    expect(accepted!).toEqual([]);
    unmount();
  });
});

describe("IssueList", () => {
  it("affiche le chemin et le message de chaque erreur", async () => {
    const { container, unmount } = await mount(React.createElement(IssueList, {
      issues: [{ path: "variantes[0].beats[6].type", message: "type inconnu « bviroll »", received: "bviroll" }],
    }));
    expect(container.textContent).toContain("variantes[0].beats[6].type");
    expect(container.textContent).toContain("bviroll");
    unmount();
  });
});
