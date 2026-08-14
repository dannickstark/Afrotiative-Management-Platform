import { describe, it, expect } from "bun:test";
import { plainTextLen } from "@/lib/ai/plain-text";

describe("plainTextLen (tag→space, collapse ws, trim, length)", () => {
  it("tags become a space boundary", () =>
    expect(plainTextLen("<h2>Hi</h2><p>there</p>")).toBe("Hi there".length)); // 8
  it("collapses whitespace", () =>
    expect(plainTextLen("<p>a   b</p>")).toBe("a b".length)); // 3
  it("empty/whitespace-only → 0", () => expect(plainTextLen("<p>   </p>")).toBe(0));
  it("plain text no tags", () => expect(plainTextLen("hello")).toBe(5));
});
