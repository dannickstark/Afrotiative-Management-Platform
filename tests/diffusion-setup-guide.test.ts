import { describe, it, expect } from "bun:test";
import { CHANNELS, type Channel } from "@/lib/studio";
import { SETUP_GUIDES, getSetupGuide } from "@/lib/diffusion/setup-guide";
import { SOCIAL_CHANNELS } from "@/lib/diffusion/channels";

describe("SETUP_GUIDES (Task 4, D2+D3) — every Channel has a connection guide", () => {
  // Mirrors tests/diffusion-channels.test.ts's own registry-completeness test: a new Channel added
  // to CHANNELS (lib/studio/tokens.ts) without a matching guide entry here must fail loudly, exactly
  // like it would without a SOCIAL_CHANNELS registry entry.
  it("every Channel in CHANNELS has a guide entry with at least one step", () => {
    for (const key of CHANNELS) {
      const guide = SETUP_GUIDES[key];
      expect(guide).toBeDefined();
      expect(Array.isArray(guide)).toBe(true);
      expect(guide.length).toBeGreaterThan(0); // a placeholder still needs a real first step
    }
  });

  it("has exactly the CHANNELS keys — no extras, nothing missing", () => {
    expect(Object.keys(SETUP_GUIDES).sort()).toEqual([...CHANNELS].sort());
  });

  it("getSetupGuide(channel) returns the same array as the SETUP_GUIDES map", () => {
    for (const key of CHANNELS) {
      expect(getSetupGuide(key)).toBe(SETUP_GUIDES[key]);
    }
  });

  it("every step has a non-empty French title and body", () => {
    for (const key of CHANNELS) {
      for (const step of SETUP_GUIDES[key]) {
        expect(typeof step.title).toBe("string");
        expect(step.title.trim().length).toBeGreaterThan(0);
        expect(typeof step.body).toBe("string");
        expect(step.body.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("every step's href, when present, is a well-formed https link", () => {
    for (const key of CHANNELS) {
      for (const step of SETUP_GUIDES[key]) {
        if (step.href === undefined) continue;
        expect(step.href.startsWith("https://")).toBe(true);
        expect(() => new URL(step.href!)).not.toThrow();
      }
    }
  });

  // The brief's third test: a fieldHint is a POINTER, not free text — it must name a key that
  // actually exists in that channel's registry-declared credential fields (lib/diffusion/
  // channels.ts's SOCIAL_CHANNELS[channel].credentialFields), so the UI's "→ Renseignez : …" label
  // lookup never silently falls back to displaying a raw, unresolved key.
  it("every fieldHint names a real credential field for that channel", () => {
    for (const key of CHANNELS) {
      const validKeys = new Set(SOCIAL_CHANNELS[key].credentialFields.map((f) => f.key));
      for (const step of SETUP_GUIDES[key]) {
        if (step.fieldHint === undefined) continue;
        expect(validKeys.has(step.fieldHint)).toBe(true);
      }
    }
  });

  // Channels with no credential fields yet (tiktok, whatsapp, x — channels.ts's own header comment;
  // linkedin joined facebook/instagram in Task 4, D7) have nothing a fieldHint could legitimately
  // point at; the previous test alone would also catch a stray one, but this pins the expectation
  // explicitly per channel rather than leaving it as an incidental consequence.
  it("channels with no credential fields have no fieldHint in their guide", () => {
    const noCredentialChannels: Channel[] = CHANNELS.filter(
      (key) => SOCIAL_CHANNELS[key].credentialFields.length === 0,
    );
    expect(noCredentialChannels.sort()).toEqual(["tiktok", "whatsapp", "x"]);
    for (const key of noCredentialChannels) {
      for (const step of SETUP_GUIDES[key]) expect(step.fieldHint).toBeUndefined();
    }
  });

  // The reverse direction, for the three channels with a real adapter and real fields: every
  // registered credential field actually gets a guiding step, not just some of them — a future
  // credential field added to channels.ts without a matching guide step would leave an admin with a
  // field to fill and no instructions for it, and this is the check that would catch that. LinkedIn
  // joined this list in Task 4 (D7) — its guide is deliberately MINIMAL (spec §6/Task 6 owns the
  // full content) but still covers organizationUrn/accessToken, so it belongs here too.
  it("facebook, instagram and linkedin guides cover every credential field they declare", () => {
    for (const key of ["facebook", "instagram", "linkedin"] as const) {
      const declaredKeys = SOCIAL_CHANNELS[key].credentialFields.map((f) => f.key);
      const hintedKeys = new Set(
        SETUP_GUIDES[key].map((s) => s.fieldHint).filter((h): h is string => h !== undefined),
      );
      for (const fieldKey of declaredKeys) expect(hintedKeys.has(fieldKey)).toBe(true);
    }
  });

  // The placeholder must be honest about NOT being built, not silent about it — a step that just
  // said "coming soon" with no reason would fail the brief's "at least one step" test technically
  // but still leave an admin (or the next task, D4) with nothing actionable. LinkedIn dropped out of
  // this list in Task 4 (D7): the adapter is real now, so the guide would be LYING if it still said
  // "pas encore construit" — see tests/diffusion-linkedin.test.ts for the adapter's own coverage.
  it("whatsapp's placeholder says plainly the adapter is not built yet", () => {
    const allText = SETUP_GUIDES.whatsapp.map((s) => `${s.title} ${s.body}`).join(" ");
    expect(allText).toMatch(/pas encore/i);
  });

  // Same honesty requirement for the two deferred channels, but the reason is different (blocked on
  // an external constraint, not "not yet built") — the roadmap's own wording for each.
  it("x and tiktok placeholders say the channel is deferred", () => {
    for (const key of ["x", "tiktok"] as const) {
      const allText = SETUP_GUIDES[key].map((s) => `${s.title} ${s.body}`).join(" ");
      expect(allText).toMatch(/report/i); // "reporté(e)"
    }
  });
});
