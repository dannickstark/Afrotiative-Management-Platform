# Planification sans syntaxe cron Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remplacer le champ cron brut de `/settings/pipeline` par un sélecteur de mode qui génère l'expression, ancré sur l'heure de Paris, avec l'aperçu des prochaines exécutions et le cron brut conservé derrière un mode avancé.

**Architecture:** Un module pur `lib/pipeline/schedule-expr.ts` traduit dans les deux sens entre une `ScheduleSpec` (quatre modes) et une expression cron, et calcule les prochaines exécutions via croner. Le composant ne manipule jamais autre chose qu'un cron : le champ stocké et l'action de sauvegarde restent inchangés, donc aucune migration.

**Tech Stack:** Next.js 16, React 19, shadcn/ui sur **Base UI**, croner 10, Zod 4, Bun pour les tests.

**Spec:** `docs/superpowers/specs/2026-08-08-afrotiative-schedule-builder-design.md`

## Global Constraints

- **Base UI, pas Radix.** Aucun `asChild` : la composition passe par `render={<Element />}`.
- Toute chaîne visible par l'utilisateur est en **français**.
- Les tests tournent avec `bun test`, sans réseau ni clé d'API.
- **Aucune migration, aucun changement de schéma.** `pipeline_settings.schedule_cron` reste une expression cron ; `updatePipelineSettings` et `pipelineSettingsSchema` sont inchangés.
- `reloadSchedule()` **ne doit jamais lever** : elle est atteinte depuis `instrumentation.register()`, où un rejet fait sortir le processus Next (`handlersError()` → `process.exit(1)`). Ses deux `try/catch` existants (lecture des réglages, analyse du cron) restent en place.
- **Règle d'aller-retour :** une expression que `fromCron` ne reconnaît pas n'est JAMAIS réécrite. Le formulaire s'ouvre en mode avancé avec la chaîne brute intacte.
- Le fichier `AGENTS.md` est réécrit par `next dev` ; s'il apparaît modifié, le committer avec le travail.

⚠️ **Changement de comportement volontaire :** un `0 8 * * *` déjà enregistré se déclenche aujourd'hui à 08:00 **UTC** (Railway tourne en UTC), soit 09:00 ou 10:00 à Paris selon la saison. Après ce sous-projet il se déclenchera à 08:00 **à Paris**. Le décalage prend effet au prochain `reloadSchedule()` — redémarrage ou première sauvegarde des réglages.

---

### Task 1 : Module de traduction des planifications

**Files:**
- Create: `lib/pipeline/schedule-expr.ts`
- Test: `tests/schedule-expr.test.ts` (créer)

**Interfaces:**
- Consumes: `Cron` depuis `croner`
- Produces:
  - `SCHEDULE_TZ = "Europe/Paris"`
  - `type ScheduleSpec = { mode: "off" } | { mode: "everyNHours"; hours: number; minute: number } | { mode: "daily"; time: string } | { mode: "weekdays"; days: number[]; time: string }`
  - `toCron(spec: ScheduleSpec): string`
  - `fromCron(cron: string): ScheduleSpec | null`
  - `nextRuns(cron: string, count?: number, tz?: string): Date[]`
  - `describeSpec(spec: ScheduleSpec): string`
  - `DAY_LABELS: string[]` (index 0 = dimanche, convention cron)

- [ ] **Step 1 : Écrire le test qui échoue**

Créer `tests/schedule-expr.test.ts` :

