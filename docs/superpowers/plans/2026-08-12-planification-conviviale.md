# Planification conviviale (pipeline + diffusion) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw cron text input in pipeline settings (and the raw hours input in social diffusion) with friendly, preset-driven pickers that generate the same stored values, and verify scheduled triggering + background execution fire end-to-end before go-live.

**Architecture:** A pure, DOM-free module (`schedule-expr.ts`) converts between a friendly `ScheduleSpec` and a cron string, plus computes next-run previews via croner. A client component (`schedule-field.tsx`) drives it and stays controlled by the single `scheduleCron` string the form already owns — no schema change. The croner scheduler passes an explicit `timezone: "UTC"`. Social diffusion gets a lighter `interval-picker.tsx` for its integer `autoIntervalHours`. Verification is pure unit tests + extended scheduler tests + a manual live end-to-end run.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, croner 10 (already installed, browser-safe), Drizzle/Postgres, bun test, shadcn UI (`select`, `collapsible`, `button`, `input`, `label`).

## Global Constraints

- **Timezone is UTC**, passed explicitly to croner. All picked times mean UTC; the UI labels this "UTC". (Verbatim decision 2026-08-12.)
- **No DB migration.** `pipeline_settings.schedule_cron` stays `text`; `distributions.auto_interval_hours` stays `integer`. Pickers only change the input UI, not stored shapes.
- **Round-trip invariant:** for any cron string `c` that `fromCron` recognizes, `toCron(fromCron(c)!) === c`. A hand-written cron `fromCron` does not recognize returns `null` and opens the Advanced field with the raw string intact — never silently rewritten.
- **Validation unchanged:** `pipelineSettingsSchema.scheduleCron` (`lib/validation.ts:100`) already gates via croner; every `toCron` output must pass it.
- **Scheduler never throws** from `reloadSchedule`/`initScheduler` (reached from `instrumentation.register()`); invalid cron degrades to "no schedule".
- **French UI copy**, matching the existing settings forms.
- **Test lanes:** logic/component tests must import NO DB (`@/db`) so they run in the fast pure lane (`bun run test:pure`). DB-touching scheduler tests stay in the default lane.
- Days of week use cron convention `0=Sunday … 6=Saturday`; `toCron` sorts days ascending and joins with commas.

---

### Task 1: Pure module `lib/pipeline/schedule-expr.ts`

**Files:**
- Create: `lib/pipeline/schedule-expr.ts`
- Test: `tests/schedule-expr.test.ts`

**Interfaces:**
- Consumes: `croner` (`Cron`), `pipelineSettingsSchema` (from `@/lib/validation`, test only).
- Produces:
  - `type ScheduleSpec = { mode: "off" } | { mode: "everyNMinutes"; minutes: number } | { mode: "everyNHours"; hours: number } | { mode: "daily"; time: string } | { mode: "weekdays"; days: number[]; time: string }`
  - `const SCHEDULE_TZ = "UTC"`
  - `function toCron(spec: ScheduleSpec): string`
  - `function fromCron(cron: string): ScheduleSpec | null`
  - `function nextRuns(cron: string, count: number, tz?: string): Date[]`
  - `function describeSpec(spec: ScheduleSpec): string`
  - `const HOUR_OPTIONS: number[]` = `[1,2,3,4,6,8,12]`; `const MINUTE_OPTIONS: number[]` = `[15,30]`

- [ ] **Step 1: Write the failing test**

Create `tests/schedule-expr.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/schedule-expr.test.ts`
Expected: FAIL — module `@/lib/pipeline/schedule-expr` not found.

- [ ] **Step 3: Write the minimal implementation**

