"use client";

import type { Dispatch, ReactNode } from "react";
import { ChevronDown, Trash2, Plus, MousePointerSquareDashed } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { EmptyState } from "@/components/shell/empty-state";
import type { Layer, Scene, TextLayer, ImageLayer, ShapeLayer, QrLayer, Gradient } from "@/lib/studio/scene";
// Import de VALEUR (U3 Tâche 3) : la grammaire du rayon vit dans le schéma, et ce panneau la DEMANDE
// plutôt que d'en écrire une seconde qui pourrait dériver. scene.ts est un module de schéma pur : ses
// deux SEULS imports sont `zod` et sa locale française, donc il n'atteint ni `@/db` ni aucun code
// serveur — vérifiable en deux lignes en tête du fichier.
//
// CETTE LIGNE CITAIT tests/studio-no-r2.test.ts (revue de la Tâche 3, Medium 2). C'ÉTAIT FAUX : ce
// fichier teste les messages français de repli quand R2 n'est pas configuré, et ne dit RIEN des
// imports de valeur d'un composant client. AUCUN test de ce dépôt ne garde cette frontière : elle est
// tenue par la RELECTURE et par un traçage d'imports fait à la main à chaque tâche qui y touche (U2 a
// mesuré 31 chemins « client -> @/db » repo-wide, 7 dans le studio, 0 violation réelle ; la revue de
// cette tâche a retracé les cinq fichiers `"use client"` du studio et retrouvé 0 chemin). Le dire est
// utile ; le faire dire à un test qui ne le fait pas est pire que de ne rien citer — une fausse
// citation se relit comme une garantie. `bun run build` n'en est pas une non plus (contrainte
// explicite du plan U3).
import { formatRadius, parseRadiusInput } from "@/lib/studio/scene";
// U3 Tâche 3 : LA description d'une forme — celle que les deux chemins de rendu consultent. Ce panneau
// lui demande sa liste d'options et ses deux verdicts (le rayon a-t-il un sens ? la forme est-elle
// découpée ?) au lieu d'en tenir une seconde version.
import { descriptorFor, SHAPE_OPTIONS, supportsShadow } from "@/lib/studio/shapes";
import { type EditorAction, setLayerProp, singleSelectedId } from "@/lib/studio/editor-state";
import type { TemplateContext } from "@/lib/studio/tokens";
import type { AssetRow } from "@/lib/queries/assets";
import { TokenPicker, pickerRowsFor } from "./token-picker";
import { ColorPicker } from "./color-picker";
import { ImageAssetPicker, FontAssetPicker, pickImageAsset, pickFont } from "./asset-picker";
import { AlignRow, GeometryStrip } from "./geometry-strip";
import { alignParticipants } from "@/lib/studio/align";
import { FieldRow, NumberField, SelectField, SliderField, useCommitBuffer, type Patch } from "./property-fields";
// Chantier C, Tâche 5 — `opacityToPercent`/`percentToOpacity` (lib/studio/field-scrub.ts, Tâche 2) :
// le curseur d'opacité de CHAQUE section « Apparence » ci-dessous travaille en POURCENTS affichés
// (0–100), jamais en fraction brute (0–1) — plus lisible pour un designer qu'« opacité 0.42 ». Ces
// deux fonctions sont le SEUL point de conversion ; aucune arithmétique de pourcentage n'est
// recopiée à la main dans les quatre appels ci-dessous.
import { opacityToPercent, percentToOpacity } from "@/lib/studio/field-scrub";
// Chantier E, Tâche 5 — la convention d'icône PARTAGÉE (voir son en-tête) : appliquée ici aux deux
// icônes qui portent une VRAIE action (supprimer une étape de dégradé, en ajouter une) — pas au
// chevron de repli des sections (glyphe de DIVULGATION, pas d'action, déjà plus petit — 3.5 — pour
// rester discret sous un libellé text-xs) ni à l'icône de l'état vide de l'inspecteur
// (MousePointerSquareDashed, délibérément plus grande — 8 — pour porter seule un panneau vide).
import { STUDIO_ICON, STUDIO_ICON_STROKE } from "@/lib/studio/studio-icons";

// components/studio/property-panel.tsx — Tâche 8 : un formulaire PAR TYPE de calque, couvrant tous
// les champs que l'union Layer autorise (spec Tâche 8). Deux principes traversent tout ce fichier :
//
//  1. Chaque champ est TAMPONNÉ localement et ne committe qu'à la perte de focus (ou Entrée) — pas
//     à chaque frappe. Même raisonnement que components/studio/layer-panel.tsx:RenameField :
//     setLayerProp (lib/studio/editor-state.ts) empile une entrée d'historique à CHAQUE appel
//     réussi, donc committer à chaque caractère saperait « un geste = une entrée » (déjà appliqué
//     au glisser, Tâche 6). Le bloc de champs est en outre placé sous `key={layer.id}` (voir
//     PropertyPanel plus bas) : changer de calque sélectionné REMONTE tous les champs, qui repartent
//     donc d'un tampon propre — pas de valeur d'un calque qui fuiterait dans le tampon d'un autre.
//
//  2. `patch()` construit toujours l'objet imbriqué ENTIER (ex. `{ font: { ...layer.font, size } }`),
//     jamais un correctif partiel sur un sous-objet : editor-state.ts fusionne LayerPatch en
//     SUPERFICIEL (`{...layer, ...patch}`), donc un correctif `{ font: { size } }` remplacerait tout
//     `layer.font` par `{ size }` et perdrait family/weight — ce fichier ne fait jamais cette erreur.
//
//  3. Tâche 6 (U1, spec §6) : les six champs de cadre (X, Y, largeur, hauteur, rotation, opacité) ont
//     QUITTÉ ce fichier pour geometry-strip.tsx — une bande ÉPINGLÉE rendue avant le conteneur
//     défilant (`PropertyPanel` plus bas), plutôt qu'une section parmi d'autres fermant la liste
//     comme avant (le défaut que corrige cette tâche : nudger X forçait à défiler devant treize
//     autres contrôles). Les sections RESTANTES (Texte/Police/Apparence/Ombre/Contour, etc.) sont
//     repliables via `TypeSection`, mémorisées par type de calque (voir sa note).
export interface PropertyPanelProps {
  scene: Scene;
  /** Tâche 3 (U2, spec §3) — la sélection COMPLÈTE. Ce panneau n'a de sens que sur UN calque (chaque
   * champ édite une propriété d'un calque précis), donc il n'en rend les sections que pour une
   * sélection simple et affiche autrement un message qui dit la vérité — voir `PropertyPanel`. */
  selectedIds: string[];
  context: TemplateContext;
  dispatch: Dispatch<EditorAction>;
  // Tâche 13 (Lot 3) : la bibliothèque d'assets (Tâche 11), chargée UNE FOIS par le composant
  // Server au sommet (app/(app)/studio/[id]/page.tsx) et redescendue en prop — même schéma que
  // `context` ci-dessus, jamais rechargée depuis ce panneau lui-même. Défaut `[]` : les appelants
  // historiques (tests, Storybook éventuel) qui ne fournissent pas encore cette prop continuent de
  // rendre un panneau fonctionnel, simplement sans rien à choisir dans les sélecteurs d'assets.
  assets?: AssetRow[];
  // Tâche 6 (U1, spec §6) : état replié/déplié des sections, PAR TYPE de calque —
  // lib/studio/editor-prefs.ts#EditorPrefs.sectionsOpen, clé `${layerType}.${sectionId}`. Ce panneau
  // ne consomme QUE cette tranche de EditorPrefs, jamais l'objet entier (il resterait autrement
  // dépendant du zoom, du panneau de rail ouvert… autant de préférences qui ne le regardent pas).
  // Défaut `{}` (même défaut que EditorPrefs.sectionsOpen) : un appelant qui n'a pas encore ces
  // props (tests existants antérieurs à cette tâche) affiche toutes les sections OUVERTES, sans
  // pouvoir persister un repli — même filet que `assets` ci-dessus.
  sectionsOpen?: Record<string, boolean>;
  onSectionsOpenChange?: (next: Record<string, boolean>) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitives de champ — chacune tamponne localement, résout au blur/Entrée, et Échap annule.
// `FieldRow`/`useCommitBuffer`/`NumberField` vivent désormais dans property-fields.tsx (Correctif
// revue finale, Minor) — voir son commentaire d'en-tête pour la raison (cycle d'imports avec
// geometry-strip.tsx, désormais résolu).

function TextField({
  label, value, onCommit, action, multiline, placeholder, hint, dataField,
}: {
  label: string; value: string; onCommit: (v: string) => void; action?: ReactNode;
  multiline?: boolean; placeholder?: string; hint?: string; dataField?: string;
}) {
  const { local, setLocal, editing, setEditing } = useCommitBuffer(value);
  function commit() {
    setEditing(false);
    if (local !== value) onCommit(local);
  }
  const shared = {
    value: local,
    onFocus: () => setEditing(true),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setLocal(e.target.value),
    onBlur: commit,
    placeholder,
    "data-field": dataField,
  };
  return (
    <FieldRow label={label} action={action}>
      {multiline ? (
        <Textarea
          {...shared}
          rows={3}
          onKeyDown={(e) => { if (e.key === "Escape") { setLocal(value); setEditing(false); e.currentTarget.blur(); } }}
        />
      ) : (
        <Input
          {...shared}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") { setLocal(value); setEditing(false); e.currentTarget.blur(); }
          }}
        />
      )}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </FieldRow>
  );
}

