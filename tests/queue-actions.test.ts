import { describe, it, expect, vi } from "bun:test";
import { can } from "@/lib/rbac";

// Unit-level guard: the action must refuse a journalist.
describe("queue action guards", () => {
  it("journalist cannot approve", () => { expect(can("journalist", "article", "approve")).toBe(false); });
  it("editor can approve", () => { expect(can("editor", "article", "approve")).toBe(true); });
});
