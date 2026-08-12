"use client";

import { useState } from "react";
import {
  toCron,
  fromCron,
  nextRuns,
  describeSpec,
  HOUR_OPTIONS,
  MINUTE_OPTIONS,
  type ScheduleSpec,
} from "@/lib/pipeline/schedule-expr";
import { formatDateUtc } from "@/lib/format";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// Cron day convention: 0=Sunday..6=Saturday. UI weekday labels "L M M J V S D" map to cron days
// 1 2 3 4 5 6 0 (Monday-first display, Sunday-last cron value) — see schedule-expr.ts header comment.
const WEEKDAY_LABELS: { label: string; day: number }[] = [
  { label: "L", day: 1 },
  { label: "M", day: 2 },
  { label: "M", day: 3 },
  { label: "J", day: 4 },
  { label: "V", day: 5 },
  { label: "S", day: 6 },
  { label: "D", day: 0 },
];

type Mode = "off" | "everyNMinutes" | "everyNHours" | "daily" | "weekdays" | "advanced";

export function ScheduleField(props: { value: string; onChange: (cron: string) => void; disabled?: boolean }) {
  const { value, onChange, disabled } = props;
  const parsed = fromCron(value);
  const mode: Mode = parsed?.mode ?? (value.trim() ? "advanced" : "off");

  // Sub-field drafts, initialized from the currently parsed spec (or sensible defaults). These only
  // drive the UI controls when their mode is active; onChange is fired exclusively from handlers.
  const [time, setTime] = useState<string>(
    parsed?.mode === "daily" || parsed?.mode === "weekdays" ? parsed.time : "08:00"
  );
  const [days, setDays] = useState<number[]>(parsed?.mode === "weekdays" ? parsed.days : [1, 2, 3, 4, 5]);
  const [hours, setHours] = useState<number>(parsed?.mode === "everyNHours" ? parsed.hours : HOUR_OPTIONS[0]);
  const [minutes, setMinutes] = useState<number>(parsed?.mode === "everyNMinutes" ? parsed.minutes : MINUTE_OPTIONS[0]);

  const [advancedOpen, setAdvancedOpen] = useState(parsed === null && value.trim() !== "");

  const runs = nextRuns(value, 3);
  const showInvalid = value.trim() !== "" && runs.length === 0;

  function emit(spec: ScheduleSpec) {
    onChange(toCron(spec));
  }

  function handleModeChange(next: string | null) {
    const m = (next ?? "off") as Mode;
    if (m === "advanced") {
      setAdvancedOpen(true);
      return; // leave `value` untouched — advanced editing happens in the raw Input below
    }
    switch (m) {
      case "off":
        emit({ mode: "off" });
        break;
      case "everyNMinutes":
        emit({ mode: "everyNMinutes", minutes });
        break;
      case "everyNHours":
        emit({ mode: "everyNHours", hours });
        break;
      case "daily":
        emit({ mode: "daily", time });
        break;
      case "weekdays":
        emit({ mode: "weekdays", days, time });
        break;
    }
  }

  function handleTimeChange(next: string) {
    setTime(next);
    if (mode === "daily") emit({ mode: "daily", time: next });
    else if (mode === "weekdays") emit({ mode: "weekdays", days, time: next });
  }

  function handleHoursChange(next: string | null) {
    const h = Number(next ?? hours);
    setHours(h);
    if (mode === "everyNHours") emit({ mode: "everyNHours", hours: h });
  }

  function handleMinutesChange(next: string | null) {
    const m = Number(next ?? minutes);
    setMinutes(m);
    if (mode === "everyNMinutes") emit({ mode: "everyNMinutes", minutes: m });
  }

  function toggleDay(day: number) {
    const nextDays = days.includes(day) ? days.filter((d) => d !== day) : [...days, day];
    setDays(nextDays);
    if (mode === "weekdays") emit({ mode: "weekdays", days: nextDays, time });
  }

  return (
    <div className="flex flex-col gap-2">
      <Label>Planification (UTC)</Label>
      <p className="text-xs text-muted-foreground">Les heures sont en UTC</p>

      <Select value={mode} onValueChange={handleModeChange} disabled={disabled}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="off">Désactivée</SelectItem>
          <SelectItem value="everyNMinutes">Toutes les N minutes</SelectItem>
          <SelectItem value="everyNHours">Toutes les N heures</SelectItem>
          <SelectItem value="daily">Chaque jour</SelectItem>
          <SelectItem value="weekdays">Jours de la semaine</SelectItem>
          <SelectItem value="advanced">Avancé (cron)</SelectItem>
        </SelectContent>
      </Select>

      {mode === "everyNMinutes" && (
        <Select value={String(minutes)} onValueChange={handleMinutesChange} disabled={disabled}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MINUTE_OPTIONS.map((m) => (
              <SelectItem key={m} value={String(m)}>
                {m} minutes
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {mode === "everyNHours" && (
        <Select value={String(hours)} onValueChange={handleHoursChange} disabled={disabled}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HOUR_OPTIONS.map((h) => (
              <SelectItem key={h} value={String(h)}>
                {h === 1 ? "1 heure" : `${h} heures`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {(mode === "daily" || mode === "weekdays") && (
        <Input
          type="time"
          value={time}
          disabled={disabled}
          onChange={(e) => handleTimeChange(e.target.value)}
        />
      )}

      {mode === "weekdays" && (
        <div className="flex gap-1">
          {WEEKDAY_LABELS.map(({ label, day }) => (
            <Button
              key={day}
              type="button"
              size="sm"
              variant={days.includes(day) ? "default" : "outline"}
              disabled={disabled}
              onClick={() => toggleDay(day)}
            >
              {label}
            </Button>
          ))}
        </div>
      )}

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger className={cn(buttonVariants({ size: "sm", variant: "ghost" }))}>
          Avancé
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Input
            placeholder="0 */2 * * *"
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        </CollapsibleContent>
      </Collapsible>

      <div className={cn("text-sm", showInvalid ? "text-destructive" : "text-muted-foreground")}>
        {parsed && <p>{describeSpec(parsed)}</p>}
        {showInvalid ? (
          <p>Cron invalide (ex. « 0 */2 * * * »)</p>
        ) : (
          runs.length > 0 && (
            <ul>
              {runs.map((r, i) => (
                <li key={i}>
                  {formatDateUtc(r)} (UTC)
                </li>
              ))}
            </ul>
          )
        )}
      </div>
    </div>
  );
}