// Une couleur de calque est TOUJOURS une valeur unique — hex, "transparent", ou un jeton entier
// (schema hexColor, lib/studio/scene.ts) — jamais un mélange : sélectionner un jeton REMPLACE donc
// tout le champ, contrairement au contenu texte (voir TextFields.content plus bas, où l'insertion
// se fait au contraire par CONCATÉNATION).
//
// Chantier C, Tâche 4 : le contrôle interne (pastille + `<Input>` hex nu) est REMPLACÉ par
// `<ColorPicker>` (components/studio/color-picker.tsx) — un carré SV/curseurs teinte-alpha/hex/
// pipette/nuancier/récents, PLUS un onglet « Jeton » qui reprend `pickerRowsFor` en interne. Le
// bouton `action` (`TokenPicker`, U4 Tâche 5) est VOLONTAIREMENT conservé tel quel plutôt que
// retiré : le brief de la Tâche 4 permet son retrait (« peut disparaître de l'action puisque
// l'onglet Jeton le remplace ») mais NE L'EXIGE PAS, et l'audit de couverture U4
// (tests/studio-property-panel.test.ts, `data-kind="color"`, un décompte par calque/champ) compte
// PRÉCISÉMENT sa présence sur chacun des dix appels de `ColorField` — le retirer romprait cet audit
// pour un gain d'affordance nul (l'onglet Jeton du nouveau sélecteur fait déjà strictement la même
// chose). Les deux chemins restent donc côte à côte, redondants mais tous deux fonctionnels — même
// contrat de liaison U4 qu'avant cette tâche.
function ColorField({
  label, value, context, onCommit, action = true, dataField,
}: {
  label: string; value: string; context: TemplateContext; onCommit: (v: string) => void;
  action?: boolean; dataField?: string;
}) {
  const { local, setLocal } = useCommitBuffer(value);
  return (
    <FieldRow
      label={label}
      action={action ? (
        <TokenPicker
          context={context}
          kind="color"
          title="Insérer une couleur de jeton"
          onPick={(t) => { const v = `{{${t}}}`; setLocal(v); onCommit(v); }}
        />
      ) : undefined}
    >
      <ColorPicker
        value={local}
        context={context}
        onCommit={(v) => { setLocal(v); onCommit(v); }}
        dataField={dataField}
      />
    </FieldRow>
  );
}

// Booléen : pas de tampon — un bascule est un geste unique, pas une frappe à amortir.
// ─────────────────────────────────────────────────────────────────────────────
// LE RAYON DES COINS (U3 Tâche 3, dette 1 du « PIÈGE POUR LA TÂCHE 3 »).
//
// Avant cette tâche, ce contrôle était un `NumberField` : il affichait `0` pour un rayon en CHAÎNE
// (« 50% », que le schéma accepte depuis la Tâche 2, arbitrage C) et l'ÉCRASAIT au premier commit.
// Inatteignable tant que `rect` était la seule forme ; vivant à l'instant où l'ellipse est livrée.
//
// `radiusPatch` est EXPORTÉE et pure — même idiome que elements-panel.tsx#insertShapeTile : ce dépôt
// n'a pas de DOM sous `bun test`, donc la seule façon de tester ce qu'un commit ÉCRIT est d'extraire
// la décision. Elle renvoie `null` pour « ne rien écrire » : saisie refusée (la valeur stockée
// survit — c'est la moitié « ne rien écraser » du correctif) ou valeur inchangée (pas d'entrée
// d'historique pour un aller-retour dans le champ).
export function radiusPatch(
  text: string,
  stored: number | string | undefined,
): Record<string, unknown> | null {
  const parsed = parseRadiusInput(text);
  if (parsed === null) return null;
  if (parsed === stored) return null;
  return { radius: parsed };
}

function RadiusField({ value, onCommit }: { value: number | string | undefined; onCommit: Patch }) {
  const shown = formatRadius(value);
  const { local, setLocal, editing, setEditing } = useCommitBuffer(shown);
  function commit() {
    setEditing(false);
    const p = radiusPatch(local, value);
    // Rien à écrire : on RENORMALISE l'affichage sur la valeur stockée. C'est ce qui fait revenir le
    // champ à « 50% » après une saisie refusée, au lieu de laisser un texte invalide à l'écran.
    if (!p) { setLocal(shown); return; }
    onCommit(p);
  }
  return (
    <FieldRow label="Rayon des coins">
      <Input
        value={local}
        inputMode="text"
        data-field="radius"
        placeholder="ex. 12 ou 50%"
        onFocus={() => setEditing(true)}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") { setLocal(shown); setEditing(false); e.currentTarget.blur(); }
        }}
      />
      {/* U3 Tâche 4 — LE RAYON PAR COIN EST DÉCOUVRABLE. Le modèle l'acceptait depuis la Tâche 2
          (« une à quatre longueurs », scene.ts#RADIUS_LENGTH_RE) et les deux chemins de rendu le
          transportaient déjà : il ne manquait QUE de le dire. Une capacité que rien n'annonce n'existe
          pas pour le designer. L'ORDRE des quatre coins n'est pas repris de la spécification CSS de
          mémoire : il est MESURÉ EN PIXELS à travers renderScene() (tests/studio-shape-render.test.ts,
          « le rayon PAR COIN ») — satori honore bien haut-gauche, haut-droit, bas-droit, bas-gauche,
          la forme à deux valeurs et les pourcentages. */}
      <p className="text-[11px] text-muted-foreground" data-testid="shape-radius-help">
        Un nombre de pixels (« 12 »), une longueur CSS (« 50% »), ou jusqu&rsquo;à quatre longueurs pour
        régler chaque coin séparément (« 8px 24px 8px 24px » : haut-gauche, haut-droit, bas-droit,
        bas-gauche). Vide pour aucun arrondi.
      </p>
    </FieldRow>
  );
}

