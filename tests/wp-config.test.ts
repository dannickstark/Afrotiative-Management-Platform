import { describe, it, expect, afterEach } from "bun:test";
import { getWpConfig, WordPressNotConfiguredError } from "@/lib/wp/config";

const KEYS = ["WP_BASE_URL", "WP_USER", "WP_APP_PASSWORD"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("getWpConfig", () => {
  it("returns null when any required var is missing", () => {
    delete process.env.WP_BASE_URL;
    delete process.env.WP_USER;
    delete process.env.WP_APP_PASSWORD;
    expect(getWpConfig()).toBeNull();

    process.env.WP_BASE_URL = "https://example.com";
    process.env.WP_USER = "bot";
    delete process.env.WP_APP_PASSWORD;
    expect(getWpConfig()).toBeNull();
  });

  it("strips a trailing slash from the base URL and spaces from the app password", () => {
    process.env.WP_BASE_URL = "https://example.com/";
    process.env.WP_USER = "bot";
    process.env.WP_APP_PASSWORD = "abcd 1234 efgh 5678";
    const cfg = getWpConfig();
    expect(cfg?.baseUrl).toBe("https://example.com");
    expect(cfg?.appPassword).toBe("abcd1234efgh5678");
  });

  it("builds a Basic auth header from user:strippedPassword", () => {
    process.env.WP_BASE_URL = "https://example.com";
    process.env.WP_USER = "bot";
    process.env.WP_APP_PASSWORD = "abcd 1234";
    const cfg = getWpConfig();
    expect(cfg?.authHeader).toBe("Basic " + Buffer.from("bot:abcd1234").toString("base64"));
  });
});

describe("WordPressNotConfiguredError", () => {
  it("carries a French message and the right error name", () => {
    const err = new WordPressNotConfiguredError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("WordPressNotConfiguredError");
    expect(err.message).toContain("WordPress non configuré");
  });
});
