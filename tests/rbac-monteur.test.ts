import { expect, test } from "bun:test";
import { can } from "@/lib/rbac";

test("monteur peut lire et annoter la vidéo, rien d'autre", () => {
  expect(can("monteur", "video", "read")).toBe(true);
  expect(can("monteur", "video", "annotate")).toBe(true);
  expect(can("monteur", "video", "manage")).toBe(false);
  expect(can("monteur", "article", "read")).toBe(false);
});

test("éditeur et admin peuvent annoter ; journaliste non", () => {
  expect(can("editor", "video", "annotate")).toBe(true);
  expect(can("admin", "video", "annotate")).toBe(true);
  expect(can("journalist", "video", "annotate")).toBe(false);
});
