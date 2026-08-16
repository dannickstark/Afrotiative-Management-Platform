import { describe, it, expect } from "bun:test";
import { NoObjectGeneratedError } from "ai";
import { classifyOpenRouterError } from "@/lib/ai/openrouter-errors";

// Fabrique une NoObjectGeneratedError telle que generateObject la jette réellement (le marqueur
// interne reconnu par isInstance n'est posé que par le vrai constructeur — un objet nu qui
// ressemblerait à l'erreur ne serait PAS classé no_object, et c'est voulu).
function noObject(message: string, text?: string): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    message,
    text,
    response: { id: "r", timestamp: new Date(0), modelId: "openai/gpt-4o-mini" },
    // Le classement ne lit jamais `usage` — fixture minimale, cast assumé plutôt que de recopier
    // toute la forme LanguageModelUsage (détails de jetons compris) sans aucun rapport avec le test.
    usage: {} as ConstructorParameters<typeof NoObjectGeneratedError>[0]["usage"],
    finishReason: "stop",
  });
}

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

  // Les trois formes réellement observées en production, toutes côté MODÈLE (le fournisseur a
  // répondu, la clé a fonctionné) : changer de jeton n'y peut rien, d'où leur bucket dédié.
  it("NoObjectGeneratedError « could not parse the response » → no_object", () =>
    expect(classifyOpenRouterError(noObject("No object generated: could not parse the response.", "{"))).toBe("no_object"));
  it("NoObjectGeneratedError « response did not match schema » → no_object", () =>
    expect(classifyOpenRouterError(noObject("No object generated: response did not match schema.", "{}"))).toBe("no_object"));
  it("NoObjectGeneratedError « the model did not return a response » → no_object", () =>
    expect(classifyOpenRouterError(noObject("No object generated: the model did not return a response."))).toBe("no_object"));

  // Un simple message ressemblant ne suffit pas : seul le vrai type d'erreur du SDK compte, sinon
  // une erreur de transport recopiant ce texte serait à tort traitée comme définitive.
  it("un objet nu qui imite le message n'est PAS classé no_object", () =>
    expect(classifyOpenRouterError({ message: "No object generated: could not parse the response." })).toBe("error"));

  // Le type l'emporte sur la lecture du message : le mot « quota » recopié dans le texte du modèle
  // ne doit pas transformer un échec de schéma en rate_limited (et donc relancer toute la rotation).
  it("une NoObjectGeneratedError dont le message contient « quota » reste no_object", () =>
    expect(classifyOpenRouterError(noObject("No object generated: response did not match schema. quota"))).toBe("no_object"));
});