```ts
import { describe, it, expect } from "bun:test";
import {
  toCron, fromCron, nextRuns, describeSpec, SCHEDULE_TZ,
  type ScheduleSpec,
} from "@/lib/pipeline/schedule-expr";
import { pipelineSettingsSchema } from "@/lib/validation";

describe("toCron", () => {
  it("désactivée → chaîne vide", () => {
    expect(toCron({ mode: "off" })).toBe("");
  });

  it("toutes les N heures", () => {
    expect(toCron({ mode: "everyNHours", hours: 2, minute: 0 })).toBe("0 */2 * * *");
    expect(toCron({ mode: "everyNHours", hours: 6, minute: 30 })).toBe("30 */6 * * *");
  });

  it("chaque jour à une heure fixe", () => {
    expect(toCron({ mode: "daily", time: "08:00" })).toBe("0 8 * * *");
    expect(toCron({ mode: "daily", time: "18:45" })).toBe("45 18 * * *");
  });

  it("jours choisis, triés et dédoublonnés", () => {
    expect(toCron({ mode: "weekdays", days: [1, 2, 3, 4, 5], time: "08:00" }))
      .toBe("0 8 * * 1,2,3,4,5");
    expect(toCron({ mode: "weekdays", days: [5, 1, 1], time: "07:15" }))
      .toBe("15 7 * * 1,5");
  });
});

describe("fromCron", () => {
  it("une chaîne vide est le mode désactivé", () => {
    expect(fromCron("")).toEqual({ mode: "off" });
    expect(fromCron("   ")).toEqual({ mode: "off" });
  });

  it("reconnaît les trois formes générées", () => {
    expect(fromCron("0 */2 * * *")).toEqual({ mode: "everyNHours", hours: 2, minute: 0 });
    expect(fromCron("0 8 * * *")).toEqual({ mode: "daily", time: "08:00" });
    expect(fromCron("0 8 * * 1,2,3,4,5"))
      .toEqual({ mode: "weekdays", days: [1, 2, 3, 4, 5], time: "08:00" });
  });

  it("renvoie null sur une expression valide mais non représentable", () => {
    expect(fromCron("0 8 1 * *")).toBeNull();      // le 1er de chaque mois
    expect(fromCron("*/7 * * * *")).toBeNull();     // toutes les 7 minutes
    expect(fromCron("0 8,20 * * *")).toBeNull();    // deux créneaux fixes
  });

  it("renvoie null sur une expression invalide, sans lever", () => {
    expect(fromCron("n'importe quoi")).toBeNull();
    expect(fromCron("99 99 * * *")).toBeNull();
  });
});

describe("aller-retour", () => {
  const SPECS: ScheduleSpec[] = [
    { mode: "everyNHours", hours: 1, minute: 0 },
    { mode: "everyNHours", hours: 12, minute: 45 },
    { mode: "daily", time: "00:00" },
    { mode: "daily", time: "23:59" },
    { mode: "weekdays", days: [0, 6], time: "10:30" },
    { mode: "weekdays", days: [1, 2, 3, 4, 5], time: "08:00" },
  ];

  it("fromCron(toCron(spec)) redonne la spec", () => {
    for (const spec of SPECS) expect(fromCron(toCron(spec))).toEqual(spec);
  });

  it("toCron(fromCron(c)) redonne c pour toute expression reconnue", () => {
    for (const c of ["0 */2 * * *", "30 */6 * * *", "0 8 * * *", "45 18 * * *", "0 8 * * 1,2,3,4,5"]) {
      expect(toCron(fromCron(c)!)).toBe(c);
    }
  });

  it("toute sortie non vide de toCron satisfait pipelineSettingsSchema", () => {
    for (const spec of SPECS) {
      const r = pipelineSettingsSchema.safeParse({
        maxItemsPerRun: 10, perOperationTimeoutMs: 30000, clusterThreshold: 0.8,
        scoreThreshold: 70, autoPublishEnabled: false, autoPublishMinSources: 2,
        webSearchEnabled: false, scheduleCron: toCron(spec),
        alertEmailEnabled: false, alertEmailRecipients: "", defaultMaxItemAgeHours: null,
      });
      expect(r.success).toBe(true);
    }
  });
});

describe("nextRuns", () => {
  it("une chaîne vide ne produit aucune exécution", () => {
    expect(nextRuns("")).toEqual([]);
  });

  it("une expression invalide ne produit aucune exécution, sans lever", () => {
    expect(nextRuns("pas un cron")).toEqual([]);
  });

  it("produit des instants strictement croissants", () => {
    const runs = nextRuns("0 */2 * * *", 4);
    expect(runs).toHaveLength(4);
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i].getTime()).toBeGreaterThan(runs[i - 1].getTime());
    }
  });

  it("« 08:00 » signifie 8 h à Paris, en heure d'été comme en heure d'hiver", () => {
    const parisHour = (d: Date) =>
      new Intl.DateTimeFormat("fr-FR", { timeZone: SCHEDULE_TZ, hour: "2-digit", minute: "2-digit" })
        .format(d);
    // 20 exécutions couvrent largement plus de trois semaines ; on vérifie que TOUTES tombent
    // à 08:00 heure de Paris, ce qui échouerait si le fuseau n'était pas appliqué.
    for (const d of nextRuns("0 8 * * *", 20)) expect(parisHour(d)).toBe("08:00");
  });

  it("le mode « jours choisis » ne produit que les jours demandés", () => {
    const parisDay = (d: Date) =>
      new Intl.DateTimeFormat("en-US", { timeZone: SCHEDULE_TZ, weekday: "short" }).format(d);
    for (const d of nextRuns("0 8 * * 1,2,3,4,5", 10)) {
      expect(["Sat", "Sun"]).not.toContain(parisDay(d));
    }
  });
});

describe("describeSpec", () => {
  it("rend une phrase française pour chaque mode", () => {
    expect(describeSpec({ mode: "off" })).toBe("Aucune planification");
    expect(describeSpec({ mode: "everyNHours", hours: 1, minute: 0 })).toBe("Toutes les heures");
    expect(describeSpec({ mode: "everyNHours", hours: 3, minute: 0 })).toBe("Toutes les 3 heures");
    expect(describeSpec({ mode: "daily", time: "08:00" })).toBe("Chaque jour à 08:00");
    expect(describeSpec({ mode: "weekdays", days: [1, 5], time: "08:00" }))
      .toBe("lundi, vendredi à 08:00");
  });
});
```

