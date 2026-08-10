import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { can, requirePermission, PermissionError } from "@/lib/rbac";
import { SETTINGS_CHILDREN } from "@/components/shell/nav-items";
import { SOCIAL_CHANNELS } from "@/lib/diffusion/channels";
import { SocialChannelsList, formatAutoSummary, type SocialChannelSummary } from "@/components/settings/social-channels";
import { SocialChannelForm } from "@/components/settings/social-channel-form";

// ─────────────────────────────────────────────────────────────────────────────
// Task 7 (D1 §6) — /settings/social + /settings/social/[channel]. The pages themselves are Server
// Components that call next/headers() (via requireUser()) — not renderable outside a real Next.js
// request, so "an editor reaching the page is refused" is exercised at exactly the guard the page
// calls first (requirePermission(user.role, "social", "manage")), same convention as every other
// *-rbac.test.ts file in this suite (tests/studio-rbac.test.ts, tests/settings-rbac.test.ts).
// ─────────────────────────────────────────────────────────────────────────────

describe("RBAC — an editor/journalist reaching /settings/social is refused, admin is not", () => {
  it("can(): only admin has social:manage", () => {
    expect(can("admin", "social", "manage")).toBe(true);
    expect(can("editor", "social", "manage")).toBe(false);
    expect(can("journalist", "social", "manage")).toBe(false);
  });

  it("requirePermission(): throws PermissionError for editor and journalist — the exact call the page makes first", () => {
    expect(() => requirePermission("editor", "social", "manage")).toThrow(PermissionError);
    expect(() => requirePermission("journalist", "social", "manage")).toThrow(PermissionError);
  });

  it("requirePermission(): does NOT throw for admin", () => {
    expect(() => requirePermission("admin", "social", "manage")).not.toThrow();
  });
});

describe("SETTINGS_CHILDREN — Réseaux sociaux is registered, admin-only, and reused by both navs", () => {
  it("contains /settings/social restricted to admin", () => {
    const entry = SETTINGS_CHILDREN.find((c) => c.href === "/settings/social");
    expect(entry).toBeDefined();
    expect(entry!.roles).toEqual(["admin"]);
  });
});

describe("SocialChannelForm — captionMaxChars bounds are RENDERED FROM captionLimits, not hard-coded", () => {
  const baseSettings = {
    channel: "x", enabled: true, captionMaxChars: 200, captionPrompt: null,
    autoEnabled: false, autoIntervalHours: 6, autoMaxBacklogDays: 3,
    autoWindowStartHour: 8, autoWindowEndHour: 20, lastAutoSendAt: null,
    updatedAt: new Date(),
  };

  it("shows X's actual [min, max] (1, 280), not some other channel's", () => {
    const html = renderToStaticMarkup(
      React.createElement(SocialChannelForm, {
        channel: "x", label: "X", captionLimits: SOCIAL_CHANNELS.x.captionLimits,
        settings: { ...baseSettings, channel: "x" } as never,
      }),
    );
    expect(html).toContain(String(SOCIAL_CHANNELS.x.captionLimits.min));
    expect(html).toContain(String(SOCIAL_CHANNELS.x.captionLimits.max));
  });

  // The decisive test: swap in a DIFFERENT channel with a DIFFERENT max, and require the rendered
  // number to change accordingly. A hard-coded literal (e.g. always printing "280") would pass the
  // test above by coincidence but fail THIS one — it would still show 280 for WhatsApp instead of
  // WhatsApp's real 1024.
  it("shows WhatsApp's actual max (1024), proving the bound tracks the `captionLimits` prop", () => {
    const html = renderToStaticMarkup(
      React.createElement(SocialChannelForm, {
        channel: "whatsapp", label: "WhatsApp", captionLimits: SOCIAL_CHANNELS.whatsapp.captionLimits,
        settings: { ...baseSettings, channel: "whatsapp", captionMaxChars: 300 } as never,
      }),
    );
    expect(SOCIAL_CHANNELS.whatsapp.captionLimits.max).not.toBe(SOCIAL_CHANNELS.x.captionLimits.max); // sanity: the two channels really do differ
    expect(html).toContain(String(SOCIAL_CHANNELS.whatsapp.captionLimits.max));
    expect(html).not.toContain(`Entre 1 et ${SOCIAL_CHANNELS.x.captionLimits.max}`); // X's own bound sentence must not leak in
  });

  it("renders the automatic-publication block's current values (autoEnabled/autoIntervalHours/window)", () => {
    const html = renderToStaticMarkup(
      React.createElement(SocialChannelForm, {
        channel: "instagram", label: "Instagram", captionLimits: SOCIAL_CHANNELS.instagram.captionLimits,
        settings: {
          ...baseSettings, channel: "instagram", autoEnabled: true,
          autoIntervalHours: 9, autoMaxBacklogDays: 4, autoWindowStartHour: 7, autoWindowEndHour: 22,
        } as never,
      }),
    );
    expect(html).toContain('value="9"'); // autoIntervalHours
    expect(html).toContain('value="4"'); // autoMaxBacklogDays
    expect(html).toContain('value="7"'); // autoWindowStartHour
    expect(html).toContain('value="22"'); // autoWindowEndHour
  });
});

describe("SocialChannelsList — enabled/disabled state and auto summary", () => {
  function item(overrides: Partial<SocialChannelSummary> = {}): SocialChannelSummary {
    return {
      channel: "facebook", label: "Facebook", enabled: true,
      autoEnabled: false, autoIntervalHours: 6, autoMaxBacklogDays: 3,
      autoWindowStartHour: 8, autoWindowEndHour: 20,
      ...overrides,
    };
  }

  it("renders every channel's label and links to its detail page", () => {
    const html = renderToStaticMarkup(
      React.createElement(SocialChannelsList, {
        items: [item({ channel: "facebook", label: "Facebook" }), item({ channel: "tiktok", label: "TikTok" })],
      }),
    );
    expect(html).toContain("Facebook");
    expect(html).toContain("TikTok");
    expect(html).toContain('href="/settings/social/facebook"');
    expect(html).toContain('href="/settings/social/tiktok"');
  });

  it("shows a disabled channel distinctly from an enabled one", () => {
    const html = renderToStaticMarkup(
      React.createElement(SocialChannelsList, {
        items: [item({ channel: "facebook", enabled: true }), item({ channel: "x", label: "X", enabled: false })],
      }),
    );
    expect(html).toContain("Activé");
    expect(html).toContain("Désactivé");
  });

  it("formatAutoSummary reflects the actual configured interval/window, not a fixed string", () => {
    const off = formatAutoSummary(item({ autoEnabled: false }));
    const on = formatAutoSummary(item({ autoEnabled: true, autoIntervalHours: 6, autoWindowStartHour: 8, autoWindowEndHour: 20, autoMaxBacklogDays: 3 }));
    expect(off).not.toBe(on);
    expect(on).toContain("6");
    expect(on).toContain("8h");
    expect(on).toContain("20h");

    const differentInterval = formatAutoSummary(item({ autoEnabled: true, autoIntervalHours: 12, autoWindowStartHour: 8, autoWindowEndHour: 20, autoMaxBacklogDays: 3 }));
    expect(differentInterval).not.toBe(on); // a different config must produce a different summary
  });
});