function SwitchField({
  label, checked, onCommit, disabled, dataField,
}: {
  label: string; checked: boolean; onCommit: (v: boolean) => void;
  /** U3 Tâche 3 (revue, Medium 4) — grise l'interrupteur, et pas seulement visuellement. VÉRIFIÉ dans
   * la source du composant plutôt que supposé (node_modules/@base-ui/react/switch/root/SwitchRoot.js) :
   * `Switch.Root` ne rend PAS un `<button disabled>` mais un `<span role="switch">` portant
   * `aria-disabled="true"`, `data-disabled` et `tabindex="-1"` — son `onClick` commence par
   * `if (readOnly || disabled) return;` et l'`<input type="checkbox">` caché qu'il pilote porte, lui,
   * le `disabled` natif. Aucun clic ni aucune touche ne peut donc en sortir un changement. Un test qui
   * chercherait l'attribut `disabled` sur cet élément passerait donc toujours à côté : c'est
   * `aria-disabled` qu'il faut lire (voir tests/studio-property-panel.test.ts). */
  disabled?: boolean;
  /** Pose `data-field` sur l'interrupteur, pour qu'un test puisse lire SES attributs plutôt que de
   * chercher une sous-chaîne dans tout le HTML du panneau (leçon des pièges `disabled:` de U1/U2). */
  dataField?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Label className="text-xs font-normal text-muted-foreground">{label}</Label>
      <Switch checked={checked} disabled={disabled} data-field={dataField} onCheckedChange={(v) => onCommit(!!v)} />
    </div>
  );
}

// Chantier C, Tâche 5 — LE CURSEUR D'OPACITÉ, dans chaque section « Apparence » (texte/image/forme/
// QR). `layer.opacity` (`z.number().min(0).max(1).optional()`, lib/studio/scene.ts) portait déjà, à
// l'époque où cette fonction a été écrite, un contrôle NUMÉRIQUE brut (0–1, `dataField="opacity"`)
// dans la bande de géométrie ÉPINGLÉE (geometry-strip.tsx, à côté de X/Y/largeur/hauteur/rotation)
// depuis la Tâche 6 (U1) — la propriété n'était donc pas *inatteignable*, et ce curseur-ci n'était PAS
// un doublon inutile pour autant : il différait sur les deux points que ce chantier corrige
// précisément —
//   1. il affiche et édite un POURCENTAGE (0–100, `opacityToPercent`/`percentToOpacity`), l'unité que
//      lit un designer, plutôt que la fraction brute (0–1) qu'écrivait l'ancien contrôle de la bande ;
//   2. surtout, il respecte le §0 : à 100 %, `patch({ opacity: undefined })` efface la clé plutôt que
//      d'écrire `1` — un calque jamais touché ou ramené à pleine opacité RESTE sans `opacity` dans la
//      scène sérialisée (voir tests/studio-slider-field.test.ts, « round-trip 100 % »), CE QUE L'ANCIEN
//      contrôle de la bande, lui, ne respectait PAS (il écrivait TOUJOURS une valeur bornée, jamais
//      `undefined`).
//
// CORRECTIF D'INTÉGRATION (chantier C, Tâche 6 — revue C5) : l'ancien contrôle de la bande de
// géométrie a depuis été SUPPRIMÉ (voir le commentaire posé sur le `NumberField` « Rotation (°) »,
// geometry-strip.tsx) — le doublon que le point 2 ci-dessus documentait n'existe plus, et cette
// fonction est désormais le SEUL endroit du panneau qui lit/écrit `layer.opacity`. Le paragraphe
// ci-dessus reste néanmoins écrit à l'imparfait plutôt que réécrit au silence : il explique POURQUOI
// ce curseur a été ajouté alors qu'un contrôle existait déjà, une raison d'être que la suppression
// ultérieure du doublon ne rend pas caduque.
//
// EXPORTÉE + `dataTestId="appearance-opacity"` (correctif revue, Important 2, toujours vrai après la
// suppression ci-dessus) : `[data-field="opacity"]` reste le SEUL champ de tout le panneau à porter ce
// `data-field` désormais, mais `dataTestId` est conservé — retirer la surcharge romprait
// tests/studio-slider-field.test.ts et l'intégration §0 (tests/studio-inspector-integration.test.ts)
// sans aucun bénéfice. Exporter cette fonction permet à tests/studio-property-panel.test.ts de monter
// et committer à travers le VRAI `OpacityField` plutôt qu'une copie manuscrite de son `onCommit` qu'une
// régression ici pourrait laisser diverger sans qu'aucun test ne s'en aperçoive.
export function OpacityField({ layer, patch }: { layer: Layer; patch: Patch }) {
  return (
    <SliderField
      label="Opacité" dataField="opacity" dataTestId="appearance-opacity"
      value={opacityToPercent(layer.opacity ?? 1)} min={0} max={100} step={1}
      format={(v) => `${v} %`}
      onCommit={(pct) => patch({ opacity: pct >= 100 ? undefined : percentToOpacity(pct) })}
    />
  );
}

// Tâche 6 (U1, spec §6) : chaque section de champs restante (Texte/Police/Apparence/Ombre/Contour
// pour un texte ; Source/Apparence pour une image ; Remplissage/Forme/Bordure pour une forme ; QR
// code) devient REPLIABLE — seule « Cadre » a quitté ce mécanisme : ses six champs vivent désormais
// dans GeometryStrip (geometry-strip.tsx), épinglée hors du conteneur défilant par PropertyPanel
// plus bas. `Collapsible` vient de components/ui/collapsible.tsx (préréglage shadcn base-nova, Base
// UI) — jamais rechevauché à la main.
//
// L'état replié/déplié est mémorisé PAR TYPE de calque (clé `${layerType}.${sectionId}`,
// lib/studio/editor-prefs.ts#EditorPrefs.sectionsOpen) : un designer qui referme Ombre sur un calque
// TEXTE ne referme donc PAS Bordure sur un calque FORME, même si les deux sections partageaient le
// même libellé (ce qui arrive déjà ici : « Apparence » existe pour texte ET image, chacune sous sa
// propre clé `text.apparence` / `image.apparence`, sans jamais se recouvrir).
//
// `data-section={sectionId}` porte l'identifiant COURT (minuscule, sans le type) sur le `Collapsible`
// racine — Base UI y pose lui-même `data-open`/`data-closed` selon l'état courant (voir
// node_modules/@base-ui/react/utils/collapsibleOpenStateMapping.js), ce que
// tests/studio-property-panel.test.ts lit directement plutôt que de ré-implémenter sa propre
// convention d'attribut.
function TypeSection({
  title, sectionId, layerType, sectionsOpen, onToggleSection, children,
}: {
  title: string;
  sectionId: string;
  layerType: Layer["type"];
  sectionsOpen: Record<string, boolean>;
  onToggleSection: (key: string, open: boolean) => void;
  children: ReactNode;
}) {
  const key = `${layerType}.${sectionId}`;
  // Absente de la carte -> OUVERTE par défaut (même défaut que EditorPrefs.sectionsOpen = {}) :
  // une section jamais explicitement repliée par le designer reste visible dès le premier chargement.
  const open = sectionsOpen[key] ?? true;
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => onToggleSection(key, next)}
      data-section={sectionId}
      className="border-b pb-3 last:border-0"
    >
      {/* Chantier E Tâche 5 (finition de marque) : `font-heading` (l'éditoriale/Lora, globals.css)
          sur le TITRE de chaque section repliable de l'inspecteur — un « titre de panneau/section »
          au sens de la tâche, au même titre que le libellé de panel-host.tsx. */}
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-1 text-left font-heading text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 transition-transform group-data-panel-open:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2.5 pt-2.5">{children}</CollapsibleContent>
    </Collapsible>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
const FONT_WEIGHTS = [
  { value: "100", label: "100 — Fin" },
  { value: "200", label: "200 — Extra-léger" },
  { value: "300", label: "300 — Léger" },
  { value: "400", label: "400 — Normal" },
  { value: "500", label: "500 — Moyen" },
  { value: "600", label: "600 — Demi-gras" },
  { value: "700", label: "700 — Gras" },
  { value: "800", label: "800 — Extra-gras" },
  { value: "900", label: "900 — Noir" },
];
const ALIGN_OPTIONS = [{ value: "left", label: "Gauche" }, { value: "center", label: "Centre" }, { value: "right", label: "Droite" }];
const VALIGN_OPTIONS = [{ value: "top", label: "Haut" }, { value: "middle", label: "Milieu" }, { value: "bottom", label: "Bas" }];
const SIDE_LABEL: Record<"top" | "right" | "bottom" | "left", string> = { top: "Haut", right: "Droite", bottom: "Bas", left: "Gauche" };
const SIDES = ["top", "right", "bottom", "left"] as const;

