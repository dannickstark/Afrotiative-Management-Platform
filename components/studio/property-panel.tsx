"use client";

import type { Dispatch, ReactNode } from "react";
import { ChevronDown, Trash2, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { Layer, Scene, TextLayer, ImageLayer, ShapeLayer, QrLayer, Gradient } from "@/lib/studio/scene";
// Import de VALEUR (U3 Tâche 3) : la grammaire du rayon vit dans le schéma, et ce panneau la DEMANDE
// plutôt que d'en écrire une seconde qui pourrait dériver. scene.ts est un module de schéma pur (zod)
// — il n'atteint ni `@/db` ni aucun code serveur, contrainte vérifiée par tests/studio-no-r2.test.ts
// et par le traçage d'imports de valeur du rapport de tâche.
import { formatRadius, parseRadiusInput } from "@/lib/studio/scene";
import { type EditorAction, setLayerProp, singleSelectedId } from "@/lib/studio/editor-state";
import type { TemplateContext } from "@/lib/studio/tokens";
import type { AssetRow } from "@/lib/queries/assets";
import { TokenPicker, tokensFor, TOKEN_LABELS } from "./token-picker";
import { ImageAssetPicker, FontAssetPicker, pickImageAsset, pickFont } from "./asset-picker";
import { AlignRow, GeometryStrip } from "./geometry-strip";
import { alignParticipants } from "@/lib/studio/align";
import { FieldRow, NumberField, useCommitBuffer, type Patch } from "./property-fields";

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
function ColorField({
  label, value, context, onCommit, action = true, dataField,
}: {
  label: string; value: string; context: TemplateContext; onCommit: (v: string) => void;
  action?: boolean; dataField?: string;
}) {
  const { local, setLocal, editing, setEditing } = useCommitBuffer(value);
  function commit() {
    setEditing(false);
    if (local !== value) onCommit(local);
  }
  const isToken = local.startsWith("{{");
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
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="size-6 shrink-0 rounded border border-input"
          style={
            isToken || local === "transparent" || local === ""
              ? { background: "repeating-linear-gradient(45deg, #999 0, #999 3px, #ccc 3px, #ccc 6px)" }
              : { backgroundColor: local }
          }
        />
        <Input
          value={local}
          data-field={dataField}
          onFocus={() => setEditing(true)}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") { setLocal(value); setEditing(false); e.currentTarget.blur(); }
          }}
          placeholder="#RRGGBB"
        />
      </div>
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
      <p className="text-[11px] text-muted-foreground">
        Un nombre de pixels (« 12 ») ou une longueur CSS (« 50% ») — vide pour aucun arrondi.
      </p>
    </FieldRow>
  );
}

function SwitchField({ label, checked, onCommit }: { label: string; checked: boolean; onCommit: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Label className="text-xs font-normal text-muted-foreground">{label}</Label>
      <Switch checked={checked} onCheckedChange={(v) => onCommit(!!v)} />
    </div>
  );
}

