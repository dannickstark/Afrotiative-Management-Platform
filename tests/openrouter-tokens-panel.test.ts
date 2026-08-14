// tests/openrouter-tokens-panel.test.ts — Task 7. Pure-logic test for tokenStatusLabel, the French
// status-label formatter behind components/settings/openrouter-tokens-panel.tsx's per-row Badge.
// The repo has no React component testing (see scripts/test-fast.ts's own note on this), so only
// this PURE helper is unit-tested here — the panel's interactions (buttons, add form, ConfirmDialog)
// are browser-verified once Task 9 mounts it on /settings/integrations.
//
// tokenStatusLabel is imported directly from the "use client" panel module (not split into a sibling
// pure file): it has no React/DOM dependency itself, and components/settings/interval-picker.tsx —
// also "use client" — is already imported directly by tests/interval-picker.test.ts without issue,
// so there is no bun-test-unsafe import in this component's dependency graph to work around.
//
// Deliberately NOT added to scripts/test-fast.ts's PURE_FILES allowlist per the task brief (that
// list is regenerated from a measured run, not hand-edited ahead of time).
import { describe, it, expect } from "bun:test";
import { tokenStatusLabel } from "@/components/settings/openrouter-tokens-panel";

const NOW = new Date("2026-08-14T12:00:00Z");

describe("tokenStatusLabel", () => {
  it("returns Désactivé when the token is inactive, regardless of lastStatus/cooldown", () => {
    expect(tokenStatusLabel({ active: false, lastStatus: "ok", cooldownUntil: null }, NOW)).toBe("Désactivé");
    expect(
      tokenStatusLabel({ active: false, lastStatus: "ok", cooldownUntil: new Date("2026-08-14T13:00:00Z") }, NOW),
    ).toBe("Désactivé");
  });

  it("starts with 'En pause' when cooldownUntil is in the future", () => {
    const label = tokenStatusLabel(
      { active: true, lastStatus: "rate_limited", cooldownUntil: new Date("2026-08-14T13:05:00Z") },
      NOW,
    );
    expect(label.startsWith("En pause")).toBe(true);
    expect(label).toBe("En pause (jusqu'à 13:05)");
  });

  it("ignores a cooldownUntil that has already passed", () => {
    expect(
      tokenStatusLabel({ active: true, lastStatus: "ok", cooldownUntil: new Date("2026-08-14T11:00:00Z") }, NOW),
    ).toBe("OK");
  });

  it("maps each lastStatus to its French label", () => {
    expect(tokenStatusLabel({ active: true, lastStatus: "ok", cooldownUntil: null }, NOW)).toBe("OK");
    expect(tokenStatusLabel({ active: true, lastStatus: "rate_limited", cooldownUntil: null }, NOW)).toBe("Quota atteint");
    expect(tokenStatusLabel({ active: true, lastStatus: "auth_failed", cooldownUntil: null }, NOW)).toBe("Clé refusée");
    expect(tokenStatusLabel({ active: true, lastStatus: "flaky", cooldownUntil: null }, NOW)).toBe("Réponse faible");
    expect(tokenStatusLabel({ active: true, lastStatus: "error", cooldownUntil: null }, NOW)).toBe("Erreur");
  });

  it("returns — when lastStatus is null (never tested)", () => {
    expect(tokenStatusLabel({ active: true, lastStatus: null, cooldownUntil: null }, NOW)).toBe("—");
  });
});