- [ ] **Step 2 : Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/schedule-expr.test.ts`
Expected: FAIL — `Cannot find module '@/lib/pipeline/schedule-expr'`.

- [ ] **Step 3 : Créer `lib/pipeline/schedule-expr.ts`**

```ts
import { Cron } from "croner";

// Fuseau de référence de TOUTE planification de l'application. Déclaré ICI, dans le module pur,
// et importé par lib/pipeline/scheduler.ts — jamais l'inverse : scheduler.ts déclenche de vraies
// exécutions et importe dynamiquement ./run et ./overlap, il n'est donc pas chargeable dans un
// test unitaire.
export const SCHEDULE_TZ = "Europe/Paris";

// Index 0 = dimanche : convention du champ « jour de la semaine » de cron, conservée telle
// quelle pour qu'aucune conversion ne soit nécessaire entre l'interface et l'expression.
export const DAY_LABELS = [
  "dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi",
];

export type ScheduleSpec =
  | { mode: "off" }
  | { mode: "everyNHours"; hours: number; minute: number }
  | { mode: "daily"; time: string }        // "HH:MM"
  | { mode: "weekdays"; days: number[]; time: string };

function splitTime(time: string): [number, number] {
  const [h, m] = time.split(":");
  return [Number(h), Number(m)];
}

function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeDays(days: number[]): number[] {
  return [...new Set(days)].sort((a, b) => a - b);
}

/** PUR — une spec → son expression cron. Le mode « off » donne la chaîne vide (= pas de job). */
export function toCron(spec: ScheduleSpec): string {
  switch (spec.mode) {
    case "off":
      return "";
    case "everyNHours":
      return `${spec.minute} */${spec.hours} * * *`;
    case "daily": {
      const [h, m] = splitTime(spec.time);
      return `${m} ${h} * * *`;
    }
    case "weekdays": {
      const [h, m] = splitTime(spec.time);
      return `${m} ${h} * * ${normalizeDays(spec.days).join(",")}`;
    }
  }
}

// Les trois formes que toCron sait produire. Volontairement STRICTES : tout ce qui n'est pas
// exactement l'une d'elles renvoie null, et le formulaire bascule alors en mode avancé avec
// l'expression intacte. Une reconnaissance approximative serait pire que pas de reconnaissance
// du tout — elle réécrirait silencieusement le cron d'un opérateur.
const EVERY_N_HOURS = /^(\d{1,2}) \*\/(\d{1,2}) \* \* \*$/;
const DAILY = /^(\d{1,2}) (\d{1,2}) \* \* \*$/;
const WEEKDAYS = /^(\d{1,2}) (\d{1,2}) \* \* (\d(?:,\d)*)$/;

