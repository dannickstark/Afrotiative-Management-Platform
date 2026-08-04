import { describe, it, expect } from "bun:test";
import { can } from "@/lib/rbac";
import { LOCK_TTL_MS, isLockActive } from "@/lib/lock";

describe("article action rules", () => {
  it("only editor/admin may approve/reject/regenerate", () => {
    for (const a of ["approve", "reject", "regenerate"] as const) {
      expect(can("journalist", "article", a)).toBe(false);
      expect(can("editor", "article", a)).toBe(true);
    }
  });
  it("lock older than TTL is inactive", () => {
    expect(isLockActive(new Date(Date.now() - LOCK_TTL_MS - 1000))).toBe(false);
    expect(isLockActive(new Date())).toBe(true);
  });
});
