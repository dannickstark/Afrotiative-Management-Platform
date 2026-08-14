import { describe, it, expect } from "bun:test";
import { classifyOpenRouterError } from "@/lib/ai/openrouter-errors";

describe("classifyOpenRouterError", () => {
  it("429 → rate_limited", () =>
    expect(classifyOpenRouterError({ statusCode: 429, message: "x" })).toBe("rate_limited"));
  it("quota message → rate_limited", () =>
    expect(classifyOpenRouterError({ message: "You exceeded your quota" })).toBe("rate_limited"));
  it("rate limit message → rate_limited", () =>
    expect(classifyOpenRouterError({ message: "Rate limit exceeded" })).toBe("rate_limited"));
  it("no endpoints message → rate_limited", () =>
    expect(classifyOpenRouterError({ message: "No endpoints found" })).toBe("rate_limited"));
  it("401 → auth_failed", () =>
    expect(classifyOpenRouterError({ statusCode: 401, message: "bad key" })).toBe("auth_failed"));
  it("403 → auth_failed", () =>
    expect(classifyOpenRouterError({ statusCode: 403 })).toBe("auth_failed"));
  it("500/unknown → error", () =>
    expect(classifyOpenRouterError({ statusCode: 500, message: "boom" })).toBe("error"));
  it("plain throw → error", () =>
    expect(classifyOpenRouterError(new Error("weird"))).toBe("error"));
  it("null/undefined → error", () =>
    expect(classifyOpenRouterError(undefined)).toBe("error"));
});