/** PUR — une expression cron → sa spec, ou `null` si elle n'est pas représentable. Ne lève jamais. */
export function fromCron(cron: string): ScheduleSpec | null {
  const c = cron.trim();
  if (!c) return { mode: "off" };

  let m = c.match(EVERY_N_HOURS);
  if (m) {
    const minute = Number(m[1]);
    const hours = Number(m[2]);
    if (minute > 59 || hours < 1 || hours > 23) return null;
    return { mode: "everyNHours", hours, minute };
  }

  m = c.match(DAILY);
  if (m) {
    const minute = Number(m[1]);
    const hour = Number(m[2]);
    if (minute > 59 || hour > 23) return null;
    return { mode: "daily", time: formatTime(hour, minute) };
  }

  m = c.match(WEEKDAYS);
  if (m) {
    const minute = Number(m[1]);
    const hour = Number(m[2]);
    const days = m[3].split(",").map(Number);
    if (minute > 59 || hour > 23 || days.some((d) => d > 6)) return null;
    return { mode: "weekdays", days: normalizeDays(days), time: formatTime(hour, minute) };
  }

  return null;
}

/**
 * Les `count` prochaines exécutions d'une expression, dans le fuseau de référence.
 * `paused: true` construit le job uniquement pour son analyseur, sans démarrer de minuterie.
 * Renvoie un tableau vide sur expression vide ou invalide — l'aperçu ne doit jamais casser la
 * page pendant qu'on tape dans le champ du mode avancé.
 */
export function nextRuns(cron: string, count = 3, tz: string = SCHEDULE_TZ): Date[] {
  const c = cron.trim();
  if (!c) return [];
  try {
    return new Cron(c, { timezone: tz, paused: true }).nextRuns(count);
  } catch {
    return [];
  }
}

/** PUR — phrase française résumant une spec. */
export function describeSpec(spec: ScheduleSpec): string {
  switch (spec.mode) {
    case "off":
      return "Aucune planification";
    case "everyNHours":
      return spec.hours === 1 ? "Toutes les heures" : `Toutes les ${spec.hours} heures`;
    case "daily":
      return `Chaque jour à ${spec.time}`;
    case "weekdays":
      return `${normalizeDays(spec.days).map((d) => DAY_LABELS[d]).join(", ")} à ${spec.time}`;
  }
}
```

- [ ] **Step 4 : Lancer le test pour vérifier qu'il passe**

Run: `bun test tests/schedule-expr.test.ts`
Expected: PASS — 18 tests.

- [ ] **Step 5 : Commit**

```bash
git add lib/pipeline/schedule-expr.ts tests/schedule-expr.test.ts
git commit -m "feat(schedule): pure cron <-> spec translation + next-runs preview (Europe/Paris)"
```

---

### Task 2 : Ancrer le planificateur sur l'heure de Paris

**Files:**
- Modify: `lib/pipeline/scheduler.ts:56-66`
- Test: `tests/pipeline-scheduler.test.ts` (étendre)

**Interfaces:**
- Consumes: `SCHEDULE_TZ` (Task 1)

- [ ] **Step 1 : Écrire les tests qui échouent**

Ajouter à `tests/pipeline-scheduler.test.ts` :

```ts
import { SCHEDULE_TZ } from "@/lib/pipeline/schedule-expr";

