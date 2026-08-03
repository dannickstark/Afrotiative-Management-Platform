import { describe, it, expect } from "bun:test";
import { can } from "@/lib/rbac";

describe("can()", () => {
  it("journalist can create/edit but not publish/reject", () => {
    expect(can("journalist", "article", "create")).toBe(true);
    expect(can("journalist", "article", "edit")).toBe(true);
    expect(can("journalist", "article", "publish")).toBe(false);
    expect(can("journalist", "article", "reject")).toBe(false);
  });
  it("editor can publish and manage feeds but not team", () => {
    expect(can("editor", "article", "publish")).toBe(true);
    expect(can("editor", "feed", "manage")).toBe(true);
    expect(can("editor", "team", "manage")).toBe(false);
  });
  it("admin can manage team and configure pipeline", () => {
    expect(can("admin", "team", "manage")).toBe(true);
    expect(can("admin", "pipeline", "configure")).toBe(true);
  });
});