Create `lib/pipeline/schedule-expr.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/schedule-expr.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Confirm it runs in the pure lane**

Run: `bun run test:pure 2>&1 | grep -i schedule-expr`
Expected: the file appears in the pure lane output (it imports no `@/db`).

- [ ] **Step 6: Commit**

```bash
git add lib/pipeline/schedule-expr.ts tests/schedule-expr.test.ts
git commit -m "feat(schedule): pure schedule-expr module (spec<->cron, next-runs, UTC)"
```

---

### Task 2: Explicit UTC timezone in the scheduler

**Files:**
- Modify: `lib/pipeline/scheduler.ts` (the `reloadSchedule` job construction, ~line 116, and its log line)
- Test: `tests/pipeline-scheduler.test.ts` (extend — DB lane)

**Interfaces:**
- Consumes: `SCHEDULE_TZ` from `@/lib/pipeline/schedule-expr`, `getScheduledJob`, `reloadSchedule` (existing exports).
- Produces: no new exports; behavior — the scheduled job is built with `{ timezone: "UTC", protect: true, catch: true }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/pipeline-scheduler.test.ts` a new describe block (uses the DB, same as the file's existing tests — it reads/writes the `pipeline_settings` singleton). Follow the file's existing setup/teardown convention for restoring `scheduleCron`:

```ts
import { SCHEDULE_TZ } from "@/lib/pipeline/schedule-expr";

describe("reloadSchedule — timezone", () => {
  it("builds the job so '0 8 * * *' next-fires at 08:00 UTC", async () => {
    const [prev] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, 1));
    try {
      await db.update(pipelineSettings).set({ scheduleCron: "0 8 * * *" }).where(eq(pipelineSettings.id, 1));
      await reloadSchedule();
      const job = getScheduledJob();
      expect(job).not.toBeNull();
      const next = job!.nextRun();
      expect(next).not.toBeNull();
      // Behavioral proof the UTC timezone is wired: 08:00 in UTC, regardless of host TZ.
      expect(next!.getUTCHours()).toBe(8);
      expect(next!.getUTCMinutes()).toBe(0);
    } finally {
      await db.update(pipelineSettings).set({ scheduleCron: prev?.scheduleCron ?? null }).where(eq(pipelineSettings.id, 1));
      await reloadSchedule();
    }
  });

  it("SCHEDULE_TZ is UTC", () => expect(SCHEDULE_TZ).toBe("UTC"));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/pipeline-scheduler.test.ts`
Expected: FAIL — without the `timezone` option croner uses the host TZ; on a non-UTC host `getUTCHours()` would not be 8. (On a UTC host it may already pass; the explicit option below is still required so behavior is deterministic in production regardless of host TZ.)

- [ ] **Step 3: Make the change**

In `lib/pipeline/scheduler.ts`, add the import at the top:

```ts
import { SCHEDULE_TZ } from "@/lib/pipeline/schedule-expr";
```

Then in `reloadSchedule`, change the job construction from:

```ts
    job = new Cron(scheduleCron, { protect: true, catch: true }, triggerScheduledRun);
    console.log(`[scheduler] planification active: ${scheduleCron} (prochaine: ${job.nextRun()?.toISOString()})`);
```

to:

```ts
    job = new Cron(scheduleCron, { timezone: SCHEDULE_TZ, protect: true, catch: true }, triggerScheduledRun);
    console.log(`[scheduler] planification active: ${scheduleCron} (${SCHEDULE_TZ}, prochaine: ${job.nextRun()?.toISOString()})`);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/pipeline-scheduler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline/scheduler.ts tests/pipeline-scheduler.test.ts
