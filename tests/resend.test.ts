import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { buildResendPayload, sendEmail } from "@/lib/email/resend";

// ─────────────────────────────────────────────────────────────────────────────
// SP9a — buildResendPayload is PURE (no I/O): exercised directly with no network involved.
describe("buildResendPayload (pure, no network)", () => {
  it("maps to/subject/html/from into the exact Resend API body shape", () => {
    expect(buildResendPayload({
      to: ["a@example.com", "b@example.com"],
      subject: "Sujet de test",
      html: "<p>Corps</p>",
      from: "alerts@example.com",
    })).toEqual({
      from: "alerts@example.com",
      to: ["a@example.com", "b@example.com"],
      subject: "Sujet de test",
      html: "<p>Corps</p>",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SP9a — sendEmail's no-key path: RESEND_API_KEY is already stripped globally by test-setup.ts's
// blanket `*_API_KEY` sweep, but this file snapshots/restores it explicitly anyway so it stays
// self-contained and order-independent (same pattern as tests/search.test.ts's
// ORIGINAL_BRAVE_KEY). No fetch mock is installed here — the assertion IS that no network call is
// even attempted when the key is unset.
describe("sendEmail (no key — no network)", () => {
  const ORIGINAL_KEY = process.env.RESEND_API_KEY;

  beforeEach(() => { delete process.env.RESEND_API_KEY; });
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = ORIGINAL_KEY;
  });

  it("returns false (never throws) when RESEND_API_KEY is unset", async () => {
    const result = await sendEmail({ to: ["a@example.com"], subject: "Test", html: "<p>Test</p>" });
    expect(result).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SP9a — sendEmail with a key present: network-free via a monkeypatched global.fetch (same
// technique already used by tests/wp-publish.test.ts and tests/pipeline-web-search.test.ts).
// Confirms sendEmail's own never-throw contract on both a non-2xx response and an outright fetch
// rejection, plus the request shape (URL, method, auth header, body, and the ALERT_EMAIL_FROM /
// default-from resolution).
describe("sendEmail (key present, network mocked)", () => {
  const ORIGINAL_KEY = process.env.RESEND_API_KEY;
  const ORIGINAL_FROM = process.env.ALERT_EMAIL_FROM;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    process.env.RESEND_API_KEY = "test-resend-key";
    delete process.env.ALERT_EMAIL_FROM;
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (ORIGINAL_KEY === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = ORIGINAL_KEY;
    if (ORIGINAL_FROM === undefined) delete process.env.ALERT_EMAIL_FROM; else process.env.ALERT_EMAIL_FROM = ORIGINAL_FROM;
  });

  it("posts the expected request (URL, auth header, JSON body) and returns true on a 2xx response", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      seenUrl = typeof input === "string" ? input : input.toString();
      seenInit = init;
      return new Response(JSON.stringify({ id: "email_abc" }), { status: 200 });
    }) as typeof fetch;

    const result = await sendEmail({ to: ["x@example.com"], subject: "Sujet", html: "<p>Corps</p>" });

    expect(result).toBe(true);
    expect(seenUrl).toBe("https://api.resend.com/emails");
    expect(seenInit?.method).toBe("POST");
    expect((seenInit?.headers as Record<string, string>).Authorization).toBe("Bearer test-resend-key");
    expect(JSON.parse(String(seenInit?.body))).toEqual({
      from: "alerts@afrotiative.local", to: ["x@example.com"], subject: "Sujet", html: "<p>Corps</p>",
    });
  });

  it("uses ALERT_EMAIL_FROM as the from address when set", async () => {
    process.env.ALERT_EMAIL_FROM = "custom-alerts@example.com";
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (_input, init) => { seenInit = init; return new Response("{}", { status: 200 }); }) as typeof fetch;

    await sendEmail({ to: ["x@example.com"], subject: "S", html: "<p>C</p>" });

    expect(JSON.parse(String(seenInit?.body)).from).toBe("custom-alerts@example.com");
  });

  it("returns false (never throws) on a non-2xx response", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("erreur serveur", { status: 500 })) as typeof fetch;
    const result = await sendEmail({ to: ["x@example.com"], subject: "S", html: "<p>C</p>" });
    expect(result).toBe(false);
  });

  it("returns false (never throws) when fetch itself rejects (network error)", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      throw new Error("panne réseau simulée");
    }) as typeof fetch;
    const result = await sendEmail({ to: ["x@example.com"], subject: "S", html: "<p>C</p>" });
    expect(result).toBe(false);
  });
});
