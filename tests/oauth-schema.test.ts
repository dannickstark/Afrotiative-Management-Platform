import { expect, test } from "bun:test";
import { oauthApplication, oauthAccessToken, oauthConsent, mcpOauthScope } from "@/db";

test("les tables OAuth exposent les colonnes attendues", () => {
  expect(oauthApplication.clientId).toBeDefined();
  expect(oauthApplication.redirectUrls).toBeDefined();
  expect(oauthAccessToken.accessToken).toBeDefined();
  expect(oauthAccessToken.scopes).toBeDefined();
  expect(oauthConsent.consentGiven).toBeDefined();
  expect(mcpOauthScope.canWrite).toBeDefined();
  expect(mcpOauthScope.canReadArticles).toBeDefined();
  expect(mcpOauthScope.clientId).toBeDefined();
});
