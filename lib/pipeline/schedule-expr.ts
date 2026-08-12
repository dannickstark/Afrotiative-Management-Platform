import { Cron } from "croner";

// Pure module: no DB, no DOM. croner is used only as a parser/next-run calculator (paused Cron),
// exactly as lib/validation.ts:isValidCron does. Declared here (not in scheduler.ts) so the pure
// module has no dependency on the effectful scheduler; scheduler.ts imports SCHEDULE_TZ from here.
export const SCHEDULE_TZ = "UTC";

export const HOUR_OPTIONS = [1, 2, 3, 4, 6, 8, 12] as const;
export const MINUTE_OPTIONS = [15, 30] as const;

export type ScheduleSpec =
  | { mode: "off" }
  | { mode: "everyNMinutes"; minutes: number }
  | { mode: "everyNHours"; hours: number }
  | { mode: "daily"; time: string }               // "HH:MM"
  | { mode: "weekdays"; days: number[]; time: string }; // days: 0=Sun … 6=Sat

const DOW_LABELS = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// "HH:MM" -> [minute, hour]; throws-free callers guard via fromCron regex first.
function parseTime(time: string): { h: number; m: number } {
  const [h, m] = time.split(":").map((s) => Number(s));
  return { h, m };
}

export function toCron(spec: ScheduleSpec): string {
  switch (spec.mode) {
    case "off":
      return "";
    case "everyNMinutes":
      return `*/${spec.minutes} * * * *`;
    case "everyNHours":
      return `0 */${spec.hours} * * *`;
    case "daily": {
      const { h, m } = parseTime(spec.time);
      return `${m} ${h} * * *`;
    }
    case "weekdays": {
      const { h, m } = parseTime(spec.time);
      const days = [...spec.days].sort((a, b) => a - b).join(",");
      return `${m} ${h} * * ${days}`;
    }
  }
}

const RE_MINUTES = /^\*\/(\d+) \* \* \* \*$/;
const RE_HOURS = /^0 \*\/(\d+) \* \* \*$/;
const RE_DAILY = /^(\d+) (\d+) \* \* \*$/;
const RE_WEEKDAYS = /^(\d+) (\d+) \* \* (\d+(?:,\d+)*)$/;

export function fromCron(cron: string): ScheduleSpec | null {
  const c = cron.trim();
  if (!c) return null;

  let m: RegExpMatchArray | null;
  if ((m = c.match(RE_MINUTES))) {
    const minutes = Number(m[1]);
    return minutes >= 1 && minutes <= 59 ? { mode: "everyNMinutes", minutes } : null;
  }
  if ((m = c.match(RE_HOURS))) {
    const hours = Number(m[1]);
    return hours >= 1 && hours <= 23 ? { mode: "everyNHours", hours } : null;
  }
  if ((m = c.match(RE_DAILY))) {
    const minute = Number(m[1]);
    const hour = Number(m[2]);
    if (minute > 59 || hour > 23) return null;
    return { mode: "daily", time: `${pad(hour)}:${pad(minute)}` };
  }
  if ((m = c.match(RE_WEEKDAYS))) {
    const minute = Number(m[1]);
    const hour = Number(m[2]);
    if (minute > 59 || hour > 23) return null;
    const days = m[3].split(",").map(Number);
    if (days.some((d) => d < 0 || d > 6)) return null;
    const sorted = [...days].sort((a, b) => a - b);
    return { mode: "weekdays", days: sorted, time: `${pad(hour)}:${pad(minute)}` };
  }
  return null;
}

export function nextRuns(cron: string, count: number, tz: string = SCHEDULE_TZ): Date[] {
  const c = cron.trim();
  if (!c) return [];
  try {
    const job = new Cron(c, { timezone: tz, paused: true });
    return job.nextRuns(count) ?? [];
  } catch {
    return [];
  }
}

export function describeSpec(spec: ScheduleSpec): string {
  switch (spec.mode) {
    case "off":
      return "Planification désactivée";
    case "everyNMinutes":
      return `Toutes les ${spec.minutes} minutes`;
    case "everyNHours":
      return spec.hours === 1 ? "Toutes les heures" : `Toutes les ${spec.hours} heures`;
    case "daily":
      return `Chaque jour à ${spec.time} UTC`;
    case "weekdays": {
      const labels = [...spec.days].sort((a, b) => a - b).map((d) => DOW_LABELS[d]).join(", ");
      return `${labels} à ${spec.time} UTC`;
    }
  }
}