function SelectField({
  label, value, options, onCommit, placeholder,
}: {
  label: string; value: string; options: { value: string; label: string }[]; onCommit: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <FieldRow label={label}>
      <Select value={value} onValueChange={(v) => { if (v) onCommit(v); }}>
        <SelectTrigger className="w-full">
          {/* Base UI's <SelectValue> ne dérive PAS automatiquement le libellé du <SelectItem>
              correspondant (contrairement à un <select> natif) — repéré en vérifiant l'écran réel
              dans un navigateur : sans ce mappeur explicite, chaque sélecteur de ce panneau
              (alignement, graisse de police, ajustement d'image…) affichait sa valeur technique
              brute ("left", "700"…) au lieu de son libellé français — même piège déjà corrigé dans
              components/studio/preview-pane.tsx, voir sa note. */}
          <SelectValue placeholder={placeholder ?? "Choisir…"}>
            {(v: string | null) => options.find((o) => o.value === v)?.label ?? placeholder ?? "Choisir…"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </FieldRow>
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
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-1 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase">
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
          <ColorField label="Couleur" value={layer.color} context={context} onCommit={(v) => patch({ color: v })} />
          <div className="grid grid-cols-2 gap-2">
            <SelectField label="Alignement" value={layer.align} options={ALIGN_OPTIONS} onCommit={(v) => patch({ align: v })} />
            <SelectField label="Alignement vertical" value={layer.vAlign} options={VALIGN_OPTIONS} onCommit={(v) => patch({ vAlign: v })} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Interligne" value={layer.lineHeight} step={0.1} min={0.1}
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
              <div className="grid grid-cols-3 gap-2">
                <NumberField label="X" value={layer.shadow.x} onCommit={(v) => patch({ shadow: { ...layer.shadow, x: v } })} />
                <NumberField label="Y" value={layer.shadow.y} onCommit={(v) => patch({ shadow: { ...layer.shadow, y: v } })} />
                <NumberField label="Flou" value={layer.shadow.blur} min={0} onCommit={(v) => patch({ shadow: { ...layer.shadow, blur: Math.max(0, v) } })} />
              </div>
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
  const imageTokens = tokensFor(context, "image");
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
            if (v === "slot") patch({ source: { kind: "slot", slot: imageTokens[0] ?? "article.image" } });
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
          imageTokens.length > 0 ? (
            <SelectField
              label="Emplacement (jeton image)"
              value={source.slot}
              options={imageTokens.map((id) => ({ value: id, label: TOKEN_LABELS[id] }))}
              onCommit={(v) => patch({ source: { kind: "slot", slot: v } })}
            />
          ) : (
            <p className="text-[11px] text-muted-foreground">Aucun jeton image disponible dans ce contexte.</p>
          )
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
            <ColorField
              label={`Étape ${i + 1}`} value={stop.color} context={context} action={false}
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
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button
        type="button" variant="outline" size="sm"
        onClick={() => onChange({ ...gradient, stops: [...gradient.stops, { color: "#FFFFFF", at: 1 }] })}
      >
        <Plus />Ajouter une étape
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
  return (
    <>
      <TypeSection title="Remplissage" sectionId="remplissage" layerType="shape" sectionsOpen={sectionsOpen} onToggleSection={onToggleSection}>
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
        <RadiusField value={layer.radius} onCommit={patch} />
      </TypeSection>

      <TypeSection title="Bordure" sectionId="bordure" layerType="shape" sectionsOpen={sectionsOpen} onToggleSection={onToggleSection}>
        <SwitchField
          label="Activer la bordure"
          checked={!!layer.border}
          onCommit={(v) => patch({ border: v ? { width: 2, color: "#000000", sides: [...SIDES] } : undefined })}
        />
        {layer.border && (
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
    </>
  );
}

function QrFields({
  layer, context, patch, sectionsOpen, onToggleSection,
}: {
  layer: QrLayer; context: TemplateContext; patch: Patch;
  sectionsOpen: Record<string, boolean>; onToggleSection: (key: string, open: boolean) => void;
}) {
  const urlTokens = tokensFor(context, "url");
  return (
    <TypeSection title="QR code" sectionId="qrcode" layerType="qr" sectionsOpen={sectionsOpen} onToggleSection={onToggleSection}>
      {urlTokens.length > 0 ? (
        <SelectField
          label="Emplacement (jeton URL)"
          value={layer.slot}
          options={urlTokens.map((id) => ({ value: id, label: TOKEN_LABELS[id] }))}
          onCommit={(v) => patch({ slot: v })}
        />
      ) : (
        <p className="text-[11px] text-muted-foreground">Aucun jeton URL disponible dans ce contexte — un QR code n&rsquo;y a rien à encoder.</p>
      )}
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

  if (!layer) {
    return (
      <div
        className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground"
        data-testid="property-panel-empty"
      >
        Sélectionnez un calque pour modifier ses propriétés.
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
