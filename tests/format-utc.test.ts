import { describe, expect, test } from "bun:test";
import { formatDateUtc } from "@/lib/format";

// Regression test for the "next runs" preview bug: formatDateUtc must render a fixed
// instant using its UTC clock time regardless of the host machine's local timezone,
// so the "(UTC)" label in schedule-field.tsx is truthful on every host (CI, dev, etc).
describe("formatDateUtc", () => {
  test("renders the UTC hour/minute of a fixed instant, independent of host timezone", () => {
    const s = formatDateUtc(new Date("2026-08-12T08:30:00Z"));
    expect(s).toContain("08:30");
  });

  test("accepts an ISO string and returns the same UTC time as a Date", () => {
    const fromString = formatDateUtc("2026-08-12T08:30:00Z");
    const fromDate = formatDateUtc(new Date("2026-08-12T08:30:00Z"));
    expect(fromString).toBe(fromDate);
    expect(fromString).toContain("08:30");
  });

  test("returns the placeholder for null", () => {
    expect(formatDateUtc(null)).toBe("—");
  });
});
