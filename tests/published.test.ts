import { describe, it, expect } from "bun:test";
import { wpPostUrl } from "@/lib/wp/post-url";

describe("wpPostUrl", () => {
  it("builds the ?p= permalink and strips a trailing slash on the base", () => {
    expect(wpPostUrl("https://wp.example.com", "123")).toBe("https://wp.example.com/?p=123");
    expect(wpPostUrl("https://wp.example.com/", "123")).toBe("https://wp.example.com/?p=123");
  });
  it("encodes the post id", () => {
    expect(wpPostUrl("https://wp.example.com", "a b")).toBe("https://wp.example.com/?p=a%20b");
  });
  it("returns null when base or id is missing", () => {
    expect(wpPostUrl(null, "123")).toBeNull();
    expect(wpPostUrl(undefined, "123")).toBeNull();
    expect(wpPostUrl("https://wp.example.com", null)).toBeNull();
  });
});
