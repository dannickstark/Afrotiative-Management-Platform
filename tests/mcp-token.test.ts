import { describe, it, expect } from "bun:test";
import {
  generateToken, hashToken, prefixOf, tokenMatches, TOKEN_NAMESPACE, PREFIX_LENGTH,
} from "@/lib/mcp/token";

describe("generateToken", () => {
  it("produit un jeton reconnaissable à l'œil", () => {
    const { token } = generateToken();
    expect(token.startsWith(TOKEN_NAMESPACE)).toBe(true);
    // Le point : un jeton qui fuit dans un dépôt ou un journal doit être identifiable comme tel.
    expect(token.length).toBeGreaterThan(40);
  });

  it("le préfixe rendu correspond au début du jeton", () => {
    const { token, prefix } = generateToken();
    expect(prefix).toBe(token.slice(0, PREFIX_LENGTH));
    expect(prefix.length).toBe(PREFIX_LENGTH);
  });

  it("le haché rendu est celui du jeton", () => {
    const { token, tokenHash } = generateToken();
    expect(tokenHash).toBe(hashToken(token));
  });

  it("le haché ne contient pas le jeton", () => {
    const { token, tokenHash } = generateToken();
    expect(tokenHash).not.toContain(token.slice(TOKEN_NAMESPACE.length));
  });

  it("deux appels ne produisent jamais le même jeton", () => {
    const a = new Set(Array.from({ length: 200 }, () => generateToken().token));
    expect(a.size).toBe(200);
  });

  it("n'utilise que des caractères sûrs en URL et en en-tête HTTP", () => {
    const { token } = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("prefixOf", () => {
  it("extrait le préfixe d'un jeton bien formé", () => {
    const { token, prefix } = generateToken();
    expect(prefixOf(token)).toBe(prefix);
  });

  it("refuse un jeton d'un autre espace de noms", () => {
    expect(prefixOf("sk-quelque-chose-de-tres-long-mais-etranger")).toBeNull();
  });

  it("refuse un jeton trop court pour porter un préfixe", () => {
    expect(prefixOf("afro_vid_")).toBeNull();
  });
});

describe("tokenMatches", () => {
  it("reconnaît le bon jeton", () => {
    const { token, tokenHash } = generateToken();
    expect(tokenMatches(token, tokenHash)).toBe(true);
  });

  it("refuse un autre jeton", () => {
    const { tokenHash } = generateToken();
    expect(tokenMatches(generateToken().token, tokenHash)).toBe(false);
  });

  it("refuse un haché vide ou tronqué sans lever", () => {
    const { token } = generateToken();
    expect(tokenMatches(token, "")).toBe(false);
    expect(tokenMatches(token, "abcd")).toBe(false);
  });
});