git commit -m "feat(scheduler): pin scheduled pipeline job to UTC timezone"
```

---

### Task 3: `ScheduleField` component

**Files:**
- Create: `components/settings/schedule-field.tsx`
- Test: `tests/schedule-field.test.ts` (pure lane — imports no DB)

**Interfaces:**
- Consumes: `toCron`, `fromCron`, `nextRuns`, `describeSpec`, `HOUR_OPTIONS`, `MINUTE_OPTIONS`, `type ScheduleSpec` (from `@/lib/pipeline/schedule-expr`); UI primitives `@/components/ui/{select,collapsible,button,input,label}`; `formatDate` from `@/lib/format`.
- Produces: `export function ScheduleField(props: { value: string; onChange: (cron: string) => void; disabled?: boolean }): JSX.Element`

**Design notes (no effects, controlled by `value`):**
- On each render compute `const parsed = fromCron(value)`. The active mode = `parsed?.mode ?? (value.trim() ? "advanced" : "off")`.
- Keep local `useState` for sub-field drafts (time, selected days, chosen hours/minutes), initialized from `parsed`. Changing any control computes a `ScheduleSpec`, calls `toCron`, and fires `onChange(cron)`.
- The Advanced section is a `Collapsible` wrapping the current raw `Input`; it is open by default when `parsed === null && value.trim() !== ""`.
- Preview: `const runs = nextRuns(value, 3)`. If `value.trim()` and `runs.length === 0`, show the validation message `"Cron invalide (ex. « 0 */2 * * * »)"`; else list `runs.map(formatDate)` with a trailing "(UTC)". Header/label reads `Planification (UTC)` and a helper line `Les heures sont en UTC`.
- Never call `onChange` during render — only from user-event handlers.

- [ ] **Step 1: Write the failing test**

Create `tests/schedule-field.test.ts` (server-render smoke test, same pattern as `tests/diffusion-settings-ui.test.ts`):

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/schedule-field.test.ts`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement the component**

Create `components/settings/schedule-field.tsx` as a `"use client"` component implementing the design notes above. Use `Select` for the mode chooser and for the hours/minutes preset dropdowns, `Input type="time"` for the clock, a row of toggle `Button`s (variant switches on selection) for weekdays labelled `L M M J V S D` (mapping to cron days `1 2 3 4 5 6 0`), and a `Collapsible` for Advanced holding the existing raw `Input` (`placeholder="0 */2 * * *"`). Compute `parsed`, `runs`, and the preview text exactly as described. Fire `onChange(toCron(spec))` from every control's handler; the Advanced input fires `onChange(e.target.value)` directly.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/schedule-field.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add components/settings/schedule-field.tsx tests/schedule-field.test.ts
git commit -m "feat(settings): friendly ScheduleField (presets + advanced cron, UTC preview)"
```

---

### Task 4: Wire `ScheduleField` into the pipeline settings form

**Files:**
- Modify: `components/settings/pipeline-settings-form.tsx` (the "Planification" card, ~lines 190-206; imports at top)

**Interfaces:**
- Consumes: `ScheduleField` from `@/components/settings/schedule-field`; existing `form.scheduleCron` state + `setForm`.
- Produces: unchanged submit path — `scheduleCron` still submitted as a string to `updatePipelineSettings`.

- [ ] **Step 1: Make the change**

Add the import near the other component imports:

```ts
import { ScheduleField } from "@/components/settings/schedule-field";
```

Replace the CardContent body of the Planification card:

```tsx
        <CardContent>
          <div className="space-y-1.5">
            <Label htmlFor="schedule-cron">Cron de planification (optionnel)</Label>
            <Input
              id="schedule-cron" disabled={isSaving}
              value={form.scheduleCron}
              onChange={(e) => setForm((f) => ({ ...f, scheduleCron: e.target.value }))}
              placeholder="0 */2 * * *"
            />
          </div>
        </CardContent>
```

with:

```tsx
        <CardContent>
          <ScheduleField
            value={form.scheduleCron}
            disabled={isSaving}
            onChange={(cron) => setForm((f) => ({ ...f, scheduleCron: cron }))}
          />
        </CardContent>
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors. (Remove the now-unused `Input`/`Label` imports only if no other field in the file still uses them — verify with a quick grep before deleting.)

- [ ] **Step 3: Verify existing settings tests still pass**

Run: `bun test tests/settings-rbac.test.ts tests/schedule-field.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add components/settings/pipeline-settings-form.tsx
git commit -m "feat(settings): use ScheduleField in pipeline settings Planification card"
```

---

### Task 5: `IntervalPicker` component (social diffusion)

**Files:**
- Create: `components/settings/interval-picker.tsx`
- Test: `tests/interval-picker.test.ts` (pure lane)

