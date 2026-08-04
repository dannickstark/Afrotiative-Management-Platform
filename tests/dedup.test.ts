import { describe, it, expect } from "bun:test";
import { dedupKeys } from "@/lib/pipeline/dedup";

describe("dedupKeys", () => {
  it("derives guid/url/hash keys used for the seen-check", () => {
    const k = dedupKeys({ guid: "g1", url: "https://x/a", contentHash: "h1" } as any);
    expect(k).toEqual(["g1", "https://x/a", "h1"]);
  });

  it("preserves order even when values happen to collide", () => {
    const k = dedupKeys({ guid: "same", url: "same", contentHash: "same" } as any);
    expect(k).toEqual(["same", "same", "same"]);
  });
});
