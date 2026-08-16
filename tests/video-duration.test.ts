import { describe, it, expect } from "bun:test";
import {
  countWords, estimateSeconds, beatSeconds, variantSeconds, isBreathRisk, DEFAULT_WPM,
} from "@/lib/video/duration";

describe("countWords", () => {
  it("compte les mots en ignorant les balises", () => {
    expect(countWords("<p>Trois petits mots</p>")).toBe(3);
  });

  it("ne compte pas les balises comme des mots", () => {
    expect(countWords("<p><strong>Un</strong> <em>deux</em></p>")).toBe(2);
  });

  it("renvoie zéro sur du vide", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("<p></p>")).toBe(0);
  });

  it("décode les entités les plus courantes avant de compter", () => {
    expect(countWords("<p>l&#x27;économie ivoirienne</p>")).toBe(2);
  });
});

describe("estimateSeconds", () => {
  it("convertit à la cadence par défaut, arrondi au supérieur", () => {
    const html = `<p>${Array(155).fill("mot").join(" ")}</p>`;
    expect(estimateSeconds(html)).toBe(60);
  });

  it("respecte une cadence explicite", () => {
    const html = `<p>${Array(100).fill("mot").join(" ")}</p>`;
    expect(estimateSeconds(html, 100)).toBe(60);
  });

  it("arrondit au supérieur plutôt qu'au plus proche", () => {
    expect(estimateSeconds("<p>un mot</p>", 60)).toBe(2);
  });

  it("la cadence par défaut est celle du spec", () => {
    expect(DEFAULT_WPM).toBe(155);
  });
});

describe("beatSeconds", () => {
  it("utilise l'estimation quand aucune durée n'est forcée", () => {
    expect(beatSeconds({ spokenText: `<p>${Array(155).fill("m").join(" ")}</p>`, durationOverrideSec: null })).toBe(60);
  });

  it("la durée forcée l'emporte", () => {
    expect(beatSeconds({ spokenText: `<p>${Array(155).fill("m").join(" ")}</p>`, durationOverrideSec: 12 })).toBe(12);
  });

  it("une durée forcée à zéro l'emporte aussi", () => {
    // Le point : `?? ` et non `|| `, sinon 0 retomberait sur l'estimation.
    expect(beatSeconds({ spokenText: "<p>un mot</p>", durationOverrideSec: 0 })).toBe(0);
  });
});

describe("variantSeconds", () => {
  it("somme les beats", () => {
    expect(variantSeconds([
      { spokenText: "", durationOverrideSec: 10 },
      { spokenText: "", durationOverrideSec: 32 },
    ])).toBe(42);
  });
});

describe("isBreathRisk", () => {
  it("signale un bloc de plus de 35 mots", () => {
    expect(isBreathRisk(`<p>${Array(36).fill("mot").join(" ")}</p>`)).toBe(true);
  });

  it("ne signale pas un bloc court", () => {
    expect(isBreathRisk("<p>une phrase courte</p>")).toBe(false);
  });
});
