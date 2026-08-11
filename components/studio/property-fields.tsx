"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// components/studio/property-fields.tsx — Correctif revue finale (Minor) : `FieldRow`,
// `useCommitBuffer` et `NumberField` vivaient dans property-panel.tsx, importées EN RETOUR par
// geometry-strip.tsx (`import { NumberField, type Patch } from "./property-panel"`) — un cycle
// property-panel.tsx -> geometry-strip.tsx -> property-panel.tsx, sans danger réel seulement parce
// que `NumberField` était une déclaration de fonction hissée (voir l'ancien commentaire de
// geometry-strip.tsx), mais un cycle tout de même. Ce fichier est désormais la FEUILLE commune :
// property-panel.tsx et geometry-strip.tsx importent tous deux VERS LE BAS depuis lui, plus aucun
// cycle entre les deux.
export type Patch = (p: Record<string, unknown>) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Primitives de champ — chacune tamponne localement, résout au blur/Entrée, et Échap annule.

export function FieldRow({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-1">
        <Label className="text-xs font-normal text-muted-foreground">{label}</Label>
        {action}
      </div>
      {children}
    </div>
  );
}

export function useCommitBuffer<T>(value: T) {
  const [local, setLocal] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setLocal(value); }, [value, editing]);
  return { local, setLocal, editing, setEditing };
}

// Utilisée par property-panel.tsx (tous les champs numériques hors cadre) ET geometry-strip.tsx
// (les six champs de la bande épinglée, Tâche 6) — la seule primitive de champ dont la bande a
// besoin.
export function NumberField({
  label, value, onCommit, step, min, max, action, dataField,
}: {
  label: string; value: number; onCommit: (v: number) => void;
  step?: number; min?: number; max?: number; action?: ReactNode; dataField?: string;
}) {
  const strValue = Number.isFinite(value) ? String(value) : "0";
  const { local, setLocal, editing, setEditing } = useCommitBuffer(strValue);
  function commit() {
    setEditing(false);
    const n = Number(local);
    if (!Number.isFinite(n)) { setLocal(strValue); return; }
    if (n !== value) onCommit(n);
    else setLocal(strValue);
  }
  return (
    <FieldRow label={label} action={action}>
      <Input
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        value={local}
        data-field={dataField}
        onFocus={() => setEditing(true)}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") { setLocal(strValue); setEditing(false); e.currentTarget.blur(); }
        }}
      />
    </FieldRow>
  );
}
