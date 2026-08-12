"use client";

import { useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";

const PRESETS = [1, 2, 3, 6, 12, 24] as const;
const CUSTOM = "custom";

function presetLabel(hours: number): string {
  return hours === 1 ? "Toutes les heures" : `Toutes les ${hours} heures`;
}

export function IntervalPicker(props: {
  value: number;
  onChange: (hours: number) => void;
  disabled?: boolean;
  id?: string;
}) {
  const { value, onChange, disabled, id } = props;
  const [isCustom, setIsCustom] = useState<boolean>(() => !PRESETS.includes(value as (typeof PRESETS)[number]));

  const selectValue = isCustom ? CUSTOM : String(value);

  function handleSelectChange(next: string | null) {
    if (next === CUSTOM) {
      setIsCustom(true);
      return;
    }
    setIsCustom(false);
    if (next !== null) onChange(Number(next));
  }

  function handleCustomInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const n = Number(e.target.value);
    if (!Number.isFinite(n) || n <= 0) return; // ignore invalid, keep last valid value
    onChange(n);
  }

  return (
    <div className="flex flex-col gap-2">
      <Select value={selectValue} onValueChange={handleSelectChange} disabled={disabled}>
        <SelectTrigger id={id}>
          <SelectValue>
            {(v: string | null) => (v === CUSTOM ? "Personnalisé…" : presetLabel(Number(v ?? value)))}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {PRESETS.map((h) => (
            <SelectItem key={h} value={String(h)}>
              {presetLabel(h)}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM}>Personnalisé…</SelectItem>
        </SelectContent>
      </Select>

      {isCustom && (
        <Input
          type="number"
          min={1}
          value={value}
          disabled={disabled}
          onChange={handleCustomInputChange}
        />
      )}
    </div>
  );
}