describe("fuseau de planification", () => {
  it("le job est construit sur le fuseau de référence", async () => {
    await setScheduleCron("0 8 * * *"); // assistant déjà utilisé dans ce fichier
    await reloadSchedule();
    const job = getScheduledJob();
    expect(job).not.toBeNull();
    const next = job!.nextRun()!;
    const parisHour = new Intl.DateTimeFormat("fr-FR", {
      timeZone: SCHEDULE_TZ, hour: "2-digit", minute: "2-digit",
    }).format(next);
    expect(parisHour).toBe("08:00");
  });

  it("un cron invalide laisse la planification désactivée sans lever", async () => {
    await setScheduleCron("pas un cron");
    await expect(reloadSchedule()).resolves.toBeUndefined();
    expect(getScheduledJob()).toBeNull();
  });

  it("une planification vide désactive le job", async () => {
    await setScheduleCron("");
    await reloadSchedule();
    expect(getScheduledJob()).toBeNull();
  });
});
```

Si `tests/pipeline-scheduler.test.ts` n'a pas d'assistant `setScheduleCron`, l'écrire : un
`db.update(pipelineSettings).set({ scheduleCron })` sur la ligne singleton, avec restauration de
la valeur d'origine en `afterAll`.

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

Run: `bun test tests/pipeline-scheduler.test.ts`
Expected: FAIL sur le premier test — sans option `timezone`, croner interprète en heure serveur
(UTC en CI/Railway), la vérification « 08:00 à Paris » échoue.

- [ ] **Step 3 : Appliquer le fuseau**

Dans `lib/pipeline/scheduler.ts` :

a) ajouter l'import : `import { SCHEDULE_TZ } from "./schedule-expr";`

b) remplacer la construction du job (l. 62-63) :

```ts
    // timezone — TOUTE planification est exprimée en heure de Paris, quel que soit le fuseau du
    // serveur (Railway tourne en UTC). Sans cette option, « 08:00 » signifierait 08:00 UTC, soit
    // 09:00 ou 10:00 à Paris selon la saison — un décalage que l'utilisateur ne peut pas deviner.
    // protect: true — croner ignore une nouvelle salve tant que la précédente tourne (bretelle) ;
    // hasRunningRun() dans triggerScheduledRun est le garde-fou côté base (ceinture).
    // catch: true — croner absorbe et journalise ce que triggerScheduledRun pourrait encore
    // laisser passer, pour qu'une salve en échec ne puisse jamais tuer la minuterie.
    job = new Cron(scheduleCron, { timezone: SCHEDULE_TZ, protect: true, catch: true }, triggerScheduledRun);
    console.log(
      `[scheduler] planification active: ${scheduleCron} (${SCHEDULE_TZ}) — prochaine: ${job.nextRun()?.toISOString()}`,
    );
```

Les deux `try/catch` de `reloadSchedule` restent strictement en place : cette fonction est
atteinte depuis `instrumentation.register()`, où un rejet ferait sortir le processus.

- [ ] **Step 4 : Lancer les tests pour vérifier qu'ils passent**

Run: `bun test tests/pipeline-scheduler.test.ts`
Expected: PASS.

- [ ] **Step 5 : Commit**

```bash
git add lib/pipeline/scheduler.ts tests/pipeline-scheduler.test.ts
git commit -m "feat(schedule): anchor the scheduler on Europe/Paris"
```

---

### Task 3 : Le sélecteur de planification

**Files:**
- Create: `components/settings/schedule-field.tsx`
- Modify: `components/settings/pipeline-settings-form.tsx:190-206`

**Interfaces:**
- Consumes: `toCron`, `fromCron`, `nextRuns`, `DAY_LABELS`, `SCHEDULE_TZ`, `ScheduleSpec` (Task 1)
- Produces: `ScheduleField({ value, onChange, disabled })` — contrôlé, ne parle que cron

- [ ] **Step 1 : Créer `components/settings/schedule-field.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  toCron, fromCron, nextRuns, describeSpec, DAY_LABELS, SCHEDULE_TZ, type ScheduleSpec,
} from "@/lib/pipeline/schedule-expr";

type Mode = ScheduleSpec["mode"];
const MODES: { value: Mode; label: string }[] = [
  { value: "off", label: "Désactivée" },
  { value: "everyNHours", label: "Toutes les N heures" },
  { value: "daily", label: "Chaque jour à une heure fixe" },
  { value: "weekdays", label: "Les jours choisis à une heure fixe" },
];

const HOUR_CHOICES = [1, 2, 3, 4, 6, 8, 12];

// Les prochaines exécutions sont des instants absolus : elles DOIVENT être rendues dans le
// fuseau de référence, sinon un utilisateur hors de France lirait une heure qui ne correspond
// pas à ce qu'il vient de régler. lib/format.ts#formatDate n'impose pas de fuseau, d'où ce
// formateur local.
const PARIS_FORMAT = new Intl.DateTimeFormat("fr-FR", {
  timeZone: SCHEDULE_TZ, dateStyle: "medium", timeStyle: "short",
});

