"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// components/studio/property-fields.tsx — Correctif revue finale (Minor) : `FieldRow`,
// `useCommitBuffer` et `NumberField` vivaient dans property-panel.tsx, importées EN RETOUR par
// geometry-strip.tsx (`import { NumberField, type Patch } from "./property-panel"`) — un cycle
// property-panel.tsx -> geometry-strip.tsx -> property-panel.tsx, sans danger réel seulement parce
// que `NumberField` était une déclaration de fonction hissée (voir l'ancien commentaire de
// geometry-strip.tsx), mais un cycle tout de même. Ce fichier est désormais la FEUILLE commune :
// property-panel.tsx et geometry-strip.tsx importent tous deux VERS LE BAS depuis lui, plus aucun
// cycle entre les deux.
//
// Chantier D, Tâche 4 (revue, Important 1) : `SelectField` a rejoint cette feuille pour la MÊME
// raison — components/studio/constraints-field.tsx (le widget de contraintes, monté par
// geometry-strip.tsx) en avait besoin lui aussi, et une seconde copie verbatim y avait été écrite
// plutôt que de rouvrir un cycle. `SelectField` n'a AUCUNE dépendance propre à property-panel.tsx
// (seulement `FieldRow`, déjà ici, et `Select*` de Base UI) — exactement la forme de code que ce
// fichier existe pour accueillir. `constraints-field.tsx` et property-panel.tsx importent
// désormais tous deux `SelectField` VERS LE BAS depuis ici ; la copie locale des deux a disparu.
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
  label, value, onCommit, step, min, max, action, dataField, disabled,
}: {
  label: string; value: number; onCommit: (v: number) => void;
  step?: number; min?: number; max?: number; action?: ReactNode; dataField?: string;
  /** U3 Tâche 3 : un champ dont l'édition n'aurait AUCUN effet (la rotation d'une forme découpée,
   * arbitrage A) est grisé plutôt que silencieusement inerte — l'appelant DOIT alors afficher une
   * note qui dit pourquoi, sur le modèle de `snap-rotation-note` / `safe-areas-none` (U2). */
  disabled?: boolean;
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
        disabled={disabled}
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

// Déplacé depuis property-panel.tsx (Chantier D, Tâche 4, revue Important 1) — voir le commentaire
// d'en-tête de ce fichier. Comportement INCHANGÉ bit à bit : seul l'emplacement a bougé.
export function SelectField({
  label, value, options, onCommit, placeholder, optionDataAttr, hint, dataField,
}: {
  label: string;
  value: string;
  /** Tâche 5 (U4), additif : `disabled` marque une option ILLÉGALE dans ce contexte plutôt que de la
   * faire disparaître de la liste (ImageFields/QrFields, property-panel.tsx), jamais utilisé par les
   * autres appelants (alignement, graisse, forme, contraintes…), qui n'ont pas de notion de légalité. */
  options: { value: string; label: string; disabled?: boolean }[];
  onCommit: (v: string) => void;
  placeholder?: string;
  /** U3 Tâche 3 : pose `<attr>="<valeur d'option>"` sur chaque option, pour qu'un test puisse COMPTER
   * les options rendues au lieu de se contenter de chercher leurs libellés dans tout le HTML (un
   * sélecteur qui rendrait deux fois la même option passerait une simple recherche de sous-chaîne). */
  optionDataAttr?: string;
  /** Tâche 5 (U4), additif : ligne d'aide sous le contrôle — ImageFields/QrFields y posent la raison
   * (« … n'est pas disponible dans ce contexte. ») quand la valeur COURANTE est une option grisée,
   * même idiome que `RadiusField`/`shape-radius-help` (property-panel.tsx). */
  hint?: string;
  /** Tâche 5 (U4), additif : pose `data-field` sur LE DÉCLENCHEUR — même convention que
   * `TextField`/`ColorField` (dataField), pour qu'un test DOM cible sans ambiguïté CE sélecteur
   * précis quand le panneau en affiche plusieurs (« Ajustement » ET « Emplacement » sur un calque
   * image, par exemple, ou « Horizontal » ET « Vertical » sur le widget de contraintes) plutôt que
   * d'indexer sur l'ORDRE de rendu — fragile au moindre remaniement. */
  dataField?: string;
}) {
  return (
    <FieldRow label={label}>
      <Select value={value} onValueChange={(v) => { if (v) onCommit(v); }}>
        <SelectTrigger className="w-full" data-field={dataField}>
          {/* Base UI's <SelectValue> ne dérive PAS automatiquement le libellé du <SelectItem>
              correspondant (contrairement à un <select> natif) — repéré en vérifiant l'écran réel
              dans un navigateur : sans ce mappeur explicite, chaque sélecteur qui l'utilise
              (alignement, graisse de police, ajustement d'image, contraintes H/V…) affichait sa
              valeur technique brute ("left", "700"…) au lieu de son libellé français — même piège
              déjà corrigé dans components/studio/preview-pane.tsx, voir sa note. */}
          <SelectValue placeholder={placeholder ?? "Choisir…"}>
            {(v: string | null) => options.find((o) => o.value === v)?.label ?? placeholder ?? "Choisir…"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem
              key={o.value} value={o.value} disabled={o.disabled}
              {...(optionDataAttr ? { [optionDataAttr]: o.value } : {})}
            >
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </FieldRow>
  );
}
