import { describe, it, expect } from "bun:test";
import { wpPostUrl } from "@/lib/wp/post-url";
import { parsePublishedSearchParams, PUBLISHED_PAGE_SIZE } from "@/lib/queries/published";

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

describe("parsePublishedSearchParams", () => {
  it("defaults empty params to page 1, default page size, no filters", () => {
    expect(parsePublishedSearchParams({})).toEqual({
      search: undefined, categoryId: undefined, from: undefined, to: undefined,
      author: undefined, page: 1, pageSize: PUBLISHED_PAGE_SIZE,
    });
  });
  it("reads and trims q/cat, parses valid dates, and accepts the author enum", () => {
    const f = parsePublishedSearchParams({ q: "  brvm ", cat: "cat-1", from: "2026-08-01", to: "2026-08-06", author: "ai", page: "3" });
    expect(f.search).toBe("brvm");
    expect(f.categoryId).toBe("cat-1");
    expect(f.from).toEqual(new Date("2026-08-01"));
    expect(f.to).toEqual(new Date("2026-08-06"));
    expect(f.author).toBe("ai");
    expect(f.page).toBe(3);
  });
  it("drops invalid dates, unknown author, and clamps page to >= 1", () => {
    const f = parsePublishedSearchParams({ from: "not-a-date", author: "robot", page: "0" });
    expect(f.from).toBeUndefined();
    expect(f.author).toBeUndefined();
    expect(f.page).toBe(1);
    expect(parsePublishedSearchParams({ page: "-4" }).page).toBe(1);
    expect(parsePublishedSearchParams({ page: "abc" }).page).toBe(1);
  });
  it("takes the first value of an array param", () => {
    expect(parsePublishedSearchParams({ q: ["first", "second"] }).search).toBe("first");
  });
});
