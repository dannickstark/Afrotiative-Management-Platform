import { describe, it, expect } from "bun:test";
import { normalizeUrl, contentHash } from "@/lib/rss/parse-feed";

describe("rss helpers", () => {
  it("normalizeUrl strips utm + trailing slash + lowercases host", () => {
    expect(normalizeUrl("https://Example.com/a/?utm_source=x&id=2#frag"))
      .toBe("https://example.com/a?id=2");
  });
  it("contentHash is stable for same normalized content", () => {
    expect(contentHash("Titre", "Corps")).toBe(contentHash("Titre", "Corps"));
    expect(contentHash("Titre", "Corps")).not.toBe(contentHash("Titre", "Autre"));
  });
});