function TextFields({
  layer, context, patch, assets, sectionsOpen, onToggleSection,
}: {
  layer: TextLayer; context: TemplateContext; patch: Patch; assets: AssetRow[];
  sectionsOpen: Record<string, boolean>; onToggleSection: (key: string, open: boolean) => void;
}) {
  const section = (sectionId: string, title: string, children: ReactNode) => (
    <TypeSection
      title={title} sectionId={sectionId} layerType="text"
      sectionsOpen={sectionsOpen} onToggleSection={onToggleSection}
    >
      {children}
    </TypeSection>
  );
  return (
    <>
      {section("texte", "Texte", (
        <TextField
          label="Contenu"
          value={layer.content}
          multiline
          dataField="content"
          onCommit={(v) => patch({ content: v })}
          action={
            <TokenPicker
              context={context}
              kind="text"
              title="Insérer un jeton dans le texte"
              // Le contenu texte peut MÉLANGER texte libre et jetons (ex. "Bonjour {{article.title}}",
              // extractTokens le scanne partout dans la chaîne — tokens.ts) : à la différence d'une
              // couleur, insérer un jeton ici CONCATÈNE plutôt que de remplacer tout le champ.
              onPick={(t) => patch({ content: `${layer.content}{{${t}}}` })}
            />
          }
        />
      ))}

      {section("police", "Police", (
        <>
          <FieldRow label="Police téléversée">
            {/* Tâche 13 : choisir parmi les polices téléversées (Tâche 11), la police embarquée
                (Noto Sans) restant toujours sélectionnable en premier — pickFont() écrit à la fois
                font.assetId ET font.family, donc le champ "Famille" juste en dessous reflète
                immédiatement le choix fait ici (et reste éditable à la main pour un ajustement fin). */}
            <FontAssetPicker
              assets={assets}
              value={layer.font.assetId}
              onPick={(pick) => patch({ font: pickFont(layer.font, pick) })}
            />
          </FieldRow>
          <TextField label="Famille" value={layer.font.family} onCommit={(v) => patch({ font: { ...layer.font, family: v } })} />
          <div className="grid grid-cols-2 gap-2">
            <NumberField label="Taille" value={layer.font.size} min={1} onCommit={(v) => patch({ font: { ...layer.font, size: Math.max(1, v) } })} />
            <SelectField
              label="Graisse"
              value={String(layer.font.weight)}
              options={FONT_WEIGHTS}
              onCommit={(v) => patch({ font: { ...layer.font, weight: Number(v) } })}
            />
          </div>
          <SwitchField label="Italique" checked={!!layer.font.italic} onCommit={(v) => patch({ font: { ...layer.font, italic: v } })} />
        </>
      ))}

      {section("apparence", "Apparence", (
        <>
          <OpacityField layer={layer} patch={patch} />
          <ColorField label="Couleur" value={layer.color} context={context} onCommit={(v) => patch({ color: v })} />
          <div className="grid grid-cols-2 gap-2">
            <SelectField label="Alignement" value={layer.align} options={ALIGN_OPTIONS} onCommit={(v) => patch({ align: v })} />
            <SelectField label="Alignement vertical" value={layer.vAlign} options={VALIGN_OPTIONS} onCommit={(v) => patch({ vAlign: v })} />
          </div>
          {/* Interligne : `min` de la scène (0.1, lib/studio/scene.ts) INCHANGÉ — seul le contrôle
              devient un combo curseur+numérique (Chantier C, Tâche 5). `max=3` n'est qu'un plafond de
              CURSEUR (correctif revue de la Tâche 5, Important 1 — voir le commentaire d'en-tête de
              `SliderField` sur `commitFromInput`) : le GLISSER seul y est borné des deux côtés
              (`sliderValue`/`valueToFraction`, lib/studio/field-scrub.ts) ; la FRAPPE numérique ne
              clampe qu'à `min` — taper « 5 » commit `lineHeight: 5`, pas `3`, exactement comme
              l'ancien `NumberField` sans `max` le laissait déjà passer. Accepté ici : un interligne de
              plus de 3× la taille de police n'a pas de cas d'usage identifié, et rien dans ce fichier
              ne pose de VRAI plafond au-delà de `min` sur ce champ. */}
          <div className="grid grid-cols-2 gap-2">
            <SliderField
              label="Interligne" dataField="line-height" value={layer.lineHeight} step={0.1} min={0.1} max={3}
              onCommit={(v) => patch({ lineHeight: Math.max(0.1, v) })}
            />
            <NumberField label="Espacement lettres" value={layer.letterSpacing ?? 0} onCommit={(v) => patch({ letterSpacing: v || undefined })} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Lignes max (0 = illimité)" value={layer.maxLines ?? 0} min={0} step={1}
              onCommit={(v) => patch({ maxLines: v > 0 ? Math.round(v) : undefined })}
            />
            <SwitchField label="Ajustement auto" checked={!!layer.autoFit} onCommit={(v) => patch({ autoFit: v })} />
          </div>
        </>
      ))}

      {section("ombre", "Ombre", (
        <>
          <SwitchField
            label="Activer l'ombre"
            checked={!!layer.shadow}
            onCommit={(v) => patch({ shadow: v ? { x: 0, y: 2, blur: 4, color: "#000000" } : undefined })}
          />
          {layer.shadow && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <NumberField label="X" value={layer.shadow.x} onCommit={(v) => patch({ shadow: { ...layer.shadow, x: v } })} />
                <NumberField label="Y" value={layer.shadow.y} onCommit={(v) => patch({ shadow: { ...layer.shadow, y: v } })} />
              </div>
              {/* Flou d'ombre : `min=0` INCHANGÉ (borne du schéma). `max=100` n'est qu'un plafond de
                  CURSEUR (correctif revue de la Tâche 5, Important 1 — voir le commentaire d'en-tête de
                  `SliderField` sur `commitFromInput`) : le GLISSER seul y est borné des deux côtés ; la
                  FRAPPE numérique ne clampe qu'à `min` — taper « 500 » commit `blur: 500`, pas `100`,
                  exactement comme l'ancien `NumberField` sans `max` le laissait déjà passer. Accepté ici
                  (Chantier C, Tâche 5) : un flou de plus de 100px sur un texte n'a pas de cas d'usage
                  identifié, et déplace le curseur hors de la plage utile du bloc-cousin (X/Y
                  typiquement à un chiffre ou deux) — mais rien ne l'empêche RÉELLEMENT au-delà de 0. */}
              <SliderField
                label="Flou" dataField="shadow-blur" value={layer.shadow.blur} min={0} max={100}
                onCommit={(v) => patch({ shadow: { ...layer.shadow, blur: Math.max(0, v) } })}
              />
              <ColorField
                label="Couleur de l'ombre" value={layer.shadow.color} context={context}
                onCommit={(v) => patch({ shadow: { ...layer.shadow, color: v } })}
              />
            </>
          )}
        </>
      ))}

      {section("contour", "Contour", (
        <>
          <SwitchField
            label="Activer le contour"
            checked={!!layer.stroke}
            onCommit={(v) => patch({ stroke: v ? { width: 1, color: "#000000" } : undefined })}
          />
          {layer.stroke && (
            <>
              <NumberField label="Épaisseur" value={layer.stroke.width} min={0.1} onCommit={(v) => patch({ stroke: { ...layer.stroke, width: Math.max(0.1, v) } })} />
              <ColorField
                label="Couleur du contour" value={layer.stroke.color} context={context}
                onCommit={(v) => patch({ stroke: { ...layer.stroke, color: v } })}
              />
            </>
          )}
        </>
      ))}
    </>
  );
}