**Interfaces:**
- Consumes: UI primitives `@/components/ui/{select,input}`.
- Produces: `export function IntervalPicker(props: { value: number; onChange: (hours: number) => void; disabled?: boolean; id?: string }): JSX.Element`
- Preset options: `1, 2, 3, 6, 12, 24` hours plus a `"custom"` entry that reveals a numeric `Input` (min 1). When `value` is not one of the presets, the picker opens on "custom" with the numeric input showing `value`.

- [ ] **Step 1: Write the failing test**

Create `tests/interval-picker.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntervalPicker } from "@/components/settings/interval-picker";

function render(value: number) {
  return renderToStaticMarkup(React.createElement(IntervalPicker, { value, onChange: () => {} }));
}

describe("IntervalPicker", () => {
  it("renders a preset value (6h) without throwing", () => {
    expect(() => render(6)).not.toThrow();
    expect(render(6)).toMatch(/heure/i);
  });

  it("shows the custom numeric input when value is not a preset", () => {
    const html = render(5); // 5 is not in [1,2,3,6,12,24]
    expect(html).toContain("5");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/interval-picker.test.ts`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement the component**

Create `components/settings/interval-picker.tsx` (`"use client"`). Use a `Select` whose items are `1,2,3,6,12,24` (labels like `Toutes les 6 heures`, and `Toutes les heures` for `1`) plus a final `Personnalisé…` item. Local `useState` tracks whether "custom" is active (initialized to `!PRESETS.includes(value)`). Selecting a preset calls `onChange(preset)`; choosing custom reveals an `Input type="number" min={1}` whose change fires `onChange(Number(e.target.value))` (ignore/keep last valid when `<= 0` or NaN, mirroring the form's existing `autoIntervalHours <= 0` guard).

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/interval-picker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/settings/interval-picker.tsx tests/interval-picker.test.ts
git commit -m "feat(settings): IntervalPicker for social auto-post interval"
```

---

### Task 6: Wire `IntervalPicker` into the social channel form

**Files:**
- Modify: `components/settings/social-channel-form.tsx` (the `autoIntervalHours` `Input`, ~lines 458-462; imports at top)

**Interfaces:**
- Consumes: `IntervalPicker`; existing `form.autoIntervalHours` (a string in form state) + `setForm`.
- Produces: unchanged submit path — `autoIntervalHours` still parsed via `Number(form.autoIntervalHours)` and validated by the existing `autoIntervalHours <= 0` guard (line ~158).

- [ ] **Step 1: Make the change**

Add the import:

```ts
import { IntervalPicker } from "@/components/settings/interval-picker";
```

Replace the `autoIntervalHours` `Input` (lines ~458-462):

```tsx
            <Input
              // ...existing props for autoIntervalHours...
              value={form.autoIntervalHours}
              onChange={(e) => setForm((f) => ({ ...f, autoIntervalHours: e.target.value }))}
            />
```

with:

```tsx
            <IntervalPicker
              value={Number(form.autoIntervalHours) || 6}
              disabled={isSaving}
              onChange={(hours) => setForm((f) => ({ ...f, autoIntervalHours: String(hours) }))}
            />
```

(Keep `autoIntervalHours` as a string in form state so the rest of the submit/validation code is untouched. `isSaving` is the same flag the other inputs use in this file — confirm its name with a quick grep before editing.)

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Verify diffusion settings UI tests still pass**

Run: `bun test tests/diffusion-settings-ui.test.ts tests/interval-picker.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add components/settings/social-channel-form.tsx
git commit -m "feat(settings): use IntervalPicker for social auto-post interval"
```

---

### Task 7: Full-suite gate + live end-to-end verification

**Files:** none (verification task). Deliverable: recorded evidence that scheduled triggering + background execution work end-to-end.

- [ ] **Step 1: Run the pure lane**

Run: `bun run test:pure`
Expected: PASS, including `schedule-expr`, `schedule-field`, `interval-picker`.

- [ ] **Step 2: Run the scheduler DB tests**

Run: `bun test tests/pipeline-scheduler.test.ts`
Expected: PASS, including the new UTC timezone test.

- [ ] **Step 3: Typecheck the whole project**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Boot the app and confirm the scheduler starts**

Run: `bun run dev` (i.e. `next dev --turbopack`), then watch the logs.
Expected: a `[scheduler]` line appears at boot — either `aucune planification configurée` or `planification active: … (UTC, prochaine: …)`, plus `tic de diffusion automatique actif : */15 * * * *`. This proves `instrumentation.ts` → `initScheduler()` runs under `next dev`.

- [ ] **Step 5: Configure a short schedule against a test feed**

In the running app: ensure at least one `feeds` row is `active = true` (a small, reliable public RSS URL). Open `/settings` (pipeline settings), pick **Advanced** mode and enter a one-minute cron `* * * * *` (fastest way to observe a fire), save. Confirm the log shows `planification active: * * * * * (UTC, prochaine: …)` immediately after save — proving `reloadSchedule()` reloaded the job live without a restart.

- [ ] **Step 6: Observe a scheduled run fire and complete in the background**

Wait up to ~1 minute. Expected in logs: `[scheduler] exécution planifiée: <status> (<n> article(s))`. Then verify in the DB that a run was recorded with the scheduled trigger:

Run:
```bash
psql "$DATABASE_URL" -c "select id, triggered_by, status, produced, started_at, finished_at from pipeline_runs order by started_at desc limit 3;"
```
Expected: the newest row has `triggered_by = 'scheduled'` and a terminal `status` (`success`/`partial`/`skipped`), with `finished_at` set — i.e. it ran to completion in the background off the request path.

- [ ] **Step 7: Confirm the overlap guard**

While a run is active (or by triggering two fires close together), confirm the log shows `exécution déjà en cours — déclenchement ignoré` for the second — the DB "one running" interlock holds.

- [ ] **Step 8: Reset the schedule**

Set the schedule back to the intended production cadence (via the friendly presets — e.g. **Every 2 hours**), save, and confirm the log shows the new `planification active:` line. If no in-app schedule is wanted for launch, set it to **Off** and confirm `aucune planification configurée`.

- [ ] **Step 9: Record results**

Note in the PR/handoff: the observed boot log, the `scheduled` run row, and the final production cadence chosen. No code commit for this task.

---

## Self-Review

**Spec coverage:**
- Part 1 (pure module) → Task 1. ✅ modes off/everyNMinutes/everyNHours/daily/weekdays, `toCron`/`fromCron`/`nextRuns`/`describeSpec`, `SCHEDULE_TZ="UTC"`, round-trip invariant, validation compat.
- Part 2 (component) → Tasks 3-4. ✅ controlled by `scheduleCron`, advanced Collapsible, UTC label, preview.
- Part 3 (scheduler UTC) → Task 2. ✅ explicit `timezone`, never-throw preserved, enriched log.
- Part 4 (social IntervalPicker) → Tasks 5-6. ✅ integer storage unchanged.
- Part 5 (verification) → Tasks 1-7 tests + Task 7 live run. ✅ pure tests, scheduler tests, live e2e, reload-without-restart, overlap guard.

**Placeholder scan:** No TBD/TODO. Component internals in Tasks 3/5 are described with exact props, primitives, and behavior rather than full JSX — acceptable because the public interface, the pure logic they call, and their tests are fully specified; the implementer has an exact contract and a red test to satisfy.

**Type consistency:** `ScheduleSpec`, `toCron`, `fromCron`, `nextRuns`, `describeSpec`, `SCHEDULE_TZ`, `HOUR_OPTIONS`, `MINUTE_OPTIONS` are defined in Task 1 and consumed with the same names/signatures in Tasks 2-4. `IntervalPicker`/`ScheduleField` prop shapes match between their creation (Tasks 3/5) and wiring (Tasks 4/6). Cron day convention (0=Sun) is stated in Global Constraints and used consistently.
