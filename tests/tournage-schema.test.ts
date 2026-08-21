import { expect, test } from "bun:test";
import { scriptBeats, beatTakes } from "@/db";

test("selectedTakeId exposé sur script_beats ; beat_takes présent", () => {
  expect(scriptBeats.selectedTakeId).toBeDefined();
  expect(beatTakes.number).toBeDefined();
  expect(beatTakes.status).toBeDefined();
});
