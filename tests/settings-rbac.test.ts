import { describe, it, expect } from "bun:test";
import { can } from "@/lib/rbac";
describe("settings RBAC", () => {
  it("editor manages feeds+taxonomy but not team/integrations", () => {
    expect(can("editor","feed","manage")).toBe(true);
    expect(can("editor","taxonomy","manage")).toBe(true);
    expect(can("editor","team","manage")).toBe(false);
    expect(can("editor","pipeline","configure")).toBe(false);
  });
  it("admin manages all; journalist none", () => {
    expect(can("admin","team","manage")).toBe(true);
    expect(can("admin","pipeline","configure")).toBe(true);
    expect(can("journalist","feed","manage")).toBe(false);
    expect(can("journalist","taxonomy","manage")).toBe(false);
  });
});
