import { expect, test } from "bun:test";
import { nextTakeNumber, estTransitionAutorisee } from "@/lib/video/tournage-rules";

test("nextTakeNumber : vide → 1, sinon max+1 (gaps OK)", () => {
  expect(nextTakeNumber([])).toBe(1);
  expect(nextTakeNumber([1, 2, 3])).toBe(4);
  expect(nextTakeNumber([1, 3])).toBe(4); // max+1, pas comblement de trou
  expect(nextTakeNumber([5])).toBe(6);
});

test("estTransitionAutorisee : seules les trois transitions de tournage", () => {
  expect(estTransitionAutorisee("en_ecriture", "pret_a_tourner")).toBe(true);
  expect(estTransitionAutorisee("pret_a_tourner", "tourne")).toBe(true);
  expect(estTransitionAutorisee("tourne", "en_montage")).toBe(true);
  expect(estTransitionAutorisee("tourne", "publie")).toBe(false);
  expect(estTransitionAutorisee("brouillon", "tourne")).toBe(false);
  expect(estTransitionAutorisee("en_montage", "tourne")).toBe(false); // pas de retour arrière
});
