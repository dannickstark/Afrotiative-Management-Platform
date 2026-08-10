import { describe, it, expect, afterEach } from "bun:test";
import { CHANNELS, type Channel } from "@/lib/studio";
import { SOCIAL_CHANNELS, getSocialChannel } from "@/lib/diffusion/channels";
import { StubChannel } from "@/lib/diffusion/stub-channel";

describe("SOCIAL_CHANNELS registry (D1 §2)", () => {
  it("every Channel in CHANNELS has a registry entry", () => {
    for (const key of CHANNELS) {
      const entry = SOCIAL_CHANNELS[key];
      expect(entry).toBeDefined();
      expect(entry.key).toBe(key);
      expect(entry.context).toBe("social_post"); // fixed in D1 — spec §2
      expect(typeof entry.label).toBe("string");
      expect(entry.label.length).toBeGreaterThan(0);
      expect(typeof entry.send).toBe("function");
    }
  });

  it("has exactly the CHANNELS keys — no extras, nothing missing", () => {
    expect(Object.keys(SOCIAL_CHANNELS).sort()).toEqual([...CHANNELS].sort());
  });

  it("captionLimits.default is within [min, max] for every channel", () => {
    for (const key of CHANNELS) {
      const { min, max, default: def } = SOCIAL_CHANNELS[key].captionLimits;
      expect(min).toBeLessThanOrEqual(max);
      expect(def).toBeGreaterThanOrEqual(min);
      expect(def).toBeLessThanOrEqual(max);
    }
  });

  it("getSocialChannel(key) returns the same object as the registry map", () => {
    for (const key of CHANNELS) {
      expect(getSocialChannel(key)).toBe(SOCIAL_CHANNELS[key]);
    }
  });

  it("official caption ceilings match the researched values (regression guard, not a re-derivation)", () => {
    // Locks the actual numbers in place — a future edit that silently drifts one of these off its
    // documented source would fail here even though "default within [min,max]" above would not
    // catch it (that check passes for ANY internally-consistent triple).
    const expected: Record<Channel, number> = {
      facebook: 63206, instagram: 2200, whatsapp: 1024, x: 280, tiktok: 2200, linkedin: 3000,
    };
    for (const key of CHANNELS) expect(SOCIAL_CHANNELS[key].captionLimits.max).toBe(expected[key]);
  });
});

describe("StubChannel.send — no network call (D1 §2)", () => {
  let realFetch: typeof fetch;

  afterEach(() => {
    if (realFetch) globalThis.fetch = realFetch;
  });

  // A fetch that THROWS-if-called only proves "send() didn't reject" — a hypothetical
  // implementation that called fetch and swallowed the error internally (try/catch around a real
  // network call) would still resolve ok:true and pass that check alone, while genuinely violating
  // "no network call" (the exact "witness never actually exercised" shape flagged in this
  // program's review history). A COUNTING spy closes that gap: it proves fetch was invoked zero
  // times, which no internal try/catch can hide.
  it("resolves ok:true with a synthetic externalId, and fetch is called exactly zero times", async () => {
    realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      calls++;
      throw new Error("StubChannel appelé le réseau — c'est un envoi FANTÔME (D1 §2).");
    }) as unknown as typeof fetch;

    const stub = new StubChannel("facebook");
    const result = await stub.send({
      articleId: "11111111-1111-1111-1111-111111111111",
      imageUrl: "https://example.test/render.png",
      caption: "Légende de test.",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.externalId).toBe("string");
      expect(result.externalId.length).toBeGreaterThan(0);
      expect(result.externalId).toContain("facebook");
    }
    expect(calls).toBe(0);
  });

  it("every registered channel's send() also makes no network call — fetch call count stays zero (exercises the real registry wiring, not just the class directly)", async () => {
    realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      calls++;
      throw new Error("Un canal du registre a appelé le réseau — D1 ne doit avoir aucun adaptateur réel.");
    }) as unknown as typeof fetch;

    for (const key of CHANNELS) {
      const result = await SOCIAL_CHANNELS[key].send({
        articleId: "22222222-2222-2222-2222-222222222222",
        imageUrl: "https://example.test/render.png",
        caption: "Légende de test.",
      });
      expect(result.ok).toBe(true);
    }
    expect(calls).toBe(0);
  });

  it("two calls produce different externalIds (not a hardcoded constant)", async () => {
    const stub = new StubChannel("x");
    const a = await stub.send({ articleId: "a", imageUrl: "https://example.test/a.png", caption: "A" });
    const b = await stub.send({ articleId: "a", imageUrl: "https://example.test/a.png", caption: "A" });
    expect(a.ok && b.ok && a.externalId !== b.externalId).toBe(true);
  });
});
