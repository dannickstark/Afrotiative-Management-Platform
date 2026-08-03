import { describe, it, expect } from "bun:test";
import { STATUS_LABEL, statusLabel, type ArticleStatus } from "@/lib/format";

const ALL: ArticleStatus[] = ["draft", "pending", "in_review", "approved", "published", "rejected"];

describe("status mapping", () => {
  it("has a French label for every status value", () => {
    for (const s of ALL) expect(STATUS_LABEL[s].length).toBeGreaterThan(0);
    expect(statusLabel("pending")).toBe("En attente");
    expect(statusLabel("rejected")).toBe("Rejeté");
  });
});
