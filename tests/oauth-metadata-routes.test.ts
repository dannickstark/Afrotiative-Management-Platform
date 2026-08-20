import { expect, test } from "bun:test";
import { GET as asMeta } from "@/app/.well-known/oauth-authorization-server/route";
import { GET as prMeta } from "@/app/.well-known/oauth-protected-resource/route";

test("métadonnées serveur d'autorisation exposent les endpoints", async () => {
  const res = await asMeta(new Request("https://x.test/.well-known/oauth-authorization-server"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.registration_endpoint).toContain("/api/auth/mcp/register");
  expect(body.authorization_endpoint).toContain("/api/auth/mcp/authorize");
});

test("métadonnées ressource protégée référencent le serveur d'autorisation", async () => {
  const res = await prMeta(new Request("https://x.test/.well-known/oauth-protected-resource"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.authorization_servers)).toBe(true);
});