function ImageFields({
  layer, context, patch, assets, sectionsOpen, onToggleSection,
}: {
  layer: ImageLayer; context: TemplateContext; patch: Patch; assets: AssetRow[];
  sectionsOpen: Record<string, boolean>; onToggleSection: (key: string, open: boolean) => void;
}) {
  const source = layer.source;
  // Tâche 5 (U4), coverage audit : `tokensFor` (FILTRE, jamais un rôle mais l'ANCIEN comportement de
  // ce sélecteur) faisait purement et simplement disparaître un jeton image illégal dans ce contexte
  // de la liste — le même défaut que celui corrigé sur TokenPicker, ici sur le sélecteur DÉDIÉ à
  // l'emplacement image plutôt que sur le bouton « insérer un jeton ». `pickerRowsFor` renvoie
  // l'univers COMPLET des jetons "image" : `imageRows` alimente le `<SelectField>` plus bas (options
  // ILLÉGALES grisées, avec leur raison), et `availableImageTokens` (le sous-ensemble légal) reste la
  // seule source pour un NOUVEAU choix par défaut (onValueChange ci-dessous) — jamais pour choisir un
  // jeton déjà réglé, qu'un calque existant garde tel quel même s'il devient illégal.
  const imageRows = pickerRowsFor(context, "image");
  const availableImageTokens = imageRows.filter((r) => r.available).map((r) => r.id);
  // Premier asset image disponible — sert de valeur de repli VALIDE au premier passage sur l'onglet
  // "Bibliothèque" (voir onValueChange ci-dessous, correctif Tâche 13).
  const firstImageAssetId = assets.find((a) => a.kind === "image")?.id;
  // Correctif Minor 4 (revue finale V2) : bibliothèque vide → PLUS de repli sur un identifiant
  // connu pour ne résoudre à rien ("bibliotheque-vide") — validateScene est pure et ne peut pas
  // détecter une référence d'asset pendante, donc un tel repli pouvait atteindre *publié* et faire
  // échouer TOUT rendu du gabarit. L'onglet est désactivé tant qu'aucune image n'est disponible ;
  // `source.kind === "asset"` reste autorisé pour PRÉSERVER un choix déjà valide (calque chargé
  // avec un assetId existant), jamais pour en fabriquer un nouveau à partir de rien.
  const canUseAssetTab = !!firstImageAssetId || source.kind === "asset";
  return (
    <>
      <TypeSection title="Source de l'image" sectionId="source" layerType="image" sectionsOpen={sectionsOpen} onToggleSection={onToggleSection}>
        <Tabs
          value={source.kind}
          onValueChange={(v) => {
            if (v === "slot") patch({ source: { kind: "slot", slot: availableImageTokens[0] ?? "article.image" } });
            // "https://" seul échoue z.string().url() (aucun hôte) — repéré en pilotant un vrai
            // navigateur : le premier clic sur l'onglet "URL" ne faisait STRICTEMENT rien à l'écran,
            // sans la moindre erreur console. lib/studio/editor-state.ts:commit() valide CHAQUE
            // correctif avec parseScene et rejette SILENCIEUSEMENT toute scène invalide (state
            // inchangé, même référence) — un rejet par conception, mais qui rendait ici l'onglet
            // entier inutilisable : `value={source.kind}` restait bloqué sur "slot" pour toujours,
            // le clic semblant chaque fois sans effet. Un exemple d'URL complet et valide dès le
            // premier passage évite ce piège.
            else if (v === "url") patch({ source: { kind: "url", url: source.kind === "url" ? source.url : "https://exemple.com/image.jpg" } });
            // Même piège, même correctif : assetId "" échoue z.string().min(1) — l'onglet
            // "Bibliothèque" (Tâche 13) était, lui aussi, silencieusement inutilisable au premier
            // clic. Repli sur le PREMIER asset image disponible (sélection immédiatement valide et
            // utile, pas un simple bouchon). Correctif Minor 4 : PLUS de repli sur un identifiant
            // connu pour ne résoudre à rien quand la bibliothèque est vide — ce cas n'atteint plus
            // cette branche du tout, l'onglet étant alors DÉSACTIVÉ ci-dessous (canUseAssetTab).
            else if (v === "asset" && canUseAssetTab) {
              patch({
                source: {
                  kind: "asset",
                  assetId: source.kind === "asset" ? source.assetId : firstImageAssetId!,
                },
              });
            }
          }}
        >
          <TabsList>
            <TabsTrigger value="slot" data-action="image-source-slot">Jeton</TabsTrigger>
            <TabsTrigger value="url" data-action="image-source-url">URL</TabsTrigger>
            <TabsTrigger value="asset" data-action="image-source-asset" disabled={!canUseAssetTab}>
              Bibliothèque
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {!canUseAssetTab && (
          <p className="text-[11px] text-muted-foreground">
            Aucune image dans la bibliothèque — téléversez-en une depuis Studio → Bibliothèque pour
            utiliser cette source.
          </p>
        )}

        {source.kind === "slot" && (
          // Tâche 5 (U4) : TOUS les jetons "image" du catalogue apparaissent désormais — ceux hors
          // CONTEXT_TOKENS[context] restent LISTÉS, grisés (SelectItem disabled -> aria-disabled, pas
          // l'attribut HTML `disabled`), avec leur raison en `hint` sous le contrôle. Chaque TokenKind
          // a au moins un jeton dans le catalogue (tokens.ts) : `imageRows` n'est donc jamais vide, et
          // le message de repli « aucun jeton disponible » (qui masquait plutôt qu'il n'expliquait)
          // disparaît avec le seul état qu'il servait à couvrir.
          <SelectField
            label="Emplacement (jeton image)"
            value={source.slot}
            options={imageRows.map((row) => ({ value: row.id, label: row.label, disabled: !row.available }))}
            hint={imageRows.find((row) => row.id === source.slot)?.reason}
            dataField="image-slot"
            onCommit={(v) => patch({ source: { kind: "slot", slot: v } })}
          />
        )}
        {source.kind === "url" && (
          <TextField label="URL de l'image" value={source.url} onCommit={(v) => patch({ source: { kind: "url", url: v } })} />
        )}
        {source.kind === "asset" && (
          <FieldRow label="Image de la bibliothèque">
            {/* Tâche 13 : la bibliothèque d'assets (Tâche 11) est désormais branchée — plus besoin
                de coller un identifiant à la main (ancien texte d'aide, retiré). */}
            <ImageAssetPicker
              assets={assets}
              value={source.assetId}
              onPick={(assetId) => patch({ source: pickImageAsset(assetId) })}
            />
          </FieldRow>
        )}
      </TypeSection>

      <TypeSection title="Apparence" sectionId="apparence" layerType="image" sectionsOpen={sectionsOpen} onToggleSection={onToggleSection}>
        <OpacityField layer={layer} patch={patch} />
        <SelectField
          label="Ajustement"
          value={layer.fit}
          options={[{ value: "cover", label: "Recadrer (cover)" }, { value: "contain", label: "Contenir (contain)" }]}
          onCommit={(v) => patch({ fit: v })}
        />
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="Rayon" value={layer.radius ?? 0} min={0} onCommit={(v) => patch({ radius: v || undefined })} />
          <NumberField label="Flou" value={layer.blur ?? 0} min={0} max={200} onCommit={(v) => patch({ blur: v || undefined })} />
        </div>
        <ColorField
          label="Voile (overlay)" value={layer.overlay ?? "transparent"} context={context}
          onCommit={(v) => patch({ overlay: v === "transparent" || v === "" ? undefined : v })}
        />
      </TypeSection>
    </>
  );
}

function replaceStop<T>(arr: readonly T[], i: number, v: T): T[] {
  const copy = arr.slice();
  copy[i] = v;
  return copy;
}

