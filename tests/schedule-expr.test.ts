import { describe, it, expect } from "bun:test";
import {
  toCron, fromCron, nextRuns, describeSpec, SCHEDULE_TZ,
  type ScheduleSpec,
} from "@/lib/pipeline/schedule-expr";
import { pipelineSettingsSchema } from "@/lib/validation";

describe("toCron", () => {
  it("maps each mode to the expected cron", () => {
    expect(toCron({ mode: "off" })).toBe("");
    expect(toCron({ mode: "everyNMinutes", minutes: 15 })).toBe("*/15 * * * *");
    expect(toCron({ mode: "everyNHours", hours: 2 })).toBe("0 */2 * * *");
    expect(toCron({ mode: "daily", time: "08:00" })).toBe("0 8 * * *");
    expect(toCron({ mode: "daily", time: "09:05" })).toBe("5 9 * * *");
    expect(toCron({ mode: "weekdays", days: [1, 2, 3, 4, 5], time: "08:00" })).toBe("0 8 * * 1,2,3,4,5");
    // days are sorted ascending regardless of input order
    expect(toCron({ mode: "weekdays", days: [5, 1, 3], time: "07:30" })).toBe("30 7 * * 1,3,5");
  });
});

describe("fromCron", () => {
  it("recognizes each form toCron produces", () => {
    expect(fromCron("*/15 * * * *")).toEqual({ mode: "everyNMinutes", minutes: 15 });
    expect(fromCron("0 */2 * * *")).toEqual({ mode: "everyNHours", hours: 2 });
    expect(fromCron("0 8 * * *")).toEqual({ mode: "daily", time: "08:00" });
    expect(fromCron("30 7 * * 1,3,5")).toEqual({ mode: "weekdays", days: [1, 3, 5], time: "07:30" });
  });

  it("returns null (never throws) on unrepresentable or invalid input", () => {
    expect(fromCron("0 8 1 * *")).toBeNull();   // day-of-month set — not representable
    expect(fromCron("0 8-17 * * *")).toBeNull(); // hour range — not representable
    expect(fromCron("")).toBeNull();
    expect(fromCron("not a cron")).toBeNull();
  });
});

describe("round-trip invariant", () => {
  const recognized = ["*/15 * * * *", "*/30 * * * *", "0 */3 * * *", "0 8 * * *", "5 9 * * *", "0 8 * * 1,2,3,4,5"];
  it("toCron(fromCron(c)) === c for every recognized cron", () => {
    for (const c of recognized) {
      const spec = fromCron(c);
      expect(spec).not.toBeNull();
      expect(toCron(spec!)).toBe(c);
    }
  });

  const specs: ScheduleSpec[] = [
    { mode: "everyNMinutes", minutes: 30 },
    { mode: "everyNHours", hours: 6 },
    { mode: "daily", time: "23:59" },
    { mode: "weekdays", days: [0, 6], time: "12:00" },
  ];
  it("fromCron(toCron(spec)) equals spec", () => {
    for (const s of specs) expect(fromCron(toCron(s))).toEqual(s);
  });
});

describe("nextRuns", () => {
  it("produces strictly increasing instants at 08:00 UTC for '0 8 * * *'", () => {
    const runs = nextRuns("0 8 * * *", 3);
    expect(runs).toHaveLength(3);
    for (let i = 1; i < runs.length; i++) expect(runs[i].getTime()).toBeGreaterThan(runs[i - 1].getTime());
    for (const d of runs) expect(d.getUTCHours()).toBe(8);
  });

  it("returns [] on an invalid cron rather than throwing", () => {
    expect(nextRuns("not a cron", 3)).toEqual([]);
  });
});

describe("describeSpec", () => {
  it("returns human French summaries mentioning UTC for clock times", () => {
    expect(describeSpec({ mode: "off" })).toMatch(/désactiv/i);
    expect(describeSpec({ mode: "everyNHours", hours: 2 })).toMatch(/2\s*heures/i);
    expect(describeSpec({ mode: "daily", time: "08:00" })).toMatch(/08:00 UTC/);
    expect(describeSpec({ mode: "weekdays", days: [1, 3, 5], time: "08:00" })).toMatch(/UTC/);
  });
});

describe("validation compatibility", () => {
  it("every non-empty toCron output passes pipelineSettingsSchema", () => {
    const crons = ["*/15 * * * *", "0 */2 * * *", "0 8 * * *", "0 8 * * 1,2,3,4,5"];
    for (const scheduleCron of crons) {
      const parsed = pipelineSettingsSchema.pick({ scheduleCron: true }).safeParse({ scheduleCron });
      expect(parsed.success).toBe(true);
    }
  });

  it("SCHEDULE_TZ is UTC", () => expect(SCHEDULE_TZ).toBe("UTC"));
});
