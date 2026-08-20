import { expect, test } from "bun:test";
import { auth } from "@/lib/auth";

test("le plugin mcp expose les endpoints OAuth sur auth.api", () => {
  expect(typeof auth.api.getMcpSession).toBe("function");
  expect(typeof auth.api.oAuthConsent).toBe("function");
  expect(typeof auth.api.getMcpOAuthConfig).toBe("function");
  expect(typeof auth.api.getMCPProtectedResource).toBe("function");
});
