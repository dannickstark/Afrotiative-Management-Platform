import { expect, test } from "bun:test";
import { generateShareToken, hashShareToken, sharePrefixOf, shareTokenMatches, SHARE_NAMESPACE } from "@/lib/montage/token";

test("génère un jeton namespacé avec préfixe et hash", () => {
  const { token, prefix, tokenHash } = generateShareToken();
  expect(token.startsWith(SHARE_NAMESPACE)).toBe(true);
  expect(prefix).toBe(token.slice(0, prefix.length));
  expect(tokenHash).toBe(hashShareToken(token));
});

test("prefixOf rejette un jeton étranger", () => {
  expect(sharePrefixOf("afro_vid_xxxxxx")).toBeNull();
  expect(sharePrefixOf(SHARE_NAMESPACE)).toBeNull(); // trop court
});

test("match constant", () => {
  const { token, tokenHash } = generateShareToken();
  expect(shareTokenMatches(token, tokenHash)).toBe(true);
  expect(shareTokenMatches(token + "x", tokenHash)).toBe(false);
});
