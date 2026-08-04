import { describe, it, expect } from "bun:test";
import { can } from "@/lib/rbac";

describe("pipeline trigger authz", () => {
  it("only admin may configure/run the pipeline", () => {
    expect(can("admin", "pipeline", "configure")).toBe(true);
    expect(can("editor", "pipeline", "configure")).toBe(false);
    expect(can("journalist", "pipeline", "configure")).toBe(false);
  });
});