function GradientEditor({ gradient, context, onChange }: { gradient: Gradient; context: TemplateContext; onChange: (g: Gradient) => void }) {
  return (
    <div className="space-y-2">
      <NumberField label="Angle (°)" value={gradient.angle} onCommit={(v) => onChange({ ...gradient, angle: v })} />
      {gradient.stops.map((stop, i) => (
        <div key={i} className="flex items-end gap-1.5">
          <div className="flex-1">
            {/* Tâche 5 (U4), correctif de couverture : cette étape de dégradé N'AVAIT PAS de sélecteur
                de jeton (action={false}) avant cette tâche — pourtant `colorFieldsOf`
                (lib/studio/scene.ts) énumère bien `fill.stops.N.color` comme un champ-couleur LIABLE
                au même titre que n'importe quel autre (c'est lui que `usesInLayer`/`resolveTokens`
                consultent pour la substitution), donc l'omission privait spécifiquement CE champ-là
                de l'affordance « insérer un jeton » qu'offre chaque AUTRE champ couleur du panneau.
                Rien ne justifiait cette exception — `action` retrouve donc sa valeur par défaut
                (true), et un jeton couleur légal ici (ex. category.color) devient sélectionnable
                exactement comme sur un remplissage uni. */}
            <ColorField
              label={`Étape ${i + 1}`} value={stop.color} context={context}
              onCommit={(v) => onChange({ ...gradient, stops: replaceStop(gradient.stops, i, { ...stop, color: v }) })}
            />
          </div>
          <div className="w-20">
            <NumberField
              label="Position" value={stop.at} step={0.05} min={0} max={1}
              onCommit={(v) => onChange({ ...gradient, stops: replaceStop(gradient.stops, i, { ...stop, at: Math.min(1, Math.max(0, v)) }) })}
            />
          </div>
          <Button
            type="button" variant="ghost" size="icon-sm" aria-label="Supprimer l'étape"
            disabled={gradient.stops.length <= 2}
            onClick={() => onChange({ ...gradient, stops: gradient.stops.filter((_, j) => j !== i) })}
          >
            <Trash2 className={STUDIO_ICON} strokeWidth={STUDIO_ICON_STROKE} />
          </Button>
        </div>
      ))}
      <Button
        type="button" variant="outline" size="sm"
        onClick={() => onChange({ ...gradient, stops: [...gradient.stops, { color: "#FFFFFF", at: 1 }] })}
      >
        <Plus className={STUDIO_ICON} strokeWidth={STUDIO_ICON_STROKE} />Ajouter une étape
      </Button>
    </div>
  );
}

