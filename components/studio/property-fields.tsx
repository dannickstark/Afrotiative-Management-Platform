"use client";

import { useEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
// Chantier C, Tâche 3 : `scrubValue`/`ScrubModifier` (Tâche 2, lib/studio/field-scrub.ts) sont les
// SEULES maths de balayage — ce fichier ne recalcule rien, il relaie `dxPx`/Maj/Alt bruts d'un VRAI
// `PointerEvent` DOM à la fonction pure et affiche son résultat dans le tampon local existant.
// Tâche 5 : `sliderValue`/`valueToFraction` sont, de la même façon, les SEULES maths de curseur borné
// — `SliderField` (plus bas) ne recalcule jamais lui-même un arrondi au step ni un clamp min/max, il
// les demande à ces deux fonctions pures pour que le résultat COMMITTÉ soit indépendant de l'arrondi
// interne (potentiellement différent) du composant Base UI sous-jacent.
import { scrubValue, sliderValue, valueToFraction, type ScrubModifier } from "@/lib/studio/field-scrub";

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

export function FieldRow({
  label, action, children, labelProps,
}: {
  label: string; action?: ReactNode; children: ReactNode;
  /** Chantier C, Tâche 3 (additif) : porte des gestionnaires (pointeur/clavier) et une classe sur le
   * `<Label>` rendu ici, pour que `NumberField` puisse en faire une poignée de balayage SANS que
   * `FieldRow` connaisse quoi que ce soit du balayage — il relaie seulement des props génériques.
   * Optionnel : `TextField`/`ColorField`/`SelectField` (et tout futur appelant) n'en passent aucune et
   * gardent un `<Label>` nu, comportement bit à bit inchangé. `className` est FUSIONNÉE (jamais
   * remplacée) avec la classe existante — un appelant ne peut donc pas effacer accidentellement
   * `text-xs font-normal text-muted-foreground`. */
  labelProps?: HTMLAttributes<HTMLLabelElement>;
}) {
  const { className: labelClassName, ...restLabelProps } = labelProps ?? {};
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-1">
        <Label className={cn("text-xs font-normal text-muted-foreground", labelClassName)} {...restLabelProps}>
          {label}
        </Label>
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
  const inputRef = useRef<HTMLInputElement>(null);
  function commit() {
    setEditing(false);
    const n = Number(local);
    if (!Number.isFinite(n)) { setLocal(strValue); return; }
    if (n !== value) onCommit(n);
    else setLocal(strValue);
  }

  // Chantier C, Tâche 3 — le label devient une poignée de balayage (Figma/After Effects) : glisser
  // dessus change la valeur sans passer par le clavier. `scrub` (une ref, pas un state — son
  // changement ne doit PAS provoquer de rendu à lui seul) mémorise le point de départ du geste EN
  // COURS ; `null` signifie « aucun geste en cours », lu par les trois gestionnaires ci-dessous pour
  // ignorer un `pointermove`/`pointerup` orphelin (ex. un `pointerup` qui suit un `pointerdown` sur un
  // AUTRE champ, capture de pointeur oblige ce n'est normalement pas observable, mais la garde ne
  // coûte rien). Le SEUIL de 3px (§0, épinglé par un test de mutation) distingue un clic-pour-taper
  // d'un glisser réel — sans lui, tout clic sur l'étiquette committrait une valeur non voulue au lieu
  // de laisser passer le focus à l'`<input>`.
  const scrub = useRef<{ startX: number; startValue: number } | null>(null);
  const MOVE_THRESHOLD_PX = 3;

  function modifierOf(e: { shiftKey: boolean; altKey: boolean }): ScrubModifier {
    return e.shiftKey ? "shift" : e.altKey ? "alt" : "none";
  }

  function onLabelPointerDown(e: PointerEvent<HTMLLabelElement>) {
    if (disabled) return;
    // jsdom ne fournit pas `setPointerCapture` sur les éléments (voir tests/dom-harness.ts#pointer) —
    // l'appel optionnel se contourne lui-même en test, et capture réellement le pointeur en navigateur
    // pour que le geste continue de recevoir des `pointermove` même si le curseur quitte l'étiquette.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    document.body.style.cursor = "ew-resize";
    scrub.current = { startX: e.clientX, startValue: value };
  }

  function onLabelPointerMove(e: PointerEvent<HTMLLabelElement>) {
    if (!scrub.current) return;
    const v = scrubValue(scrub.current.startValue, e.clientX - scrub.current.startX, {
      step, min, max, modifier: modifierOf(e),
    });
    // Le tampon d'AFFICHAGE local uniquement — jamais `onCommit` ici : un `pointermove` tire à chaque
    // pixel, et `onCommit` -> `patch` -> `setLayerProp` pousse UNE entrée d'historique par appel (§0).
    // En pousser une par mouvement rendrait ⌘Z inutilisable après un seul geste de balayage.
    setEditing(true);
    setLocal(String(v));
  }

  function onLabelPointerUp(e: PointerEvent<HTMLLabelElement>) {
    if (!scrub.current) return;
    const dxPx = e.clientX - scrub.current.startX;
    const moved = Math.abs(dxPx) >= MOVE_THRESHOLD_PX;
    const v = scrubValue(scrub.current.startValue, dxPx, { step, min, max, modifier: modifierOf(e) });
    scrub.current = null;
    document.body.style.cursor = "";
    setEditing(false);
    if (moved) {
      // UNE SEULE entrée d'historique par geste : `onCommit` n'est appelé qu'ICI, au relâchement —
      // jamais pendant `onLabelPointerMove`. Le mutant « supprimer ce garde-fou de seuil » (§0) est
      // épinglé par tests/studio-scrub-field.test.ts : appeler `onCommit` pendant les `pointermove`
      // ferait rougir l'assertion « appelé UNE fois ».
      if (v !== value) onCommit(v);
      else setLocal(strValue);
    } else {
      // Pas de mouvement franchissant le seuil : un CLIC, pas un glisser. Ne rien committer (aucune
      // valeur n'a réellement changé sous le doigt de l'utilisateur) et laisser le focus tomber dans
      // l'`<input>` — le clic-pour-taper reste possible depuis l'étiquette.
      setLocal(strValue);
      inputRef.current?.focus();
    }
  }

  function onLabelPointerCancel() {
    if (!scrub.current) return;
    scrub.current = null;
    document.body.style.cursor = "";
    setLocal(strValue);
    setEditing(false);
  }

  function onLabelKeyDown(e: KeyboardEvent<HTMLLabelElement>) {
    // Échap PENDANT le glisser annule : revient à la valeur de départ, aucun commit. Le clavier de
    // l'`<input>` lui-même (flèches, Entrée, Échap, blur -> commit) est un chemin ENTIÈREMENT séparé,
    // inchangé plus bas.
    if (e.key === "Escape" && scrub.current) {
      scrub.current = null;
      document.body.style.cursor = "";
      setLocal(strValue);
      setEditing(false);
    }
  }

  return (
    <FieldRow
      label={label}
      action={action}
      labelProps={{
        className: "cursor-ew-resize select-none",
        "data-scrub": "true",
        onPointerDown: onLabelPointerDown,
        onPointerMove: onLabelPointerMove,
        onPointerUp: onLabelPointerUp,
        onPointerCancel: onLabelPointerCancel,
        onKeyDown: onLabelKeyDown,
      } as HTMLAttributes<HTMLLabelElement>}
    >
      <Input
        ref={inputRef}
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

// Chantier C, Tâche 5 — `SliderField` : un curseur Base UI (components/ui/slider.tsx) COUPLÉ à un
// `<input>` numérique synchronisé, sur le modèle de `NumberField` ci-dessus (même tampon local via
// `useCommitBuffer`, même résolution au blur/Entrée, même Échap qui annule) — pour un champ dont les
// bornes min/max ont un sens VISUEL (opacité, flou, interligne…), là où `NumberField` reste préférable
// pour un champ non borné (X, Y…) ou dont le glisser-étiquette suffit.
//
// UNE SEULE entrée d'historique par glisser (§0, mêmes enjeux que le glisser-étiquette de
// `NumberField`) : Base UI expose DEUX callbacks sur `Slider.Root` — `onValueChange` (tire à CHAQUE
// `pointermove` pendant le glisser, purement local ici) et `onValueCommitted` (tire UNE fois, au
// relâchement — vérifié dans node_modules/@base-ui/react/slider/control/SliderControl.js :
// `handleTouchEnd` n'appelle `onValueCommitted` qu'UNE fois, avec la DERNIÈRE valeur retenue pendant
// le glisser). `onCommit` (la prop de CE composant, qui pousse une entrée d'historique via
// `patch`/`setLayerProp`) n'est donc jamais câblé sur `onValueChange` — seulement sur
// `onValueCommitted`, exactement comme `NumberField` ne committe jamais pendant `onLabelPointerMove`.
//
// La valeur COMMITTÉE par un GLISSER ne fait jamais confiance à l'arrondi interne de Base UI tel
// quel : elle repasse par `valueToFraction` puis `sliderValue` (lib/studio/field-scrub.ts, Tâche 2) —
// les MÊMES fonctions pures que tout futur curseur de ce dépôt utilisera, pour que deux curseurs
// bornés au même min/max/step committent TOUJOURS la même valeur pour le même geste, sans dépendre
// d'un détail d'arrondi propre à la librairie tierce (demi-pair vs demi-supérieur, dérive flottante…).
//
// CORRECTIF REVUE (Important 1) — LA FRAPPE NUMÉRIQUE NE PASSE **PAS** PAR CE MÊME BORNAGE. Une
// première version faisait passer la frappe par LE MÊME `boundedFrom` que le glisser — donc par
// `max` — et taper « 500 » dans le flou d'ombre (schéma `min:0`, SANS PLAFOND) donnait `onCommit(100)`
// si le curseur affichait `max=100` : une RÉGRESSION réelle par rapport à l'ancien `NumberField`, qui
// laissait passer 500 tel quel (voir son `commit()` plus haut — aucun clamp, ni min ni max, c'est
// l'APPELANT/`patch` qui décide). `max` sur `SliderField` n'est qu'un plafond D'AFFICHAGE du curseur
// (voir les commentaires « plafond de curseur » dans property-panel.tsx) — jamais une borne du champ
// lui-même. La frappe ne clampe donc qu'à `min` (comme le ferait n'importe quel appelant qui écrit
// `Math.max(min, v)` dans son `onCommit`, ex. le flou/l'interligne) et laisse le PLAFOND, s'il y en a
// un de RÉEL (ex. l'opacité, où l'appelant applique `pct >= 100 ? undefined : …`), à la charge de
// l'appelant. Le GLISSER, lui, reste borné aux DEUX côtés : Base UI ne laisse de toute façon jamais le
// curseur sortir de `[min,max]`, donc `boundedFrom` n'y fait que RE-CONFIRMER une valeur déjà dans la
// plage (défensif, jamais un vrai plafonnement inattendu).
export function SliderField({
  label, value, min, max, step, onCommit, format, dataField, dataTestId,
}: {
  label: string; value: number; min: number; max: number;
  /** Défaut 1, même défaut que `Slider.Root` (Base UI) et que `NumberField`. */
  step?: number;
  onCommit: (v: number) => void;
  /** Formate la valeur affichée À CÔTÉ du curseur (ex. `v => \`${v} %\``) — l'`<input>` numérique,
   * lui, reste TOUJOURS un nombre nu : c'est la SAISIE précise, jamais une chaîne mise en forme qu'il
   * faudrait reparser. */
  format?: (v: number) => string;
  dataField?: string;
  /** Correctif revue (Important 2) — SURCHARGE le `data-testid` auto-dérivé de `dataField`
   * (`slider-${dataField}`). Nécessaire quand DEUX `SliderField` du panneau partagent le MÊME
   * `dataField` (ex. l'opacité : encore portée par la bande de géométrie épinglée,
   * `dataField="opacity"`, ET par ce nouveau curseur dans « Apparence ») — un test qui viserait
   * `[data-field="opacity"]` seul serait alors AMBIGU entre les deux. `property-panel.tsx#OpacityField`
   * passe `"appearance-opacity"` ici précisément pour ça ; l'`<input>` numérique reçoit
   * `${dataTestId}-input`, jamais le même testid que la racine du curseur. */
  dataTestId?: string;
}) {
  const strValue = Number.isFinite(value) ? String(value) : "0";
  const { local, setLocal, editing, setEditing } = useCommitBuffer(strValue);
  const displayValue = Number.isFinite(Number(local)) ? Number(local) : value;

  // GLISSER (`onValueCommitted`) — voir le commentaire d'en-tête : `raw` sort déjà de Base UI dans
  // `[min,max]` (le composant ne laisse jamais le curseur en sortir), `sliderValue`/`valueToFraction`
  // ne font donc que RE-CONFIRMER cette borne, jamais l'imposer de façon inattendue.
  function commitFromDrag(raw: number) {
    setEditing(false);
    const bounded = sliderValue(valueToFraction(raw, min, max), { min, max, step });
    if (bounded !== value) onCommit(bounded);
    else setLocal(strValue);
  }

  // FRAPPE NUMÉRIQUE — voir le commentaire d'en-tête : `min` reste appliqué (même filet que le
  // glisser à ce bord-là), mais `max` NE L'EST PAS — une saisie au-delà du plafond D'AFFICHAGE du
  // curseur (`max`) passe telle quelle, exactement comme l'ancien `NumberField` (aucun clamp d'aucun
  // bord, l'appelant/`patch` en décide). C'est le SEUL bornage que cette fonction applique — pas de
  // repassage par `sliderValue` (qui, lui, imposerait `max`).
  function commitFromInput() {
    const n = Number(local);
    if (!Number.isFinite(n)) { setEditing(false); setLocal(strValue); return; }
    setEditing(false);
    const bounded = Math.max(min, n);
    if (bounded !== value) onCommit(bounded);
    else setLocal(strValue);
  }

  const sliderTestId = dataTestId ?? (dataField ? `slider-${dataField}` : undefined);
  const inputTestId = dataTestId ? `${dataTestId}-input` : dataField ? `slider-input-${dataField}` : undefined;

  return (
    <FieldRow
      label={label}
      action={format ? (
        <span
          className="text-xs tabular-nums text-muted-foreground"
          data-testid={dataTestId ? `${dataTestId}-format` : dataField ? `slider-format-${dataField}` : undefined}
        >
          {format(displayValue)}
        </span>
      ) : undefined}
    >
      <div className="flex items-center gap-2">
        <Slider
          min={min}
          max={max}
          step={step}
          value={displayValue}
          data-field={dataField}
          data-testid={sliderTestId}
          // Live pendant le glisser : affichage local UNIQUEMENT (même rôle que
          // `onLabelPointerMove`/`setLocal` de `NumberField`) — jamais `onCommit` ici.
          onValueChange={(v) => { setEditing(true); setLocal(String(v as number)); }}
          // UNE fois, au relâchement — voir le commentaire d'en-tête de `SliderField` : c'est le SEUL
          // endroit où un glisser peut déclencher `onCommit`.
          onValueCommitted={(v) => commitFromDrag(v as number)}
        />
        <Input
          type="number"
          inputMode="decimal"
          step={step}
          min={min}
          className="w-16 shrink-0"
          value={local}
          data-field={dataField}
          data-testid={inputTestId}
          onFocus={() => setEditing(true)}
          // `onInput`, PAS `onChange` — même choix que color-picker.tsx#ColorField (le champ hex) et
          // pour la MÊME raison, vérifiée dans ce fichier plutôt que supposée : le `ChangeEventPlugin`
          // de React (node_modules/react-dom/cjs/react-dom-client.development.js) décide, à l'import
          // de `react-dom/client`, s'il peut s'appuyer sur l'événement natif "input"/"change"
          // (`isInputEventSupported`, calculé UNE FOIS via `canUseDOM`) — et tests/dom-harness.ts
          // importe `react-dom/client` en TÊTE de fichier, donc AVANT que `installDom()` ne pose
          // `window`/`document`. `isInputEventSupported` reste ainsi FAUX pour tout le process de
          // test, et React retombe alors sur le chemin de repli IE9 (`handleEventsForInputEventPolyfill`,
          // qui appelle `attachEvent` — une API IE, absente de jsdom) : AUCUN `onChange` React ne se
          // déclenche plus jamais sur un `<input>` texte/nombre sous ce harnais, quel que soit
          // l'événement DOM synthétisé. `onInput`, lui, est un simple relais du VRAI événement natif
          // "input" — jamais passé par ce mécanisme de repli — et reste donc fiable ici (vérifié en
          // instrumentant `react-dom-client.development.js`, voir tests/studio-slider-field.test.ts).
          onInput={(e) => setLocal(e.currentTarget.value)}
          onBlur={commitFromInput}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") { setLocal(strValue); setEditing(false); e.currentTarget.blur(); }
          }}
        />
      </div>
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
