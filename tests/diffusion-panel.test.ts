import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  computeSendDisabledReason, distributionStateView, formatSentAt, sendButtonLabel,
  CaptionCounter, SendAction, DiffusionStatusLine,
  type DiffusionDistributionView,
} from "@/components/article/diffusion-panel";

// ─────────────────────────────────────────────────────────────────────────────
// computeSendDisabledReason — Task 6's four required cases, PURE (no DOM needed). Each case is
// tested in isolation (every OTHER gate satisfied) so a bug that only breaks ONE gate can't hide
// behind another gate also being satisfied — a test that flipped several gates false at once would
// still pass if only one of the checks were actually wired up.
// ─────────────────────────────────────────────────────────────────────────────
describe("computeSendDisabledReason — les quatre cas requis", () => {
  const allGood = { isPublished: true, channelEnabled: true, r2Configured: true, canSend: true, channelLabel: "Facebook" };

  it("autorisé quand les quatre conditions sont réunies", () => {
    expect(computeSendDisabledReason(allGood)).toBeNull();
  });

  it("article non publié", () => {
    const reason = computeSendDisabledReason({ ...allGood, isPublished: false });
    expect(reason).not.toBeNull();
    expect(reason!.toLowerCase()).toContain("publi");
  });

  it("canal désactivé — nomme le canal", () => {
    const reason = computeSendDisabledReason({ ...allGood, channelEnabled: false });
    expect(reason).not.toBeNull();
    expect(reason).toContain("Facebook");
  });

  it("R2 non configuré", () => {
    const reason = computeSendDisabledReason({ ...allGood, r2Configured: false });
    expect(reason).not.toBeNull();
    expect(reason!.toUpperCase()).toContain("R2");
  });

  it("utilisateur sans social:send", () => {
    const reason = computeSendDisabledReason({ ...allGood, canSend: false });
    expect(reason).not.toBeNull();
    expect(reason!.toLowerCase()).toMatch(/permission|autoris/);
  });

  it("chaque cas produit un message DIFFÉRENT (pas un seul message générique recyclé)", () => {
    const reasons = new Set([
      computeSendDisabledReason({ ...allGood, isPublished: false }),
      computeSendDisabledReason({ ...allGood, channelEnabled: false }),
      computeSendDisabledReason({ ...allGood, r2Configured: false }),
      computeSendDisabledReason({ ...allGood, canSend: false }),
    ]);
    expect(reasons.size).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// distributionStateView — maps a raw distribution row to the panel's state, PURE.
// ─────────────────────────────────────────────────────────────────────────────
describe("distributionStateView", () => {
  it("null distribution -> jamais envoyé", () => {
    expect(distributionStateView(null)).toEqual({ kind: "never_sent" });
  });

  it("status 'sent' -> kind sent, porte sentAt/externalId", () => {
    const d: DiffusionDistributionView = {
      status: "sent", caption: "x", sentAt: new Date("2026-08-01T10:00:00Z"), lastError: null,
      externalId: "ext-1", attempts: 0, renderId: "r1", imageUrl: "https://x/y.png",
    };
    const v = distributionStateView(d);
    expect(v.kind).toBe("sent");
    if (v.kind !== "sent") throw new Error("unexpected");
    expect(v.externalId).toBe("ext-1");
  });

  it("status 'failed' -> kind failed, porte le message ET le nombre de tentatives", () => {
    const d: DiffusionDistributionView = {
      status: "failed", caption: "x", sentAt: null, lastError: "Erreur réseau simulée.",
      externalId: null, attempts: 2, renderId: "r1", imageUrl: "https://x/y.png",
    };
    const v = distributionStateView(d);
    expect(v).toEqual({ kind: "failed", message: "Erreur réseau simulée.", attempts: 2 });
  });

  it("status 'pending' -> kind pending", () => {
    const d: DiffusionDistributionView = {
      status: "pending", caption: "x", sentAt: null, lastError: null, externalId: null,
      attempts: 0, renderId: "r1", imageUrl: null,
    };
    expect(distributionStateView(d)).toEqual({ kind: "pending" });
  });
});

describe("sendButtonLabel", () => {
  it("« Publier sur {canal} » quand rien n'a encore été envoyé", () => {
    expect(sendButtonLabel({ kind: "never_sent" }, "Facebook")).toBe("Publier sur Facebook");
  });
  it("« Réessayer sur {canal} » après un échec", () => {
    expect(sendButtonLabel({ kind: "failed", message: "x", attempts: 1 }, "X")).toBe("Réessayer sur X");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rendered pieces — HTML statique (react-dom/server), même convention que
// components/article/image-panel.tsx::PreviewTabContent (pas de DOM sous `bun test`).
// ─────────────────────────────────────────────────────────────────────────────
describe("CaptionCounter", () => {
  it("affiche la longueur ET la limite configurée du canal", () => {
    const html = renderToStaticMarkup(React.createElement(CaptionCounter, { length: 42, max: 300 }));
    expect(html).toContain("42");
    expect(html).toContain("300");
  });

  it("reflète une AUTRE limite quand elle change (pas une valeur figée)", () => {
    const html = renderToStaticMarkup(React.createElement(CaptionCounter, { length: 42, max: 280 }));
    expect(html).toContain("280");
    expect(html).not.toContain("300");
  });

  it("signale visuellement un dépassement de la limite", () => {
    const over = renderToStaticMarkup(React.createElement(CaptionCounter, { length: 310, max: 300 }));
    const under = renderToStaticMarkup(React.createElement(CaptionCounter, { length: 10, max: 300 }));
    expect(over).toContain("text-destructive");
    expect(under).not.toContain("text-destructive");
  });
});

describe("SendAction — bouton désactivé avec la raison VISIBLE (pas une erreur au clic)", () => {
  it("raison non nulle : le bouton est disabled ET le texte de la raison est présent dans le HTML", () => {
    const html = renderToStaticMarkup(React.createElement(SendAction, {
      reason: "L'article doit d'abord être publié sur WordPress.",
      label: "Publier sur Facebook",
      pending: false,
      onClick: () => {},
    }));
    expect(html).toContain("L&#x27;article doit d&#x27;abord être publié sur WordPress.");
    // NOT a loose /disabled/ substring match: the Button component's own Tailwind classes contain
    // literal "disabled:pointer-events-none"/"disabled:opacity-50" variant selectors, which a naive
    // /<button[^>]*disabled/ regex matches INSIDE the class="" attribute even when the button is
    // NOT actually disabled — verified empirically while writing this test (it produced a false
    // positive against a non-disabled button). This pattern requires the real HTML boolean
    // attribute `disabled=""`, which react-dom/server only emits when the prop is truthy.
    expect(html).toMatch(/<button[^>]*\sdisabled=""/);
  });

  it("raison nulle : le bouton n'est pas désactivé et aucun texte de raison n'apparaît", () => {
    const html = renderToStaticMarkup(React.createElement(SendAction, {
      reason: null, label: "Publier sur Facebook", pending: false, onClick: () => {},
    }));
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""/);
  });

  it("en cours d'envoi : le bouton est désactivé même sans raison de blocage", () => {
    const html = renderToStaticMarkup(React.createElement(SendAction, {
      reason: null, label: "Publier sur Facebook", pending: true, onClick: () => {},
    }));
    // NOT a loose /disabled/ substring match: the Button component's own Tailwind classes contain
    // literal "disabled:pointer-events-none"/"disabled:opacity-50" variant selectors, which a naive
    // /<button[^>]*disabled/ regex matches INSIDE the class="" attribute even when the button is
    // NOT actually disabled — verified empirically while writing this test (it produced a false
    // positive against a non-disabled button). This pattern requires the real HTML boolean
    // attribute `disabled=""`, which react-dom/server only emits when the prop is truthy.
    expect(html).toMatch(/<button[^>]*\sdisabled=""/);
  });
});

describe("DiffusionStatusLine — l'échec affiche le message ET une offre de réessai", () => {
  it("jamais envoyé", () => {
    const html = renderToStaticMarkup(React.createElement(DiffusionStatusLine, { view: { kind: "never_sent" } }));
    expect(html.toLowerCase()).toContain("jamais");
  });

  it("envoyé — affiche la date", () => {
    const html = renderToStaticMarkup(React.createElement(DiffusionStatusLine, {
      view: { kind: "sent", sentAtLabel: "1 août 2026 à 10:00", externalId: "ext-1" },
    }));
    expect(html).toContain("1 août 2026 à 10:00");
  });

  it("échec — le message d'erreur EXACT est visible dans le HTML rendu", () => {
    const html = renderToStaticMarkup(React.createElement(DiffusionStatusLine, {
      view: { kind: "failed", message: "Erreur simulée du réseau.", attempts: 2 },
    }));
    expect(html).toContain("Erreur simulée du réseau.");
  });
});

describe("formatSentAt", () => {
  it("produit une date lisible en français, non vide", () => {
    const s = formatSentAt(new Date("2026-08-01T10:00:00Z"));
    expect(s.length).toBeGreaterThan(0);
    expect(s).toContain("2026");
  });
});