export function ScheduleField({
  value, onChange, disabled,
}: {
  value: string;
  onChange: (cron: string) => void;
  disabled?: boolean;
}) {
  // À l'ouverture, on tente de reconnaître le cron stocké. `null` = expression écrite à la main
  // et non représentable : on ouvre alors le mode avancé sans TOUCHER à la chaîne. La réécrire
  // en un mode approchant serait la pire des trahisons pour un opérateur.
  const initial = fromCron(value);
  const [spec, setSpec] = useState<ScheduleSpec>(initial ?? { mode: "off" });
  const [advancedOpen, setAdvancedOpen] = useState(initial === null);
  const [raw, setRaw] = useState(value);

  // Resynchronise si la valeur change depuis l'extérieur (rechargement des réglages).
  useEffect(() => { setRaw(value); }, [value]);

  function applySpec(next: ScheduleSpec) {
    setSpec(next);
    const cron = toCron(next);
    setRaw(cron);
    onChange(cron);
  }

  function changeMode(mode: Mode) {
    // Valeurs de départ raisonnables à chaque bascule de mode — jamais un formulaire vide.
    switch (mode) {
      case "off": return applySpec({ mode: "off" });
      case "everyNHours": return applySpec({ mode: "everyNHours", hours: 2, minute: 0 });
      case "daily": return applySpec({ mode: "daily", time: "08:00" });
      case "weekdays": return applySpec({ mode: "weekdays", days: [1, 2, 3, 4, 5], time: "08:00" });
    }
  }

  function toggleDay(day: number) {
    if (spec.mode !== "weekdays") return;
    const days = spec.days.includes(day)
      ? spec.days.filter((d) => d !== day)
      : [...spec.days, day];
    // Au moins un jour, sinon l'expression produite serait invalide.
    if (days.length === 0) return;
    applySpec({ ...spec, days });
  }

  const preview = nextRuns(raw, 3);
  const invalid = raw.trim().length > 0 && preview.length === 0;

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="schedule-mode">Fréquence</Label>
        <Select value={spec.mode} onValueChange={(v) => changeMode(v as Mode)} disabled={disabled}>
          <SelectTrigger id="schedule-mode" className="w-72">
            <SelectValue placeholder="Fréquence">
              {(v: string) => MODES.find((m) => m.value === v)?.label ?? "Fréquence"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {MODES.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {spec.mode === "everyNHours" && (
        <div className="space-y-1.5">
          <Label htmlFor="schedule-hours">Intervalle</Label>
          <Select
            value={String(spec.hours)} disabled={disabled}
            onValueChange={(v) => applySpec({ ...spec, hours: Number(v) })}
          >
            <SelectTrigger id="schedule-hours" className="w-40">
              <SelectValue>{(v: string) => `Toutes les ${v} h`}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {HOUR_CHOICES.map((h) => <SelectItem key={h} value={String(h)}>{`Toutes les ${h} h`}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}

      {(spec.mode === "daily" || spec.mode === "weekdays") && (
        <div className="space-y-1.5">
          <Label htmlFor="schedule-time">Heure (heure de Paris)</Label>
          <Input
            id="schedule-time" type="time" className="w-40" disabled={disabled}
            value={spec.time}
            onChange={(e) => e.target.value && applySpec({ ...spec, time: e.target.value })}
          />
        </div>
      )}

      {spec.mode === "weekdays" && (
        <div className="space-y-1.5">
          <Label>Jours</Label>
          <div className="flex flex-wrap gap-1.5">
            {/* Lundi → dimanche à l'affichage (ordre français), tout en gardant les index cron. */}
            {[1, 2, 3, 4, 5, 6, 0].map((day) => {
              const on = spec.days.includes(day);
              return (
                <button
                  key={day} type="button" disabled={disabled}
                  onClick={() => toggleDay(day)}
                  aria-pressed={on}
                  className={`rounded-md border px-2.5 py-1 text-sm capitalize ${
                    on ? "border-transparent bg-[var(--accent-brand)] text-[var(--accent-brand-foreground)]"
                       : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {DAY_LABELS[day].slice(0, 3)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
        {spec.mode === "off" && !raw.trim() ? (
          <span className="text-muted-foreground">Aucune planification — le pipeline ne se déclenchera qu'à la demande.</span>
        ) : invalid ? (
          <span className="text-destructive">Expression cron invalide.</span>
        ) : (
          <>
            <span className="text-muted-foreground">Prochaines exécutions : </span>
            {preview.map((d) => PARIS_FORMAT.format(d)).join(" · ")}
          </>
        )}
      </div>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger
          render={
            <button type="button" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" />
          }
        >
          <ChevronRight className="size-4 transition-transform duration-200 group-data-open:rotate-90" />
          Mode avancé (cron)
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-1.5 pt-2">
            <Label htmlFor="schedule-cron">Expression cron</Label>
            <Input
              id="schedule-cron" disabled={disabled} value={raw} placeholder="0 */2 * * *"
              onChange={(e) => {
                const next = e.target.value;
                setRaw(next);
                onChange(next);
                // Si la saisie manuelle retombe sur une forme reconnue, les contrôles ci-dessus
                // se resynchronisent ; sinon on laisse la spec telle quelle et seul le champ
                // brut fait foi.
                const parsed = fromCron(next);
                if (parsed) setSpec(parsed);
              }}
            />
            {/* Le résumé n'est affiché que si l'expression courante est effectivement
                représentable : sur un cron écrit à la main, `spec` est resté sur sa valeur
                précédente et le décrire induirait en erreur. */}
            <p className="text-xs text-muted-foreground">
              Interprétée en heure de Paris.{fromCron(raw) ? ` ${describeSpec(spec)}` : ""}
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
```

- [ ] **Step 2 : Vérifier la composition Base UI du `CollapsibleTrigger`**

Run: `bun run dev` puis ouvrir `/settings/pipeline`
Expected: le lien « Mode avancé (cron) » se replie/déplie. Si le chevron ne pivote pas, c'est que
la classe `group-data-open` n'a pas de groupe parent — ajouter `className="group"` sur le
`<Collapsible>`. Ne PAS modifier `components/ui/collapsible.tsx`.

- [ ] **Step 3 : Remplacer la carte « Planification »**

Dans `components/settings/pipeline-settings-form.tsx`, remplacer le `CardContent` de la carte
« Planification » (l. 195-205) par :

```tsx
        <CardContent>
          <ScheduleField
            value={form.scheduleCron}
            onChange={(cron) => setForm((f) => ({ ...f, scheduleCron: cron }))}
            disabled={isSaving}
          />
        </CardContent>
```

et la `CardDescription` par :

```tsx
          <CardDescription>
            Déclenche automatiquement le pipeline. Les heures sont exprimées en heure de Paris,
            quel que soit le fuseau du serveur.
          </CardDescription>
```

Import à ajouter : `import { ScheduleField } from "./schedule-field";`.

L'état `form.scheduleCron` et `handleSave` sont **inchangés** — le composant ne produit qu'un
cron, donc `pipelineSettingsSchema` le valide exactement comme avant.

- [ ] **Step 4 : Vérifier**

Run: `bun run typecheck && bun test`
Expected: aucune erreur ; suite verte.

- [ ] **Step 5 : Vérification manuelle du parcours**

Run: `bun run dev` → `/settings/pipeline` en admin.
1. Choisir « Toutes les N heures » = 2 → aperçu à intervalles de 2 h ; enregistrer.
2. Recharger la page → le mode « Toutes les N heures » est bien resélectionné (aller-retour).
3. Choisir « Les jours choisis », décocher samedi et dimanche, régler 08:00 → l'aperçu ne montre
   que des jours de semaine à 08:00.
4. Ouvrir le mode avancé, saisir `0 8 1 * *` (le 1er de chaque mois) et enregistrer ; recharger →
   le mode avancé est ouvert avec l'expression **intacte**, non réécrite.
5. Saisir `zzz` → l'aperçu affiche « Expression cron invalide » et l'enregistrement est refusé
   par la validation serveur.

- [ ] **Step 6 : Commit**

```bash
git add components/settings/schedule-field.tsx components/settings/pipeline-settings-form.tsx
git commit -m "feat(settings): mode-based schedule builder with next-runs preview + advanced cron"
```

---

## Vérification finale du sous-projet

- [ ] `bun run typecheck` — aucune erreur
- [ ] `bun test` — suite complète verte
- [ ] `bun run build` — build de production réussi
- [ ] Au démarrage, le journal affiche `[scheduler] planification active: … (Europe/Paris) — prochaine: …`
- [ ] Une expression cron écrite à la main survit à un aller-retour dans le formulaire sans être
      modifiée
