import type { RunParams } from "@/db";
import type { RunParamsInput } from "@/lib/validation";

export type RunParamDefaults = { defaultMaxItemAgeHours: number | null; maxItemsPerRun: number };

const HOUR_MS = 3_600_000;

// Resolve a validated (or absent) trigger input against the settings defaults + an injected `now`
// into the RunParams that gets persisted on the run row. Pure: `now` is a parameter, never Date.now().
export function resolveRunParams(
  input: RunParamsInput | undefined,
  defaults: RunParamDefaults,
  now: Date,
): RunParams {
  return {
    recency: resolveRecency(input?.recency, defaults.defaultMaxItemAgeHours, now),
    feedIds: input?.feedIds ?? null,
    maxItems: input?.maxItems ?? defaults.maxItemsPerRun,
  };
}

function resolveRecency(
  input: RunParamsInput["recency"],
  defaultHours: number | null,
  now: Date,
): RunParams["recency"] {
  if (input) {
    if (input.kind === "age") return { kind: "age", hours: input.hours, cutoffAt: new Date(now.getTime() - input.hours * HOUR_MS).toISOString() };
    if (input.kind === "since") return { kind: "since", cutoffAt: input.at };
    return { kind: "none" };
  }
  if (defaultHours == null) return { kind: "none" };
  return { kind: "age", hours: defaultHours, cutoffAt: new Date(now.getTime() - defaultHours * HOUR_MS).toISOString() };
}

// The absolute instant the phase-1 filter compares against (null = no cutoff).
export function cutoffDate(params: RunParams): Date | null {
  return params.recency.kind === "none" ? null : new Date(params.recency.cutoffAt);
}
