import { expect, test } from "bun:test";
import { parseTimecode, insertSpanSeconds } from "@/lib/video/timecode";

test("parseTimecode : HH:MM:SS et millisecondes", () => {
  expect(parseTimecode("00:00:05")).toBe(5);
  expect(parseTimecode("01:02:03")).toBe(3723);
  expect(parseTimecode("00:00:01.500")).toBe(1.5);
  expect(parseTimecode("00:00:01.5")).toBe(1.5);
});

test("parseTimecode : hors format → null", () => {
  expect(parseTimecode("1:2:3")).toBeNull();
  expect(parseTimecode("abc")).toBeNull();
  expect(parseTimecode(null)).toBeNull();
  expect(parseTimecode("")).toBeNull();
});

test("insertSpanSeconds : out−in si valide, sinon null", () => {
  expect(insertSpanSeconds("00:00:01", "00:00:05")).toBe(4);
  expect(insertSpanSeconds("00:00:05", "00:00:01")).toBeNull(); // out ≤ in
  expect(insertSpanSeconds("00:00:05", "00:00:05")).toBeNull();
  expect(insertSpanSeconds("00:00:01", null)).toBeNull();
  expect(insertSpanSeconds("bad", "00:00:05")).toBeNull();
});