function ShapeFields({
  layer, context, patch, sectionsOpen, onToggleSection,
}: {
  layer: ShapeLayer; context: TemplateContext; patch: Patch;
  sectionsOpen: Record<string, boolean>; onToggleSection: (key: string, open: boolean) => void;
}) {
  const isGradient = typeof layer.fill !== "string";
  const sides = layer.border?.sides ?? SIDES;
  // LA description de la forme — la même que consultent les deux chemins de rendu. Ce panneau ne
  // décide rien lui-même sur la géométrie (U3 §0) : il demande, et affiche en conséquence.
  const descriptor = descriptorFor(layer.shape);
  return (
    <>
      <TypeSection title="Remplissage" sectionId="remplissage" layerType="shape" sectionsOpen={sectionsOpen} onToggleSection={onToggleSection}>
        {/* Une forme n'a pas de section « Apparence » à elle (Remplissage/Forme/Bordure/Ombre couvrent
            déjà tout son aspect visuel) — le curseur d'opacité rejoint donc « Remplissage », la
            section la plus proche de ce qu'« Apparence » nomme chez un texte ou une image (voir le
            commentaire d'en-tête d'`OpacityField`). */}
        <OpacityField layer={layer} patch={patch} />
        <Tabs
          value={isGradient ? "gradient" : "solid"}
          onValueChange={(v) => {
            if (v === "solid" && isGradient) patch({ fill: "#CCCCCC" });
            else if (v === "gradient" && !isGradient) {
              patch({ fill: { angle: 90, stops: [{ color: "#000000", at: 0 }, { color: "#FFFFFF", at: 1 }] } as Gradient });
            }
          }}
        >
          <TabsList>
            <TabsTrigger value="solid" data-action="fill-solid">Uni</TabsTrigger>
            <TabsTrigger value="gradient" data-action="fill-gradient">Dégradé</TabsTrigger>
          </TabsList>
        </Tabs>
        {!isGradient && (
          <ColorField label="Couleur" value={layer.fill as string} context={context} onCommit={(v) => patch({ fill: v })} />
        )}
        {isGradient && (
          <GradientEditor gradient={layer.fill as Gradient} context={context} onChange={(g) => patch({ fill: g })} />
        )}
      </TypeSection>

      <TypeSection title="Forme" sectionId="forme" layerType="shape" sectionsOpen={sectionsOpen} onToggleSection={onToggleSection}>
        {/* U3 Tâche 3 — CHANGER de forme sans supprimer/réinsérer le calque. shape-gallery.ts
            promettait déjà cette possibilité en commentaire (« un designer peut ensuite modifier sa
            forme … depuis le panneau de propriétés ») ; avec huit formes, l'absence de contrôle rendait
            la phrase fausse. Les options sont dérivées de SHAPE_KINDS (le schéma lui-même) et
            libellées par la DESCRIPTION de chaque forme — jamais une liste recopiée qui pourrait
            dériver, comme SHAPE_TILES le faisait avant la Tâche 2. */}
        <SelectField
          label="Forme"
          value={layer.shape}
          options={SHAPE_OPTIONS.map((o) => ({ value: o.value as string, label: o.label }))}
          optionDataAttr="data-shape-option"
          onCommit={(v) => patch({ shape: v })}
          // Chantier D, Tâche 4 — GeometryStrip porte désormais SES PROPRES `<Select>` (les menus H/V
          // du widget de contraintes, `data-field="constraints.h"`/`"constraints.v"`), rendus AVANT
          // cette section dans le panneau. Sans `dataField` ici, un extracteur qui cherchait
          // « le seul `role="combobox"` du panneau » (tests/studio-property-panel.test.ts) n'aurait
          // plus visé sans ambiguïté CE sélecteur-ci.
          dataField="shape"
        />
        {/* Le rayon N'EST OFFERT que là où il veut dire quelque chose (lib/studio/shapes.ts,
            `radiusApplies`) : sur une ellipse il la transformerait en stade, sur une forme découpée il
            arrondirait les coins du CADRE et pas les sommets du polygone — « aucun effet » pour une
            étoile, « rabote la base » pour un triangle. Le brief demande qu'il soit IGNORÉ, pas mal
            appliqué : le champ disparaît donc derrière une note qui dit pourquoi, et RIEN n'est écrit
            (un rayon déjà stocké survit intact et réapparaît si la forme redevient un rectangle). */}
        {descriptor.radiusApplies ? (
          <RadiusField value={layer.radius} onCommit={patch} />
        ) : (
          <p className="text-[11px] text-muted-foreground" data-testid="shape-radius-ignored">
            Le rayon des coins ne s&rsquo;applique pas à la forme «&nbsp;{descriptor.label}&nbsp;» :
            {descriptor.clipped
              ? " un découpage arrondirait les coins du cadre, pas les sommets de la forme."
              : " sa géométrie EST un arrondi (« border-radius: 50% »), qu'un rayon en pixels remplacerait par un stade."}
            {" "}Il reste conservé tel quel si vous revenez à un rectangle.
          </p>
        )}
      </TypeSection>

      <TypeSection title="Bordure" sectionId="bordure" layerType="shape" sectionsOpen={sectionsOpen} onToggleSection={onToggleSection}>
        {/* U3 Tâche 3, REVUE (Medium 4) — RÉSERVE 3 DE LA SONDE, TRANCHÉE ICI PLUTÔT QUE REPORTÉE.
            La bordure ÉCHAPPE au découpage dans satori (contour rectangulaire autour d'un remplissage
            triangulaire) et pas dans le navigateur (qui clippe l'élément entier, bordure comprise) :
            l'offrir sur une forme découpée, c'est offrir un contrôle dont le résultat DIFFÈRE entre
            l'éditeur et l'image livrée — le §0 de ce sous-projet. L'arbitrage F l'avait reporté à la
            Tâche 4 au motif qu'aucune forme n'en porte par défaut ; c'est vrai de l'INSERTION, mais
            cette tâche a livré le sélecteur de forme, donc « rectangle bordé » -> « Triangle » se fait
            en deux clics. Le contrôle est donc grisé, avec sa note — et la bordure est ÉGALEMENT
            supprimée des deux chemins de rendu (lib/studio/shapes.ts#layerBorder), sans quoi un
            `border` déjà stocké continuerait de diverger et la note serait fausse : exactement ce que
            la Tâche 3 avait dû faire pour la rotation. Piloté par `descriptor.clipped`, jamais par une
            liste de noms. */}
        <SwitchField
          label="Activer la bordure"
          checked={!!layer.border}
          disabled={descriptor.clipped}
          dataField="border-enabled"
          onCommit={(v) => patch({ border: v ? { width: 2, color: "#000000", sides: [...SIDES] } : undefined })}
        />
        {descriptor.clipped && (
          <p className="text-[11px] text-muted-foreground" data-testid="shape-border-none">
            La bordure n&rsquo;est pas disponible sur la forme «&nbsp;{descriptor.label}&nbsp;» : le
            moteur d&rsquo;export laisserait le contour RECTANGULAIRE autour du remplissage découpé,
            alors que le navigateur le découperait comme le reste — l&rsquo;écran et l&rsquo;image
            livrée ne montreraient pas la même chose. Elle n&rsquo;est donc peinte nulle part ici, et
            une bordure déjà réglée reste conservée telle quelle si vous revenez à un rectangle.
          </p>
        )}
        {!descriptor.clipped && layer.border && (
          <>
            <NumberField
              label="Épaisseur" value={layer.border.width} min={0.1}
              onCommit={(v) => patch({ border: { ...layer.border, width: Math.max(0.1, v) } })}
            />
            <ColorField
              label="Couleur" value={layer.border.color} context={context}
              onCommit={(v) => patch({ border: { ...layer.border, color: v } })}
            />
            <div className="grid grid-cols-2 gap-1.5">
              {SIDES.map((side) => (
                <SwitchField
                  key={side}
                  label={SIDE_LABEL[side]}
                  checked={sides.includes(side)}
                  onCommit={(checked) => {
                    const next = checked ? [...sides, side] : sides.filter((s) => s !== side);
                    patch({ border: { ...layer.border, sides: next } });
                  }}
                />
              ))}
            </div>
          </>
        )}
      </TypeSection>

      <TypeSection title="Ombre" sectionId="ombre" layerType="shape" sectionsOpen={sectionsOpen} onToggleSection={onToggleSection}>
        {/* U3 Tâche 4 — L'OMBRE PORTÉE D'UNE FORME, et le cas des formes découpées.
            MESURÉ EN PIXELS AVANT D'ÉCRIRE CE CONTRÔLE (tests/studio-render-clippath.test.ts,
            « RÉSERVE 4 ») : sur une forme découpée, satori ne peint AUCUNE ombre, et le navigateur non
            plus — `clip-path` découpe le rendu ENTIER d'un élément, ombre portée comprise. Offrir le
            contrôle là serait offrir un contrôle sans effet : le défaut que U2 a tranché deux fois
            (`snap-rotation-note`, `safe-areas-none`) et la Tâche 3 deux fois de plus. Il est donc grisé
            avec sa note — ET l'ombre est supprimée des DEUX chemins de rendu
            (lib/studio/shapes.ts#layerBoxShadow), pour que l'accord entre l'écran et l'export soit
            structurel plutôt qu'un accident d'implémentation de satori qu'un correctif amont pourrait
            défaire. Sur les formes non découpées, l'ombre SUIT le `border-radius` dans les deux moteurs
            (mesuré) : une ellipse ombrée est une ellipse ombrée. Piloté par la description, jamais par
            une liste de noms. Mêmes quatre champs que l'ombre d'un texte, puisque c'est le même réglage
            et — depuis cette tâche — la même définition de schéma. */}
        <SwitchField
          label="Activer l'ombre"
          checked={!!layer.shadow}
          disabled={!supportsShadow(layer.shape)}
          dataField="shadow-enabled"
          onCommit={(v) => patch({ shadow: v ? { x: 0, y: 2, blur: 4, color: "#000000" } : undefined })}
        />
        {!supportsShadow(layer.shape) && (
          <p className="text-[11px] text-muted-foreground" data-testid="shape-shadow-none">
            L&rsquo;ombre n&rsquo;est pas disponible sur la forme «&nbsp;{descriptor.label}&nbsp;» : une
            ombre portée se peint AUTOUR de la boîte du calque, et une forme découpée n&rsquo;en montre
            rien — ni sur le canevas, ni dans l&rsquo;image exportée. Vérifié en pixels sur les deux.
            Elle n&rsquo;est donc peinte nulle part ici, et une ombre déjà réglée reste conservée telle
            quelle si vous revenez à une forme pleine.
          </p>
        )}
        {supportsShadow(layer.shape) && layer.shadow && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <NumberField label="X" value={layer.shadow.x} onCommit={(v) => patch({ shadow: { ...layer.shadow, x: v } })} />
              <NumberField label="Y" value={layer.shadow.y} onCommit={(v) => patch({ shadow: { ...layer.shadow, y: v } })} />
            </div>
            {/* Même plafond de curseur (100) et même raisonnement que le « Flou » d'ombre d'un texte
                — voir son commentaire (section « Ombre » de `TextFields` ci-dessus). */}
            <SliderField
              label="Flou" dataField="shadow-blur" value={layer.shadow.blur} min={0} max={100}
              onCommit={(v) => patch({ shadow: { ...layer.shadow, blur: Math.max(0, v) } })}
            />
            <ColorField
              label="Couleur de l'ombre" value={layer.shadow.color} context={context}
              onCommit={(v) => patch({ shadow: { ...layer.shadow, color: v } })}
            />
          </>
        )}
      </TypeSection>
    </>
  );
}

