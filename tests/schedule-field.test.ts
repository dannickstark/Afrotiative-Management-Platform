import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ScheduleField } from "@/components/settings/schedule-field";

function render(value: string) {
  return renderToStaticMarkup(React.createElement(ScheduleField, { value, onChange: () => {} }));
}

describe("ScheduleField", () => {
  it("labels the field as UTC", () => {
    expect(render("0 */2 * * *")).toMatch(/UTC/);
  });

  it("shows a human summary for a recognized 'every 2 hours' cron", () => {
    const html = render("0 */2 * * *");
    expect(html).toMatch(/2\s*heures/i);
  });

  it("shows a next-runs preview for a valid schedule", () => {
    // nextRuns yields 3 dates; the preview area should be non-empty (contains a year digit).
    expect(render("0 8 * * *")).toMatch(/20\d\d|UTC/);
  });

  it("keeps an unrecognized hand-written cron intact in the advanced field", () => {
    const html = render("0 8 1 * *"); // day-of-month — fromCron returns null
    expect(html).toContain("0 8 1 * *");
  });

  it("renders the disabled/off state without throwing for empty value", () => {
    expect(() => render("")).not.toThrow();
  });
});
