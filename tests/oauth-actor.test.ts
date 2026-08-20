import { expect, test } from "bun:test";
import { buildOauthActor } from "@/lib/mcp/oauth-actor";

const scope = { canWrite: true, canReadArticles: false };

test("session absente → 401", () => {
  expect(buildOauthActor({ session: null, owner: null, scope })).toEqual({
    ok: false, status: 401, message: "Jeton d'API invalide ou révoqué.",
  });
});

test("propriétaire banni → 401", () => {
  const r = buildOauthActor({
    session: { userId: "u1", clientId: "c1" },
    owner: { role: "journalist", banned: true },
    scope,
  });
  expect(r).toEqual({ ok: false, status: 401, message: "Jeton d'API invalide ou révoqué." });
});

test("session valide → acteur avec clientId comme tokenId", () => {
  const r = buildOauthActor({
    session: { userId: "u1", clientId: "c1" },
    owner: { role: "editor", banned: false },
    scope,
  });
  expect(r).toEqual({ ok: true, actor: { userId: "u1", role: "editor", tokenId: "c1", scope } });
});