function QrFields({
  layer, context, patch, sectionsOpen, onToggleSection,
}: {
  layer: QrLayer; context: TemplateContext; patch: Patch;
  sectionsOpen: Record<string, boolean>; onToggleSection: (key: string, open: boolean) => void;
}) {
  // Tâche 5 (U4), coverage audit : même correctif que ImageFields — `article.url` est le SEUL jeton
  // "url" du catalogue entier (tokens.ts) ; il n'était légal QUE pour social_post (la règle V1 :
  // article.url n'existe qu'APRÈS publication WordPress). Avant cette tâche, les quatre AUTRES
  // contextes ne voyaient qu'un message d'absence — jamais le jeton lui-même, ni pourquoi il ne
  // s'applique pas ici. `urlRows` n'est jamais vide (au moins ce jeton existe toujours) : le
  // sélecteur s'affiche donc dans TOUS les contextes, avec le jeton grisé + sa raison en `hint` là où
  // il ne s'applique pas.
  const urlRows = pickerRowsFor(context, "url");
  return (
    <TypeSection title="QR code" sectionId="qrcode" layerType="qr" sectionsOpen={sectionsOpen} onToggleSection={onToggleSection}>
      {/* Un calque QR ne porte qu'UNE section — le curseur d'opacité y rejoint donc les autres
          réglages visuels plutôt que d'ouvrir une section « Apparence » à lui seul (hors périmètre de
          cette tâche : voir le commentaire d'en-tête d'`OpacityField`). */}
      <OpacityField layer={layer} patch={patch} />
      <SelectField
        label="Emplacement (jeton URL)"
        value={layer.slot}
        options={urlRows.map((row) => ({ value: row.id, label: row.label, disabled: !row.available }))}
        hint={urlRows.find((row) => row.id === layer.slot)?.reason}
        dataField="qr-slot"
        onCommit={(v) => patch({ slot: v })}
      />
      <ColorField label="Couleur (premier plan)" value={layer.fg} context={context} onCommit={(v) => patch({ fg: v })} />
      <ColorField label="Couleur de fond" value={layer.bg} context={context} onCommit={(v) => patch({ bg: v })} />
      <NumberField label="Marge" value={layer.margin} min={0} step={1} onCommit={(v) => patch({ margin: Math.max(0, Math.round(v)) })} />
    </TypeSection>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
export function PropertyPanel({
  scene, selectedIds, context, dispatch, assets = [], sectionsOpen = {}, onSectionsOpenChange = () => {},
}: PropertyPanelProps) {
  // `singleSelectedId` et non `selectedIds[0]` : pour une sélection multiple, il n'y a PAS de calque
  // à éditer ici, et prendre le premier afficherait ses propriétés comme si elles valaient pour les
  // trois — voir sa documentation dans lib/studio/editor-state.ts.
  const layer = scene.layers.find((l) => l.id === singleSelectedId(selectedIds)) ?? null;

  // Sélection MULTIPLE (Tâche 3, U2, spec §3) — avant l'état vide, car une sélection multiple n'est
  // PAS « rien de sélectionné » et le dire ainsi serait mentir à l'utilisateur. Message honnête : il
  // annonce le compte réel et pourquoi les sections n'apparaissent pas, plutôt que de laisser croire
  // à une panne. La bande de géométrie n'est pas rendue non plus (elle édite UN cadre).
  //
  // Tâche 4 (U2, spec §4) : la rangée aligner/répartir, elle, a tout son sens ici — c'est même son cas
  // d'usage principal. Elle est donc rendue AU-DESSUS du message, jamais dans une bande de géométrie
  // (qui reste réservée à l'édition d'un cadre unique).
  if (selectedIds.length > 1) {
    return (
      <div className="flex h-full flex-col">
        <AlignRow scene={scene} selectedIds={selectedIds} dispatch={dispatch} className="border-b p-3" />
        <div
          className="flex flex-1 items-center justify-center p-4 text-center text-xs text-muted-foreground"
          data-testid="property-panel-multi"
        >
          {/* La seconde moitié de la phrase dépend des PARTICIPANTS, pas de `selectedIds` : avec une
              sélection entièrement verrouillée (sélectionner trois calques puis les verrouiller — le
              verrou ne vide pas la sélection), toute la rangée est désactivée, et promettre qu'elle
              « les aligne toutes » serait faux (revue Tâche 4, Mineur 4). */}
          {selectedIds.length} calques sélectionnés — les propriétés d&rsquo;un calque ne s&rsquo;affichent
          que pour une sélection unique
          {alignParticipants(scene.layers, selectedIds).length > 1
            ? ", mais la rangée ci-dessus les aligne et les répartit."
            : " — et la rangée ci-dessus est inactive, car aligner demande au moins deux calques déverrouillés."}
        </div>
      </div>
    );
  }

  // Chantier A Tâche 3 (spec §2/§3) — état vide COMPACT. AVANT cette tâche, ce message occupait tout
  // `h-full` de la colonne inspecteur via `items-center justify-center` : sur une colonne de 300px de
  // haut (toute la hauteur de l'éditeur), une phrase de neuf mots flottait seule au centre d'un vide
  // — le défaut explicitement nommé par le brief (« a 300px full-height void »). Le message devient
  // ici une PETITE carte discrète, ANCRÉE en haut (`items-start` — pas de `justify-center` vertical),
  // dans une largeur bornée (`max-w-[220px]`) plutôt qu'étirée sur toute la colonne : elle se lit
  // comme un indice ponctuel, pas comme l'unique occupant d'un panneau entier. Même texte, même
  // `data-testid="property-panel-empty"` (verrouillé par tests/studio-editor-shell.test.ts et
  // tests/studio-property-panel.test.ts) — seule la STRUCTURE change, jamais le message ni son
  // adressage pour un test existant.
  //
  // Chantier E Tâche 3 : la carte ad-hoc ci-dessus est remplacée par la primitive PARTAGÉE
  // `EmptyState` (components/shell/empty-state.tsx) — même carte à bordure pointillée que les autres
  // états vides du produit (feeds/members/taxonomy/runs). Les DEUX `data-testid` verrouillés sont
  // préservés en ENVELOPPANT : le testid extérieur reste sur le conteneur (comme avant), et le testid
  // du hint est posé sur un `<span>` passé comme `hint` d'EmptyState (son prop `hint` a été élargi de
  // `string` à `ReactNode` — voir components/shell/empty-state.tsx — un élargissement rétrocompatible
  // qui ne change rien pour ses autres appelants).
  if (!layer) {
    return (
      <div className="flex h-full flex-col items-center p-3" data-testid="property-panel-empty">
        <div className="w-full max-w-[220px]">
          <EmptyState
            icon={<MousePointerSquareDashed className="size-8 text-muted-foreground" aria-hidden />}
            title="Aucun calque sélectionné"
            titleClassName="font-heading"
            hint={
              <span data-testid="property-panel-empty-hint">
                Sélectionnez un calque pour modifier ses propriétés.
              </span>
            }
          />
        </div>
      </div>
    );
  }

  const patch: Patch = (p) => dispatch(setLayerProp(layer.id, p));
  // Bascule PURE : ne touche JAMAIS `scene`/`dispatch` — replier une section est un changement
  // d'affichage, pas une mutation de calque. tests/studio-property-panel.test.ts le vérifie
  // directement (aucun appel à dispatch pendant un rendu, quel que soit l'état replié/déplié).
  function onToggleSection(key: string, open: boolean) {
    onSectionsOpenChange({ ...sectionsOpen, [key]: open });
  }

  return (
    // key={layer.id} : REMONTE tout le sous-arbre de champs à chaque changement de sélection — voir
    // la note en tête de fichier, point 1. C'est ce qui évite qu'un tampon local (useCommitBuffer)
    // affiche encore la valeur d'un calque après avoir sélectionné le suivant.
    //
    // Tâche 6 (U1, spec §6) : ce conteneur racine ne porte PLUS `overflow-auto` lui-même — GeometryStrip
    // (les six champs de cadre, ex-section « Cadre ») est un FRÈRE placé AVANT le conteneur défilant
    // ci-dessous (`data-testid="property-sections"`, seul à porter `overflow-auto`), jamais un
    // descendant : elle ne peut donc structurellement pas défiler avec le reste. C'est précisément ce
    // que vérifie tests/studio-property-panel.test.ts en comparant les POSITIONS des deux
    // `data-testid` dans le HTML sérialisé (rien de plus : `renderToStaticMarkup` ne rend aucune boîte
    // ni aucun `overflow` réel, voir le rapport de tâche pour la portée exacte de cette preuve).
    <div className="flex h-full flex-col" data-testid="property-panel" key={layer.id}>
      <GeometryStrip layer={layer} patch={patch} scene={scene} selectedIds={selectedIds} dispatch={dispatch} />

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto p-3" data-testid="property-sections">
        {layer.type === "text" && (
          <TextFields layer={layer} context={context} patch={patch} assets={assets} sectionsOpen={sectionsOpen} onToggleSection={onToggleSection} />
        )}
        {layer.type === "image" && (
          <ImageFields layer={layer} context={context} patch={patch} assets={assets} sectionsOpen={sectionsOpen} onToggleSection={onToggleSection} />
        )}
        {layer.type === "shape" && (
          <ShapeFields layer={layer} context={context} patch={patch} sectionsOpen={sectionsOpen} onToggleSection={onToggleSection} />
        )}
        {layer.type === "qr" && (
          <QrFields layer={layer} context={context} patch={patch} sectionsOpen={sectionsOpen} onToggleSection={onToggleSection} />
        )}
      </div>
    </div>
  );
}
