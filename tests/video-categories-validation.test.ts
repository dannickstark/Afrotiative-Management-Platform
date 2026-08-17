import { describe, it, expect } from "bun:test";
import {
  videoCategorySchema, setProjectCategorySchema, createVideoProjectSchema,
} from "@/lib/validation";

const OK = { name: "Interview", description: "Entretien face caméra", instructions: "Poser des questions ouvertes.", position: 0 };
const UUID = "11111111-1111-4111-8111-111111111111";

describe("videoCategorySchema", () => {
  it("accepte une catégorie complète", () => {
    expect(videoCategorySchema.safeParse(OK).success).toBe(true);
  });

  it("accepte une description absente", () => {
    expect(videoCategorySchema.safeParse({ ...OK, description: null }).success).toBe(true);
  });

  it("refuse un nom vide", () => {
    expect(videoCategorySchema.safeParse({ ...OK, name: "" }).success).toBe(false);
  });

  it("refuse des instructions vides — une catégorie sans instructions n'a aucun effet", () => {
    expect(videoCategorySchema.safeParse({ ...OK, instructions: "" }).success).toBe(false);
  });

  it("borne les instructions à 20 000 caractères, comme le modèle de brief", () => {
    expect(videoCategorySchema.safeParse({ ...OK, instructions: "x".repeat(20001) }).success).toBe(false);
    expect(videoCategorySchema.safeParse({ ...OK, instructions: "x".repeat(20000) }).success).toBe(true);
  });
});

describe("setProjectCategorySchema", () => {
  it("accepte une catégorie et son retrait", () => {
    expect(setProjectCategorySchema.safeParse({ projectId: UUID, categoryId: UUID }).success).toBe(true);
    expect(setProjectCategorySchema.safeParse({ projectId: UUID, categoryId: null }).success).toBe(true);
  });

  it("refuse un identifiant qui n'est pas un uuid", () => {
    expect(setProjectCategorySchema.safeParse({ projectId: "abc", categoryId: null }).success).toBe(false);
  });
});

describe("createVideoProjectSchema", () => {
  const base = {
    title: "Titre", subject: null, platform: "youtube_long",
    targetDurationSec: null, aspectRatio: "16:9", articleId: null,
  };

  it("accepte un projet sans catégorie", () => {
    expect(createVideoProjectSchema.safeParse({ ...base, categoryId: null }).success).toBe(true);
  });

  it("accepte un projet avec catégorie", () => {
    expect(createVideoProjectSchema.safeParse({ ...base, categoryId: UUID }).success).toBe(true);
  });
});
